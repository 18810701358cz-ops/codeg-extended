//! Resolve the official ZCode runtime separately from the npm ACP bridge.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct ZCodeRuntime {
    pub cli: PathBuf,
    pub node: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("Official ZCode CLI could not be found. Install ZCode and sign in, or set ZCODE_BIN to its zcode.cjs entry in Agent Settings.")]
    CliMissing,
    #[error("ZCODE_BIN does not resolve to a supported ZCode entry: {0}. Use zcode.cjs, zcode.mjs, or a native executable.")]
    CliInvalid(String),
    #[error("Node.js could not be found. Install Node.js 22 or newer, or set ZCODE_NODE in Agent Settings.")]
    NodeMissing,
    #[error("ZCODE_NODE does not resolve to a Node executable: {0}")]
    NodeInvalid(String),
    #[error("The ZCode Node runtime must be Node.js 22 or newer with node:sqlite available. Check ZCODE_NODE in Agent Settings.")]
    NodeUnsupported,
}

impl ZCodeRuntime {
    pub fn apply(&self, env: &mut Vec<(String, String)>) {
        for (key, value) in [
            ("ZCODE_BIN", self.cli.to_string_lossy().into_owned()),
            ("ZCODE_NODE", self.node.to_string_lossy().into_owned()),
            ("ZCODE_ACP_REMOTE", "0".to_string()),
        ] {
            env.retain(|(name, _)| {
                if cfg!(windows) {
                    !name.eq_ignore_ascii_case(key)
                } else {
                    name != key
                }
            });
            env.push((key.to_string(), value));
        }
    }
}

/// A blank explicit value removes inheritance and opts back into discovery.
fn effective_env(overrides: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for key in ["ZCODE_BIN", "ZCODE_NODE", "PATH", "LOCALAPPDATA"] {
        let explicit = overrides.iter().find(|(name, _)| {
            if cfg!(windows) {
                name.eq_ignore_ascii_case(key)
            } else {
                *name == key
            }
        });
        let value = explicit
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var(key).ok());
        if let Some(value) = value {
            if key == "PATH" || !value.trim().is_empty() {
                env.insert(key.to_string(), value);
            }
        }
    }
    env
}

fn resolve_program(value: &str, env: &BTreeMap<String, String>, cwd: &Path) -> Option<PathBuf> {
    let value = value.trim();
    let path = Path::new(value);
    let resolved = if path.is_absolute() || value.contains('/') || value.contains('\\') {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        }
    } else {
        which::which_in(
            value,
            Some(std::ffi::OsString::from(
                env.get("PATH").map(String::as_str).unwrap_or(""),
            )),
            cwd,
        )
        .ok()?
    };
    resolved.is_file().then_some(resolved)
}

/// npm's Windows shim is not directly spawnable by the bridge. Read its JS
/// target instead, without running the shim or changing the user's installation.
pub(crate) fn cli_entry(path: &Path) -> Option<PathBuf> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "cmd" {
        let metadata = std::fs::metadata(path).ok()?;
        if metadata.len() > 32 * 1024 {
            return None;
        }
        let shim = std::fs::read_to_string(path).ok()?;
        let pattern = regex::Regex::new(r#"(?i)%dp0%[\\/]([^"\r\n]+?\.(?:cjs|mjs|js))"#).ok()?;
        for captures in pattern.captures_iter(&shim) {
            let relative = captures.get(1)?.as_str().replace('\\', "/");
            let entry = path.parent()?.join(relative);
            if entry.is_file() {
                return Some(entry);
            }
        }
        return None;
    }
    if matches!(extension.as_str(), "" | "exe" | "cjs" | "mjs" | "js") && path.is_file() {
        Some(path.to_path_buf())
    } else {
        None
    }
}

fn bundled_candidates(platform: &str, home: Option<&Path>, local: Option<&str>) -> Vec<PathBuf> {
    match platform {
        "windows" => local
            .map(PathBuf::from)
            .or_else(|| home.map(|home| home.join("AppData/Local")))
            .map(|base| vec![base.join("Programs/ZCode/resources/glm/zcode.cjs")])
            .unwrap_or_default(),
        "macos" => {
            let mut paths = vec![PathBuf::from(
                "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
            )];
            if let Some(home) = home {
                paths.push(home.join("Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"));
            }
            paths
        }
        _ => vec![
            PathBuf::from("/opt/ZCode/resources/glm/zcode.cjs"),
            PathBuf::from("/usr/share/zcode/resources/glm/zcode.cjs"),
        ],
    }
}

