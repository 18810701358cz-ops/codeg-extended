use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use crate::app_error::AppCommandError;
use crate::paths::simplify_verbatim_path;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Resolves the Python executable on the current system.
///
/// On Windows:
/// 1. Tries `py -3` first and queries `sys.executable`.
/// 2. Tries `python` on PATH, explicitly ignoring Microsoft Store / WindowsApps dummy shims.
///
/// On Unix / macOS:
/// 1. Tries `python3` first.
/// 2. Falls back to `python`.
pub fn resolve_python() -> Result<String, AppCommandError> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        // 1. Try py -3
        let mut cmd = Command::new("py");
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.args(["-3", "-c", "import sys; print(sys.executable)"]);
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !stdout.is_empty() && Path::new(&stdout).is_file() {
                    let lower = stdout.to_ascii_lowercase();
                    if !lower.contains("windowsapps") {
                        return Ok(stdout);
                    }
                }
            }
        }

        // 2. Try python on PATH excluding WindowsApps
        if let Ok(candidates) = which::which_all("python") {
            for cand in candidates {
                let lower = cand.to_string_lossy().to_ascii_lowercase();
                if lower.contains("windowsapps") {
                    continue;
                }
                let mut cmd = Command::new(&cand);
                cmd.creation_flags(CREATE_NO_WINDOW);
                cmd.args(["-c", "import sys; print(sys.executable)"]);
                if let Ok(out) = cmd.output() {
                    if out.status.success() {
                        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        if !stdout.is_empty() && Path::new(&stdout).is_file() {
                            return Ok(stdout);
                        }
                        return Ok(cand.to_string_lossy().to_string());
                    }
                }
            }
        }

        Err(AppCommandError::not_found(
            "Python runtime not found (checked 'py -3' and 'python' excluding WindowsApps)",
        ))
    }

    #[cfg(not(windows))]
    {
        // 1. Try python3
        if let Ok(cand) = which::which("python3") {
            let mut cmd = Command::new(&cand);
            cmd.args(["-c", "import sys; print(sys.executable)"]);
            if let Ok(out) = cmd.output() {
                if out.status.success() {
                    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !stdout.is_empty() && Path::new(&stdout).is_file() {
                        return Ok(stdout);
                    }
                    return Ok(cand.to_string_lossy().to_string());
                }
            }
        }

        // 2. Try python
        if let Ok(cand) = which::which("python") {
            let mut cmd = Command::new(&cand);
            cmd.args(["-c", "import sys; print(sys.executable)"]);
            if let Ok(out) = cmd.output() {
                if out.status.success() {
                    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !stdout.is_empty() && Path::new(&stdout).is_file() {
                        return Ok(stdout);
                    }
                    return Ok(cand.to_string_lossy().to_string());
                }
            }
        }

        Err(AppCommandError::not_found(
            "Python runtime not found (checked 'python3' and 'python')",
        ))
    }
}

/// Resolves the Node.js executable on the current system.
///
/// Calls `crate::process::ensure_node_in_path()` first, then checks PATH.
pub fn resolve_node() -> Result<String, AppCommandError> {
    crate::process::ensure_node_in_path();
    match which::which("node") {
        Ok(path) => Ok(path.to_string_lossy().to_string()),
        Err(_) => Ok("node".to_string()),
    }
}

/// Context for variable expansion in backend and contribution declarations.
#[derive(Debug, Clone)]
pub struct VariableContext<'a> {
    pub plugin_dir: &'a Path,
    pub data_dir: &'a Path,
    pub port: Option<u16>,
    pub token: Option<&'a str>,
    pub config: &'a BTreeMap<String, serde_json::Value>,
    pub plugin_id: Option<&'a str>,
}

