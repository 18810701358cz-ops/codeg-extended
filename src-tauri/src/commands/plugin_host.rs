use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::app_error::AppCommandError;
#[cfg(feature = "tauri-runtime")]
use crate::paths::codeg_plugins_root;
use crate::plugin_host::git_source::{parse_repo_url, RepoUrlParts};
use crate::plugin_host::installer::{
    self, commit_install, discard_staging, stage_source, uninstall, InstallSource, StageResult,
    UpdateCheckResult,
};
use crate::plugin_host::manifest::{is_valid_plugin_id, PluginManifest};
use crate::plugin_host::registry::{
    build_plugin_list_result, scan_plugins, PluginInfo, PluginListResult, MANIFEST_FILE_NAME,
};
use crate::plugin_host::state::{
    clear_plugin_failures, disable_all_plugins, load_state, record_plugin_failure,
    set_plugin_config, set_plugin_enabled,
};
use crate::plugin_host::{
    is_safe_mode, on_disabled, on_enabled, ChangedEvent, CHANGED_EVENT,
};
use crate::web::event_bridge::{emit_event, EventEmitter};

#[cfg(feature = "tauri-runtime")]
use tauri::AppHandle;

pub const ENTRY_MAX_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB
pub const ASSET_MAX_BYTES: u64 = 10 * 1024 * 1024; // 10 MiB

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntryResult {
    pub code: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAssetResult {
    pub mime: String,
    pub base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfig {
    pub values: BTreeMap<String, serde_json::Value>,
    pub secrets_set: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportErrorResult {
    pub auto_disabled: bool,
}

pub fn safe_resolve_plugin_file(
    plugin_dir: &Path,
    rel_path: &str,
    max_bytes: u64,
) -> Result<PathBuf, AppCommandError> {
    if rel_path.is_empty() {
        return Err(AppCommandError::invalid_input("Path cannot be empty"));
    }
    let p = Path::new(rel_path);
    if p.is_absolute() || rel_path.starts_with('/') || rel_path.starts_with('\\') {
        return Err(AppCommandError::invalid_input(format!(
            "Path '{rel_path}' must be relative"
        )));
    }
    for comp in p.components() {
        match comp {
            std::path::Component::ParentDir => {
                return Err(AppCommandError::invalid_input(format!(
                    "Path '{rel_path}' contains parent traversal '..'"
                )));
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err(AppCommandError::invalid_input(format!(
                    "Path '{rel_path}' is not relative"
                )));
            }
            _ => {}
        }
    }

    let canonical_dir = plugin_dir.canonicalize().map_err(|e| {
        AppCommandError::not_found(format!(
            "Plugin directory '{}' not found: {e}",
            plugin_dir.display()
        ))
    })?;

    let candidate = plugin_dir.join(p);
    let canonical_file = candidate.canonicalize().map_err(|e| {
        AppCommandError::not_found(format!("File '{rel_path}' not found: {e}"))
    })?;

    if !canonical_file.starts_with(&canonical_dir) {
        return Err(AppCommandError::permission_denied(format!(
            "Path '{rel_path}' escapes plugin directory"
        )));
    }

    if !canonical_file.is_file() {
        return Err(AppCommandError::invalid_input(format!(
            "Path '{rel_path}' is not a regular file"
        )));
    }

    let metadata = canonical_file.metadata().map_err(|e| {
        AppCommandError::io_error(format!("Failed to read metadata for '{rel_path}': {e}"))
    })?;

    if metadata.len() > max_bytes {
        return Err(AppCommandError::invalid_input(format!(
            "File '{rel_path}' exceeds maximum size of {max_bytes} bytes (got {} bytes)",
            metadata.len()
        )));
    }

    Ok(canonical_file)
}

pub fn mime_from_extension(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("css") => "text/css",
        Some("js") | Some("mjs") => "application/javascript",
        Some("json") => "application/json",
        Some("html") | Some("htm") => "text/html",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain",
        _ => "application/octet-stream",
    }
}

pub async fn plugin_host_list_core(
    plugins_root: &Path,
) -> Result<PluginListResult, AppCommandError> {
    let state = load_state(plugins_root).await;
    let safe_mode = is_safe_mode();
    Ok(build_plugin_list_result(plugins_root, &state, safe_mode))
}

pub async fn plugin_host_read_entry_core(
    plugins_root: &Path,
    id: &str,
) -> Result<PluginEntryResult, AppCommandError> {
    if !is_valid_plugin_id(id) {
        return Err(AppCommandError::invalid_input(format!(
            "Invalid plugin id '{id}'"
        )));
    }
    let plugin_dir = plugins_root.join(id);
    if !plugin_dir.is_dir() {
        return Err(AppCommandError::not_found(format!("Plugin '{id}' not found")));
    }

    let manifest_path = plugin_dir.join(MANIFEST_FILE_NAME);
    let raw_manifest = std::fs::read_to_string(&manifest_path).map_err(|e| {
        AppCommandError::not_found(format!("Failed to read manifest for '{id}': {e}"))
    })?;
    let manifest: PluginManifest = serde_json::from_str(&raw_manifest).map_err(|e| {
        AppCommandError::invalid_input(format!("Invalid manifest for '{id}': {e}"))
    })?;

    let main_rel = manifest.main.ok_or_else(|| {
        AppCommandError::invalid_input(format!("Plugin '{id}' has no 'main' entry declared"))
    })?;

    let file_path = safe_resolve_plugin_file(&plugin_dir, &main_rel, ENTRY_MAX_BYTES)?;
    let bytes = std::fs::read(&file_path).map_err(|e| {
        AppCommandError::io_error(format!(
            "Failed to read entry file '{}': {e}",
            file_path.display()
        ))
    })?;

    let code = String::from_utf8(bytes).map_err(|e| {
        AppCommandError::invalid_input(format!("Entry file is not valid UTF-8: {e}"))
    })?;

    let mut hasher = Sha256::new();
    hasher.update(code.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    Ok(PluginEntryResult { code, hash })
}

pub async fn plugin_host_read_asset_core(
    plugins_root: &Path,
    id: &str,
    path: &str,
) -> Result<PluginAssetResult, AppCommandError> {
    if !is_valid_plugin_id(id) {
        return Err(AppCommandError::invalid_input(format!(
            "Invalid plugin id '{id}'"
        )));
    }
    let plugin_dir = plugins_root.join(id);
    if !plugin_dir.is_dir() {
        return Err(AppCommandError::not_found(format!("Plugin '{id}' not found")));
    }

    let file_path = safe_resolve_plugin_file(&plugin_dir, path, ASSET_MAX_BYTES)?;
    let bytes = std::fs::read(&file_path).map_err(|e| {
        AppCommandError::io_error(format!(
            "Failed to read asset file '{}': {e}",
            file_path.display()
        ))
    })?;

    let mime = mime_from_extension(&file_path).to_string();
    let base64 = BASE64.encode(&bytes);

    Ok(PluginAssetResult { mime, base64 })
}

pub async fn plugin_host_set_enabled_core(
    emitter: &EventEmitter,
    plugins_root: &Path,
    id: &str,
    enabled: bool,
) -> Result<PluginInfo, AppCommandError> {
    if !is_valid_plugin_id(id) {
        return Err(AppCommandError::invalid_input(format!(
            "Invalid plugin id '{id}'"
        )));
    }
    let plugin_dir = plugins_root.join(id);
    if !plugin_dir.is_dir() {
        return Err(AppCommandError::not_found(format!("Plugin '{id}' not found")));
    }

    set_plugin_enabled(plugins_root, id, enabled).await?;

    if enabled {
        on_enabled(id).await?;
    } else {
        on_disabled(id).await?;
    }

    emit_event(
        emitter,
        CHANGED_EVENT,
        ChangedEvent {
            ids: vec![id.to_string()],
        },
    );

    let state = load_state(plugins_root).await;
    let safe_mode = is_safe_mode();
    let plugins = scan_plugins(plugins_root, &state, safe_mode);
    plugins
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| AppCommandError::not_found(format!("Plugin '{id}' not found")))
}

pub async fn plugin_host_get_config_core(
    plugins_root: &Path,
    id: &str,
) -> Result<PluginConfig, AppCommandError> {
    if !is_valid_plugin_id(id) {
        return Err(AppCommandError::invalid_input(format!(
            "Invalid plugin id '{id}'"
        )));
    }
    let plugin_dir = plugins_root.join(id);
    if !plugin_dir.is_dir() {
        return Err(AppCommandError::not_found(format!("Plugin '{id}' not found")));
    }

    let manifest_path = plugin_dir.join(MANIFEST_FILE_NAME);
    let config_schema = if manifest_path.exists() {
        let raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
            AppCommandError::io_error(format!("Failed to read manifest: {e}"))
        })?;
        let manifest: PluginManifest = serde_json::from_str(&raw).map_err(|e| {
            AppCommandError::invalid_input(format!("Failed to parse manifest: {e}"))
        })?;
        manifest.config_schema
    } else {
        None
    };

    let state = load_state(plugins_root).await;
    let mut values = state
        .plugins
        .get(id)
        .map(|p| p.config.clone())
        .unwrap_or_default();

    let mut secrets_set = Vec::new();

    if let Some(schema) = config_schema {
        for (prop_key, prop) in schema.properties {
            if prop.format.as_deref() == Some("secret") {
                values.remove(&prop_key);
                let secret_name = format!("plugin:{id}:{prop_key}");
                if let Ok(Some(_)) = crate::keyring_store::get_secret(&secret_name) {
                    secrets_set.push(prop_key);
                }
            }
        }
    }
    secrets_set.sort();

    Ok(PluginConfig {
        values,
        secrets_set,
    })
}

