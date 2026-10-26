use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoUrlParts {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subdir: Option<String>,
}

/// Strict protocol validation. Only https and ssh protocols are permitted in production.
/// `ext::`, `file://`, and local paths are rejected unless `allow_file` is true (tests only).
pub fn validate_git_protocol(url: &str, allow_file: bool) -> Result<(), AppCommandError> {
    let lower = url.to_ascii_lowercase();

    // 1. Explicitly forbid dangerous ext:: protocol
    if lower.starts_with("ext::") || lower.contains("::") {
        return Err(AppCommandError::invalid_input(
            "Protocol 'ext::' or custom helpers are strictly forbidden",
        ));
    }

    // 2. Reject file:// unless explicitly allowed in test
    if lower.starts_with("file://") || lower.starts_with("file:") {
        if allow_file {
            return Ok(());
        }
        return Err(AppCommandError::invalid_input(
            "Protocol 'file://' is strictly forbidden",
        ));
    }

    // 3. Reject local filesystem paths (Windows drive C:\ or Unix /path) unless allowed in test
    let is_windows_drive = url.len() >= 2
        && url.as_bytes()[0].is_ascii_alphabetic()
        && url.as_bytes()[1] == b':';
    let is_unix_abs = url.starts_with('/') || url.starts_with('\\');
    let is_relative_path = url.starts_with("./") || url.starts_with(".\\") || url.starts_with("../") || url.starts_with("..\\");

    if is_windows_drive || is_unix_abs || is_relative_path {
        if allow_file {
            return Ok(());
        }
        return Err(AppCommandError::invalid_input(
            "Local filesystem paths are not allowed as repository URLs",
        ));
    }

    // 4. Check for allowed protocols
    if lower.starts_with("https://") {
        return Ok(());
    }

    if lower.starts_with("ssh://") {
        return Ok(());
    }

    // Check for SCP-style git@host:owner/repo.git or user@host:path
    if is_scp_style_ssh(url) {
        return Ok(());
    }

    // Explicitly reject unencrypted http:// or other schemes
    if lower.starts_with("http://") {
        return Err(AppCommandError::invalid_input(
            "Plain HTTP protocol is forbidden; use HTTPS or SSH instead",
        ));
    }

    Err(AppCommandError::invalid_input(format!(
        "Unsupported or forbidden repository URL protocol for '{url}'. Only HTTPS and SSH are allowed."
    )))
}

fn is_scp_style_ssh(url: &str) -> bool {
    // Matches e.g. git@github.com:owner/repo.git or user@host.com:path/to/repo
    if let Some((user_host, path)) = url.split_once(':') {
        if user_host.contains('@') && !user_host.contains('/') && !user_host.contains('\\') && !path.is_empty() {
            return true;
        }
    }
    false
}

/// Parse repository URL into base URL, optional branch/tag ref, and optional subdir.
/// Supports GitHub, Gitee, GitLab tree URLs, standard HTTPS, and SSH.
pub fn parse_repo_url(url: &str) -> Result<RepoUrlParts, AppCommandError> {
    parse_repo_url_with_options(url, false)
}

pub fn parse_repo_url_with_options(
    url: &str,
    allow_file: bool,
) -> Result<RepoUrlParts, AppCommandError> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Repository URL cannot be empty",
        ));
    }

    validate_git_protocol(trimmed, allow_file)?;

    // GitLab tree URLs typically use /-/tree/<ref>/<subdir>
    // GitHub and Gitee use /tree/<ref>/<subdir>
    let (base_url, rest) = if let Some(idx) = trimmed.find("/-/tree/") {
        let base = &trimmed[..idx];
        let rest = &trimmed[idx + "/-/tree/".len()..];
        (base, Some(rest))
    } else if let Some(idx) = trimmed.find("/tree/") {
        let base = &trimmed[..idx];
        let rest = &trimmed[idx + "/tree/".len()..];
        (base, Some(rest))
    } else {
        (trimmed, None)
    };

    let mut parts = RepoUrlParts {
        url: base_url.to_string(),
        r#ref: None,
        subdir: None,
    };

    if let Some(rest) = rest {
        let clean_rest = rest.trim_matches('/');
        if !clean_rest.is_empty() {
            if let Some((ref_part, subdir_part)) = clean_rest.split_once('/') {
                let r = ref_part.trim();
                let s = subdir_part.trim().trim_matches('/');
                if !r.is_empty() {
                    parts.r#ref = Some(r.to_string());
                }
                if !s.is_empty() {
                    parts.subdir = Some(s.to_string());
                }
            } else {
                parts.r#ref = Some(clean_rest.to_string());
            }
        }
    }

    Ok(parts)
}