/// Expands variables in a template string:
/// - `${pluginDir}`
/// - `${dataDir}`
/// - `${port}`
/// - `${token}`
/// - `${backend.url}` -> `http://127.0.0.1:${port}`
/// - `${python}`
/// - `${node}`
/// - `${config.<key>}`
pub fn expand_string(template: &str, ctx: &VariableContext) -> String {
    if !template.contains("${") {
        return template.to_string();
    }

    let mut result = template.to_string();

    let plugin_dir_str = simplify_verbatim_path(ctx.plugin_dir)
        .to_string_lossy()
        .replace('\\', "/");
    let data_dir_str = simplify_verbatim_path(ctx.data_dir)
        .to_string_lossy()
        .replace('\\', "/");

    let port_str = ctx.port.map(|p| p.to_string()).unwrap_or_default();
    let backend_url_str = ctx
        .port
        .map(|p| format!("http://127.0.0.1:{p}"))
        .unwrap_or_default();
    let token_str = ctx.token.unwrap_or_default();

    result = result.replace("${pluginDir}", &plugin_dir_str);
    result = result.replace("${dataDir}", &data_dir_str);
    result = result.replace("${port}", &port_str);
    result = result.replace("${backend.url}", &backend_url_str);
    result = result.replace("${token}", token_str);

    if result.contains("${python}") {
        let python = resolve_python().unwrap_or_else(|_| "python".to_string());
        result = result.replace("${python}", &python);
    }

    if result.contains("${node}") {
        let node = resolve_node().unwrap_or_else(|_| "node".to_string());
        result = result.replace("${node}", &node);
    }

    // Expand ${config.<key>}
    while let Some(start_idx) = result.find("${config.") {
        let rest = &result[start_idx + "${config.".len()..];
        if let Some(end_rel) = rest.find('}') {
            let key = &rest[..end_rel];
            let full_match = format!("${{config.{key}}}");

            let value_str = if let Some(val) = ctx.config.get(key) {
                match val {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Bool(b) => b.to_string(),
                    serde_json::Value::Number(n) => n.to_string(),
                    other => other.to_string(),
                }
            } else if let Some(pid) = ctx.plugin_id {
                let secret_name = format!("plugin:{pid}:{key}");
                crate::keyring_store::get_secret(&secret_name)
                    .ok()
                    .flatten()
                    .unwrap_or_default()
            } else {
                String::new()
            };

            result = result.replace(&full_match, &value_str);
        } else {
            break;
        }
    }

    result
}

/// Expands a slice of argument strings.
pub fn expand_vec(args: &[String], ctx: &VariableContext) -> Vec<String> {
    args.iter().map(|arg| expand_string(arg, ctx)).collect()
}

/// Expands environment variable map values.
pub fn expand_env(
    env: &BTreeMap<String, String>,
    ctx: &VariableContext,
) -> BTreeMap<String, String> {
    let mut expanded = BTreeMap::new();
    for (k, v) in env {
        let key = expand_string(k, ctx);
        let val = expand_string(v, ctx);
        expanded.insert(key, val);
    }
    expanded
}

/// Recursively expands all string fields in a JSON value.
pub fn expand_json_value(val: &serde_json::Value, ctx: &VariableContext) -> serde_json::Value {
    match val {
        serde_json::Value::String(s) => serde_json::Value::String(expand_string(s, ctx)),
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(|v| expand_json_value(v, ctx)).collect())
        }
        serde_json::Value::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (k, v) in map {
                new_map.insert(k.clone(), expand_json_value(v, ctx));
            }
            serde_json::Value::Object(new_map)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_expand_string_variables() {
        let plugin_dir = PathBuf::from("X:/plugins/test-plugin");
        let data_dir = PathBuf::from("X:/data");
        let mut config = BTreeMap::new();
        config.insert("authFile".to_string(), serde_json::json!("/path/to/auth"));
        config.insert("count".to_string(), serde_json::json!(42));
        config.insert("enabled".to_string(), serde_json::json!(true));

        let ctx = VariableContext {
            plugin_dir: &plugin_dir,
            data_dir: &data_dir,
            port: Some(18080),
            token: Some("secret_token_123"),
            config: &config,
            plugin_id: Some("test-plugin"),
        };

        let template = "${backend.url}/v1?token=${token}&file=${config.authFile}&c=${config.count}&e=${config.enabled}";
        let expanded = expand_string(template, &ctx);
        assert_eq!(
            expanded,
            "http://127.0.0.1:18080/v1?token=secret_token_123&file=/path/to/auth&c=42&e=true"
        );
    }

    #[test]
    fn test_resolve_python_succeeds_or_fails_gracefully() {
        let py = resolve_python();
        // If Python is installed on this machine, it should be an existing file and not in WindowsApps.
        if let Ok(path) = py {
            assert!(Path::new(&path).exists());
            #[cfg(windows)]
            assert!(!path.to_ascii_lowercase().contains("windowsapps"));
        }
    }

    #[test]
    fn test_resolve_node() {
        let node = resolve_node();
        assert!(node.is_ok());
    }
}