pub async fn plugin_host_set_config_core(
    emitter: &EventEmitter,
    plugins_root: &Path,
    id: &str,
    mut values: BTreeMap<String, serde_json::Value>,
    secrets: Option<BTreeMap<String, Option<String>>>,
) -> Result<PluginConfig, AppCommandError> {
    if !is_valid_plugin_id(id) {
        return Err(AppCommandError::invalid_input(format!(
            "Invalid plugin id '{id}'"
        )));
    }
    let plugin_dir = plugins_root.join(id);
    if !plugin_dir.is_dir() {
        return Err(AppCommandError::not_found(format!("Plugin '{id}' not found")));
    }

    let manifest_path = plugin_dir.join(MANIFEST_FILE_NAME);
    let config_schema = if manifest_path.exists() {
        let raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
            AppCommandError::io_error(format!("Failed to read manifest: {e}"))
        })?;
        let manifest: PluginManifest = serde_json::from_str(&raw).map_err(|e| {
            AppCommandError::invalid_input(format!("Failed to parse manifest: {e}"))
        })?;
        manifest.config_schema
    } else {
        None
    };

    if let Some(secrets_map) = secrets {
        for (key, val_opt) in secrets_map {
            let secret_name = format!("plugin:{id}:{key}");
            match val_opt {
                Some(secret_val) => {
                    crate::keyring_store::set_secret(&secret_name, &secret_val)
                        .map_err(|e| AppCommandError::io_error(format!("Failed to save secret '{key}': {e}")))?;
                }
                None => {
                    crate::keyring_store::delete_secret(&secret_name)
                        .map_err(|e| AppCommandError::io_error(format!("Failed to delete secret '{key}': {e}")))?;
                }
            }
        }
    }

    // Strip secrets from values before saving to state
    if let Some(schema) = &config_schema {
        for (prop_key, prop) in &schema.properties {
            if prop.format.as_deref() == Some("secret") {
                values.remove(prop_key);
            }
        }
    }

    set_plugin_config(plugins_root, id, values).await?;

    emit_event(
        emitter,
        CHANGED_EVENT,
        ChangedEvent {
            ids: vec![id.to_string()],
        },
    );

    plugin_host_get_config_core(plugins_root, id).await
}