fn resolve_cli(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    home: Option<&Path>,
    platform: &str,
) -> Result<PathBuf, RuntimeError> {
    let cli = if let Some(explicit) = env.get("ZCODE_BIN") {
        resolve_program(explicit, env, cwd)
            .and_then(|path| cli_entry(&path))
            .ok_or_else(|| RuntimeError::CliInvalid(explicit.clone()))?
    } else {
        // Prefer the canonical desktop JS entry over a PATH .cmd launcher.
        bundled_candidates(platform, home, env.get("LOCALAPPDATA").map(String::as_str))
            .iter()
            .find_map(|path| cli_entry(path))
            .or_else(|| resolve_program("zcode", env, cwd).and_then(|path| cli_entry(&path)))
            .ok_or(RuntimeError::CliMissing)?
    };
    Ok(cli)
}

pub(crate) fn resolve_cli_path(
    overrides: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<PathBuf, RuntimeError> {
    resolve_cli(
        &effective_env(overrides),
        cwd,
        dirs::home_dir().as_deref(),
        std::env::consts::OS,
    )
}

fn resolve_paths(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    home: Option<&Path>,
    platform: &str,
) -> Result<ZCodeRuntime, RuntimeError> {
    let cli = resolve_cli(env, cwd, home, platform)?;
    let node = if let Some(explicit) = env.get("ZCODE_NODE") {
        resolve_program(explicit, env, cwd)
            .ok_or_else(|| RuntimeError::NodeInvalid(explicit.clone()))?
    } else {
        resolve_program("node", env, cwd)
            .or_else(|| {
                crate::process::node_bin_dir_candidates(home)
                    .into_iter()
                    .map(|dir| dir.join(if cfg!(windows) { "node.exe" } else { "node" }))
                    .find(|path| path.is_file())
            })
            .or_else(|| {
                if platform == "windows" {
                    std::env::var_os("ProgramFiles")
                        .map(|base| PathBuf::from(base).join("nodejs/node.exe"))
                        .filter(|path| path.is_file())
                } else {
                    None
                }
            })
            .ok_or(RuntimeError::NodeMissing)?
    };
    Ok(ZCodeRuntime { cli, node })
}

pub async fn resolve_runtime(
    overrides: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<ZCodeRuntime, RuntimeError> {
    let env = effective_env(overrides);
    let runtime = resolve_paths(&env, cwd, dirs::home_dir().as_deref(), std::env::consts::OS)?;
    let mut command = crate::process::tokio_command(&runtime.node);
    command.args(["-e", "if(Number(process.versions.node.split('.')[0])<22)process.exit(2);new (require('node:sqlite').DatabaseSync)(':memory:')"]);
    command.kill_on_drop(true);
    if let Some(path) = env.get("PATH") {
        command.env("PATH", path);
    }
    let output = tokio::time::timeout(Duration::from_secs(5), command.output()).await;
    if !matches!(output, Ok(Ok(ref output)) if output.status.success()) {
        return Err(RuntimeError::NodeUnsupported);
    }
    Ok(runtime)
}

pub fn initial_mode(
    preferred_mode: Option<&str>,
    preferred_config: &BTreeMap<String, String>,
    available: &[String],
) -> String {
    preferred_config
        .get("mode")
        .map(String::as_str)
        .into_iter()
        .chain(preferred_mode)
        .find(|mode| !mode.is_empty() && available.iter().any(|id| id == mode))
        .unwrap_or("build")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    #[test]
    fn explicit_paths_with_spaces_win_over_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("My ZCode/zcode.cjs");
        let node = dir.path().join("My Node/node.exe");
        file(&cli);
        file(&node);
        let env = BTreeMap::from([
            ("ZCODE_BIN".into(), cli.display().to_string()),
            ("ZCODE_NODE".into(), node.display().to_string()),
            ("LOCALAPPDATA".into(), dir.path().display().to_string()),
        ]);
        let runtime = resolve_paths(&env, dir.path(), Some(dir.path()), "windows").unwrap();
        assert_eq!(runtime.cli, cli);
        assert_eq!(runtime.node, node);
    }

    #[test]
    fn invalid_explicit_cli_does_not_fall_back_to_bundle() {
        let dir = tempfile::tempdir().unwrap();
        file(&dir.path().join("Programs/ZCode/resources/glm/zcode.cjs"));
        let env = BTreeMap::from([
            (
                "ZCODE_BIN".into(),
                dir.path().join("missing.cjs").display().to_string(),
            ),
            ("LOCALAPPDATA".into(), dir.path().display().to_string()),
        ]);
        assert!(matches!(
            resolve_paths(&env, dir.path(), None, "windows"),
            Err(RuntimeError::CliInvalid(_))
        ));
    }

    #[test]
    fn bundle_discovery_does_not_require_shell_path() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("Programs/ZCode/resources/glm/zcode.cjs");
        let node = dir.path().join("Node/node.exe");
        file(&cli);
        file(&node);
        let env = BTreeMap::from([
            ("LOCALAPPDATA".into(), dir.path().display().to_string()),
            ("ZCODE_NODE".into(), node.display().to_string()),
            ("PATH".into(), String::new()),
        ]);
        let runtime = resolve_paths(&env, dir.path(), None, "windows").unwrap();
        assert_eq!(runtime.cli, cli);
    }

    #[test]
    fn windows_shim_resolves_js_target_without_spawning_cmd() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("zcode.cmd");
        let entry = dir.path().join("node_modules/zcode/bin/zcode.mjs");
        file(&entry);
        std::fs::write(
            &shim,
            r#""%_prog%" "%dp0%\node_modules\zcode\bin\zcode.mjs" %*"#,
        )
        .unwrap();
        assert_eq!(cli_entry(&shim), Some(entry));
        std::fs::write(&shim, "unknown wrapper").unwrap();
        assert_eq!(cli_entry(&shim), None);
    }

    #[test]
    fn runtime_injection_replaces_keys_without_enabling_remote_hub() {
        let runtime = ZCodeRuntime {
            cli: "cli.cjs".into(),
            node: "node.exe".into(),
        };
        let mut env = vec![
            ("ZCODE_NODE".into(), "old".into()),
            ("ZCODE_ACP_REMOTE".into(), "1".into()),
        ];
        runtime.apply(&mut env);
        assert_eq!(env.iter().filter(|(key, _)| key == "ZCODE_NODE").count(), 1);
        assert!(env.contains(&("ZCODE_ACP_REMOTE".into(), "0".into())));
    }

    #[test]
    fn initial_mode_preserves_explicit_choices_and_replaces_stale_preferences() {
        let available = vec!["build".into(), "plan".into(), "yolo".into()];
        assert_eq!(initial_mode(None, &BTreeMap::new(), &available), "build");
        assert_eq!(
            initial_mode(Some("yolo"), &BTreeMap::new(), &available),
            "yolo"
        );
        assert_eq!(
            initial_mode(Some("retired"), &BTreeMap::new(), &available),
            "build"
        );
        let preferred = BTreeMap::from([("mode".into(), "plan".into())]);
        assert_eq!(initial_mode(Some("yolo"), &preferred, &available), "plan");
    }

    #[test]
    fn invalid_node_override_is_reported_instead_of_using_another_node() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("zcode.cjs");
        file(&cli);
        let env = BTreeMap::from([
            ("ZCODE_BIN".into(), cli.display().to_string()),
            (
                "ZCODE_NODE".into(),
                dir.path().join("missing-node.exe").display().to_string(),
            ),
        ]);
        assert!(matches!(
            resolve_paths(&env, dir.path(), None, "windows"),
            Err(RuntimeError::NodeInvalid(_))
        ));
    }

    #[test]
    fn missing_official_runtime_is_distinct_from_missing_bridge() {
        let dir = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([
            ("LOCALAPPDATA".into(), dir.path().display().to_string()),
            ("PATH".into(), String::new()),
        ]);
        assert!(matches!(
            resolve_paths(&env, dir.path(), None, "windows"),
            Err(RuntimeError::CliMissing)
        ));
    }

    #[test]
    fn ordinary_path_installation_is_discovered_with_spaces() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("Command Line Tools");
        let cli = bin.join(if cfg!(windows) { "zcode.exe" } else { "zcode" });
        let node = bin.join(if cfg!(windows) { "node.exe" } else { "node" });
        file(&cli);
        file(&node);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let env = BTreeMap::from([("PATH".into(), bin.display().to_string())]);
        let runtime = resolve_paths(&env, dir.path(), None, "test").unwrap();
        assert_eq!(runtime.cli, cli);
        assert_eq!(runtime.node, node);
    }

    #[test]
    fn explicit_environment_wins_and_blank_values_remove_inheritance() {
        temp_env::with_vars([("ZCODE_BIN", Some("inherited.cjs"))], || {
            let overrides = BTreeMap::from([("ZCODE_BIN".into(), "chosen.cjs".into())]);
            assert_eq!(
                effective_env(&overrides).get("ZCODE_BIN").unwrap(),
                "chosen.cjs"
            );
            let overrides = BTreeMap::from([
                ("ZCODE_BIN".into(), String::new()),
                ("PATH".into(), String::new()),
            ]);
            let env = effective_env(&overrides);
            assert!(!env.contains_key("ZCODE_BIN"));
            assert_eq!(env.get("PATH"), Some(&String::new()));
        });
    }
}