/// Check that the system git is installed and version is >= 2.25.
pub async fn check_git_version() -> Result<(u32, u32), AppCommandError> {
    let output = crate::process::tokio_command("git")
        .arg("--version")
        .output()
        .await
        .map_err(|e| {
            AppCommandError::io_error(format!("Failed to execute 'git --version': {e}"))
        })?;

    if !output.status.success() {
        return Err(AppCommandError::io_error(format!(
            "'git --version' returned non-zero status: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_and_validate_git_version(&stdout)
}

pub fn parse_and_validate_git_version(version_str: &str) -> Result<(u32, u32), AppCommandError> {
    let re = regex::Regex::new(r"git\s+version\s+(\d+)\.(\d+)")
        .map_err(|e| AppCommandError::invalid_input(format!("Regex error: {e}")))?;

    if let Some(caps) = re.captures(version_str) {
        let major: u32 = caps[1]
            .parse()
            .map_err(|_| AppCommandError::invalid_input("Failed to parse git major version"))?;
        let minor: u32 = caps[2]
            .parse()
            .map_err(|_| AppCommandError::invalid_input("Failed to parse git minor version"))?;

        if major > 2 || (major == 2 && minor >= 25) {
            Ok((major, minor))
        } else {
            Err(AppCommandError::invalid_input(format!(
                "git version 2.25 or higher is required (found {major}.{minor})"
            )))
        }
    } else {
        Err(AppCommandError::invalid_input(format!(
            "Failed to parse git version from output: '{version_str}'"
        )))
    }
}

/// Force-removes a directory tree, clearing Windows read-only flags on files.
pub fn remove_dir_all_force(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    for entry in walkdir::WalkDir::new(path).into_iter().flatten() {
        let p = entry.path();
        if let Ok(metadata) = std::fs::symlink_metadata(p) {
            let mut permissions = metadata.permissions();
            if permissions.readonly() {
                #[allow(clippy::permissions_set_readonly_false)]
                permissions.set_readonly(false);
                let _ = std::fs::set_permissions(p, permissions);
            }
        }
    }
    std::fs::remove_dir_all(path)
}

/// Recursively copies all entries from `src` to `dst`.
pub fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let dest_child = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_all(&entry.path(), &dest_child)?;
        } else {
            std::fs::copy(entry.path(), &dest_child)?;
        }
    }
    Ok(())
}

/// Clones a git repository into destination_dir using sparse clone.
/// Automatically removes .git folder, isolates subdir if specified, and returns commit SHA.
pub async fn clone_git_repo(
    url: &str,
    ref_name: Option<&str>,
    subdir: Option<&str>,
    destination_dir: &Path,
    allow_file: bool,
) -> Result<String, AppCommandError> {
    check_git_version().await?;
    validate_git_protocol(url, allow_file)?;

    if !destination_dir.exists() {
        std::fs::create_dir_all(destination_dir).map_err(|e| {
            AppCommandError::io_error(format!(
                "Failed to create clone destination directory {}: {e}",
                destination_dir.display()
            ))
        })?;
    }

    let raw_repo_dir = destination_dir.join("raw_git_repo");
    if raw_repo_dir.exists() {
        let _ = remove_dir_all_force(&raw_repo_dir);
    }

    let protocol_env = if allow_file {
        "https:ssh:file"
    } else {
        "https:ssh"
    };

    let mut cmd = crate::process::tokio_command("git");
    cmd.arg("clone");
    cmd.arg("--depth").arg("1");
    cmd.arg("--filter=blob:none");
    cmd.arg("--sparse");
    if let Some(r) = ref_name {
        if !r.trim().is_empty() {
            cmd.arg("--branch").arg(r.trim());
        }
    }
    cmd.arg(url);
    cmd.arg(&raw_repo_dir);

    cmd.env("GIT_ALLOW_PROTOCOL", protocol_env);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_LFS_SKIP_SMUDGE", "1");

    let mut child = cmd.spawn().map_err(|e| {
        AppCommandError::io_error(format!("Failed to spawn git clone: {e}"))
    })?;

    // 5-minute timeout cap
    let wait_res = tokio::time::timeout(Duration::from_secs(300), child.wait()).await;
    let status = match wait_res {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            let _ = child.kill().await;
            return Err(AppCommandError::io_error(format!(
                "Git clone execution error: {e}"
            )));
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(AppCommandError::io_error(
                "Git clone timed out after 5 minutes",
            ));
        }
    };

    if !status.success() {
        return Err(AppCommandError::io_error(format!(
            "Git clone failed with exit status {status}"
        )));
    }

    // If subdir specified, run sparse-checkout set <subdir>
    if let Some(sub) = subdir {
        let clean_sub = sub.trim_matches('/').replace('\\', "/");
        if !clean_sub.is_empty() {
            let mut sparse_cmd = crate::process::tokio_command("git");
            sparse_cmd.current_dir(&raw_repo_dir);
            sparse_cmd.args(["sparse-checkout", "set", &clean_sub]);
            sparse_cmd.env("GIT_ALLOW_PROTOCOL", protocol_env);
            sparse_cmd.env("GIT_TERMINAL_PROMPT", "0");

            let sparse_out = sparse_cmd.output().await.map_err(|e| {
                AppCommandError::io_error(format!("Failed to run git sparse-checkout: {e}"))
            })?;

            if !sparse_out.status.success() {
                let err_msg = String::from_utf8_lossy(&sparse_out.stderr);
                let _ = remove_dir_all_force(&raw_repo_dir);
                return Err(AppCommandError::io_error(format!(
                    "Git sparse-checkout set failed: {err_msg}"
                )));
            }
        }
    } else {
        let mut sparse_cmd = crate::process::tokio_command("git");
        sparse_cmd.current_dir(&raw_repo_dir);
        sparse_cmd.args(["sparse-checkout", "disable"]);
        sparse_cmd.env("GIT_ALLOW_PROTOCOL", protocol_env);
        sparse_cmd.env("GIT_TERMINAL_PROMPT", "0");
        let _ = sparse_cmd.output().await;
    }

    // Get commit SHA
    let mut rev_cmd = crate::process::tokio_command("git");
    rev_cmd.current_dir(&raw_repo_dir);
    rev_cmd.args(["rev-parse", "HEAD"]);
    let rev_out = rev_cmd.output().await.map_err(|e| {
        AppCommandError::io_error(format!("Failed to run git rev-parse: {e}"))
    })?;

    if !rev_out.status.success() {
        let err_msg = String::from_utf8_lossy(&rev_out.stderr);
        let _ = remove_dir_all_force(&raw_repo_dir);
        return Err(AppCommandError::io_error(format!(
            "Git rev-parse HEAD failed: {err_msg}"
        )));
    }
    let commit_hash = String::from_utf8_lossy(&rev_out.stdout).trim().to_string();

    // Source directory to keep
    let plugin_content_dir = if let Some(sub) = subdir {
        let clean_sub = sub.trim_matches('/').replace('/', std::path::MAIN_SEPARATOR_STR);
        raw_repo_dir.join(clean_sub)
    } else {
        raw_repo_dir.clone()
    };

    if !plugin_content_dir.exists() {
        let _ = remove_dir_all_force(&raw_repo_dir);
        return Err(AppCommandError::not_found(format!(
            "Subdirectory '{}' not found in cloned repository",
            subdir.unwrap_or("")
        )));
    }

    // Copy extracted plugin content to a temporary location outside raw_repo_dir
    let temp_extracted = destination_dir.join("temp_extracted");
    if temp_extracted.exists() {
        let _ = remove_dir_all_force(&temp_extracted);
    }
    copy_dir_all(&plugin_content_dir, &temp_extracted).map_err(|e| {
        AppCommandError::io_error(format!("Failed to copy plugin content: {e}"))
    })?;

    // Completely remove raw_repo_dir (including .git)
    let _ = remove_dir_all_force(&raw_repo_dir);

    // Also remove any nested .git in temp_extracted if present
    let git_dir_in_temp = temp_extracted.join(".git");
    if git_dir_in_temp.exists() {
        let _ = remove_dir_all_force(&git_dir_in_temp);
    }

    // Move files from temp_extracted into destination_dir
    for entry in std::fs::read_dir(&temp_extracted).map_err(|e| {
        AppCommandError::io_error(format!("Failed to read temp extracted dir: {e}"))
    })? {
        let entry = entry.map_err(|e| AppCommandError::io_error(e.to_string()))?;
        let dest_file = destination_dir.join(entry.file_name());
        if dest_file.exists() {
            let _ = remove_dir_all_force(&dest_file);
        }
        if std::fs::rename(entry.path(), &dest_file).is_err() {
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                copy_dir_all(&entry.path(), &dest_file).map_err(|e| {
                    AppCommandError::io_error(format!("Failed to copy entry: {e}"))
                })?;
                let _ = remove_dir_all_force(&entry.path());
            } else {
                std::fs::copy(entry.path(), &dest_file).map_err(|e| {
                    AppCommandError::io_error(format!("Failed to copy file: {e}"))
                })?;
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let _ = remove_dir_all_force(&temp_extracted);

    Ok(commit_hash)
}