pub async fn plugin_host_report_error_core(
    emitter: &EventEmitter,
    plugins_root: &Path,
    id: &str,
    phase: &str,
    message: &str,
) -> Result<ReportErrorResult, AppCommandError> {
    if !is_valid_plugin_id(id) {
        return Err(AppCommandError::invalid_input(format!(
            "Invalid plugin id '{id}'"
        )));
    }

    tracing::warn!("[plugin_host] plugin '{id}' reported error ({phase}): {message}");

    let (failures, auto_disabled) = record_plugin_failure(plugins_root, id).await?;

    if auto_disabled {
        tracing::error!(
            "[plugin_host] plugin '{id}' auto-disabled after {failures} consecutive failures"
        );
        emit_event(
            emitter,
            CHANGED_EVENT,
            ChangedEvent {
                ids: vec![id.to_string()],
            },
        );
    }

    Ok(ReportErrorResult { auto_disabled })
}

pub async fn plugin_host_report_activated_core(
    plugins_root: &Path,
    id: &str,
) -> Result<(), AppCommandError> {
    if !is_valid_plugin_id(id) {
        return Err(AppCommandError::invalid_input(format!(
            "Invalid plugin id '{id}'"
        )));
    }

    clear_plugin_failures(plugins_root, id).await
}

pub async fn plugin_host_disable_all_core(
    emitter: &EventEmitter,
    plugins_root: &Path,
) -> Result<PluginListResult, AppCommandError> {
    disable_all_plugins(plugins_root).await?;

    emit_event(
        emitter,
        CHANGED_EVENT,
        ChangedEvent {
            ids: Vec::new(),
        },
    );

    plugin_host_list_core(plugins_root).await
}

pub async fn plugin_host_parse_repo_url_core(
    url: &str,
) -> Result<RepoUrlParts, AppCommandError> {
    parse_repo_url(url)
}

pub async fn plugin_host_stage_core(
    plugins_root: &Path,
    source: InstallSource,
) -> Result<StageResult, AppCommandError> {
    stage_source(plugins_root, source, false).await
}

pub async fn plugin_host_commit_install_core(
    emitter: &EventEmitter,
    plugins_root: &Path,
    staging_id: &str,
) -> Result<PluginInfo, AppCommandError> {
    commit_install(plugins_root, staging_id, emitter).await
}

pub async fn plugin_host_discard_staging_core(
    plugins_root: &Path,
    staging_id: &str,
) -> Result<(), AppCommandError> {
    discard_staging(plugins_root, staging_id)
}

pub async fn plugin_host_check_update_core(
    plugins_root: &Path,
    id: &str,
) -> Result<UpdateCheckResult, AppCommandError> {
    installer::check_update(plugins_root, id).await
}

pub async fn plugin_host_uninstall_core(
    emitter: &EventEmitter,
    plugins_root: &Path,
    id: &str,
    remove_contributions: bool,
) -> Result<(), AppCommandError> {
    uninstall(plugins_root, id, remove_contributions, emitter).await
}

// ─────────────────── Tauri Desktop Commands ───────────────────

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_list() -> Result<PluginListResult, AppCommandError> {
    let plugins_root = codeg_plugins_root();
    plugin_host_list_core(&plugins_root).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_read_entry(
    id: String,
) -> Result<PluginEntryResult, AppCommandError> {
    let plugins_root = codeg_plugins_root();
    plugin_host_read_entry_core(&plugins_root, &id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_read_asset(
    id: String,
    path: String,
) -> Result<PluginAssetResult, AppCommandError> {
    let plugins_root = codeg_plugins_root();
    plugin_host_read_asset_core(&plugins_root, &id, &path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<PluginInfo, AppCommandError> {
    let emitter = EventEmitter::Tauri(app);
    let plugins_root = codeg_plugins_root();
    plugin_host_set_enabled_core(&emitter, &plugins_root, &id, enabled).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_get_config(
    id: String,
) -> Result<PluginConfig, AppCommandError> {
    let plugins_root = codeg_plugins_root();
    plugin_host_get_config_core(&plugins_root, &id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_set_config(
    app: AppHandle,
    id: String,
    values: BTreeMap<String, serde_json::Value>,
    secrets: Option<BTreeMap<String, Option<String>>>,
) -> Result<PluginConfig, AppCommandError> {
    let emitter = EventEmitter::Tauri(app);
    let plugins_root = codeg_plugins_root();
    plugin_host_set_config_core(&emitter, &plugins_root, &id, values, secrets).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_report_error(
    app: AppHandle,
    id: String,
    phase: String,
    message: String,
) -> Result<ReportErrorResult, AppCommandError> {
    let emitter = EventEmitter::Tauri(app);
    let plugins_root = codeg_plugins_root();
    plugin_host_report_error_core(&emitter, &plugins_root, &id, &phase, &message).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_report_activated(
    id: String,
) -> Result<(), AppCommandError> {
    let plugins_root = codeg_plugins_root();
    plugin_host_report_activated_core(&plugins_root, &id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_disable_all(
    app: AppHandle,
) -> Result<PluginListResult, AppCommandError> {
    let emitter = EventEmitter::Tauri(app);
    let plugins_root = codeg_plugins_root();
    plugin_host_disable_all_core(&emitter, &plugins_root).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_parse_repo_url(
    url: String,
) -> Result<RepoUrlParts, AppCommandError> {
    plugin_host_parse_repo_url_core(&url).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_stage(
    source: InstallSource,
) -> Result<StageResult, AppCommandError> {
    let plugins_root = codeg_plugins_root();
    plugin_host_stage_core(&plugins_root, source).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_commit_install(
    app: AppHandle,
    staging_id: String,
) -> Result<PluginInfo, AppCommandError> {
    let emitter = EventEmitter::Tauri(app);
    let plugins_root = codeg_plugins_root();
    plugin_host_commit_install_core(&emitter, &plugins_root, &staging_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_discard_staging(
    staging_id: String,
) -> Result<(), AppCommandError> {
    let plugins_root = codeg_plugins_root();
    plugin_host_discard_staging_core(&plugins_root, &staging_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_check_update(
    id: String,
) -> Result<UpdateCheckResult, AppCommandError> {
    let plugins_root = codeg_plugins_root();
    plugin_host_check_update_core(&plugins_root, &id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_host_uninstall(
    app: AppHandle,
    id: String,
    remove_contributions: bool,
) -> Result<(), AppCommandError> {
    let emitter = EventEmitter::Tauri(app);
    let plugins_root = codeg_plugins_root();
    plugin_host_uninstall_core(&emitter, &plugins_root, &id, remove_contributions).await
}
