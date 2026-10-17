use std::path::Path;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::paths::codeg_plugins_root;

pub mod backend;
pub mod builtin;
pub mod contributions;
pub mod git_source;
pub mod installer;
pub mod manifest;
pub mod registry;
pub mod runtime_resolve;
pub(crate) mod secrets;
pub mod state;
pub mod watcher;

pub use watcher::set_dev_mode;

pub const PLUGIN_HOST_VERSION: &str = "1.0.0";
pub const PLUGIN_HOST_API_VERSION: u32 = 1;

pub const CHANGED_EVENT: &str = "plugin-host://changed";
pub const BACKEND_STATUS_EVENT: &str = "plugin-host://backend-status";
pub const PLUGIN_SAFE_MODE_ENV: &str = "CODEG_PLUGINS_SAFE_MODE";

pub const STAGING_DIR_NAME: &str = ".staging";
const STAGING_MAX_AGE: Duration = Duration::from_secs(3600); // 1 hour

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedEvent {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatusEvent {
    pub id: String,
    pub status: manifest::BackendStatus,
}

pub fn is_safe_mode() -> bool {
    match std::env::var(PLUGIN_SAFE_MODE_ENV) {
        Ok(val) => {
            let trimmed = val.trim().to_ascii_lowercase();
            matches!(trimmed.as_str(), "1" | "true" | "yes" | "on")
        }
        Err(_) => false,
    }
}

pub fn set_emitter(emitter: crate::web::event_bridge::EventEmitter) {
    backend::set_backend_emitter(emitter.clone());
    watcher::set_watcher_emitter(emitter);
}

pub async fn init() -> Result<(), AppCommandError> {
    let plugins_root = codeg_plugins_root();
    init_at(&plugins_root).await
}

pub async fn init_at(plugins_root: &Path) -> Result<(), AppCommandError> {
    if !plugins_root.exists() {
        std::fs::create_dir_all(plugins_root).map_err(|e| {
            AppCommandError::io_error(format!(
                "Failed to create plugins root {}: {e}",
                plugins_root.display()
            ))
        })?;
    }

    clean_staging(plugins_root);

    builtin::ensure_builtin_plugins_installed(plugins_root).await?;

    let state = state::load_state(plugins_root).await;

    // Auto-start watcher if dev_mode is active
    if state.dev_mode {
        if let Err(e) = watcher::start_watcher_at(plugins_root).await {
            tracing::warn!("[plugin_host] failed to start dev mode watcher on init: {e}");
        }
    }

    // Auto-start backends for all enabled plugins unless safe mode is active
    if !is_safe_mode() {
        let plugins = registry::scan_plugins(plugins_root, &state, false);
        for p in plugins {
            if p.enabled && p.has_backend {
                let root = plugins_root.to_path_buf();
                let pid = p.id.clone();
                tokio::spawn(async move {
                    if let Err(e) = backend::start_backend(&root, &pid, None).await {
                        tracing::warn!("[plugin_host] failed to autostart backend for '{pid}': {e}");
                    }
                });
            }
        }
    }

    tracing::info!(
        "[plugin_host] initialized plugins root at {}",
        plugins_root.display()
    );

    Ok(())
}

pub fn clean_staging(plugins_root: &Path) {
    let staging_root = plugins_root.join(STAGING_DIR_NAME);
    if !staging_root.exists() {
        return;
    }

    let read_dir = match std::fs::read_dir(&staging_root) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    let now = SystemTime::now();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if let Ok(age) = now.duration_since(modified) {
                    if age > STAGING_MAX_AGE {
                        tracing::info!(
                            "[plugin_host] cleaning up expired staging dir {}",
                            path.display()
                        );
                        let _ = std::fs::remove_dir_all(&path);
                    }
                }
            }
        }
    }
}

/// Graceful shutdown hook for all plugin backend processes.
pub fn stop_all() {
    tracing::info!("[plugin_host] stop_all invoked");
    watcher::stop_watcher();
    backend::stop_all();
}

/// Lifecycle hook: called when a plugin is enabled.
pub async fn on_enabled(id: &str) -> Result<(), AppCommandError> {
    let plugins_root = codeg_plugins_root();
    on_enabled_at(&plugins_root, id).await
}

pub async fn on_enabled_at(plugins_root: &Path, id: &str) -> Result<(), AppCommandError> {
    let plugin_dir = plugins_root.join(id);
    let manifest_path = plugin_dir.join(registry::MANIFEST_FILE_NAME);
    if !manifest_path.exists() {
        return Ok(());
    }

    let raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
        AppCommandError::io_error(format!("Failed to read manifest for '{id}': {e}"))
    })?;
    let manifest: manifest::PluginManifest = serde_json::from_str(&raw).map_err(|e| {
        AppCommandError::invalid_input(format!("Failed to parse manifest for '{id}': {e}"))
    })?;

    if manifest.backend.is_some() && !is_safe_mode() {
        let _ = backend::start_backend(plugins_root, id, None).await?;
    }

    let _ = contributions::apply_contributions(plugins_root, id, &manifest).await?;
    Ok(())
}

/// Lifecycle hook: called when a plugin is disabled.
pub async fn on_disabled(id: &str) -> Result<(), AppCommandError> {
    let plugins_root = codeg_plugins_root();
    on_disabled_at(&plugins_root, id).await
}

pub async fn on_disabled_at(_plugins_root: &Path, id: &str) -> Result<(), AppCommandError> {
    backend::stop_backend(id).await;
    Ok(())
}

/// Lifecycle hook: called when a plugin is uninstalled.
pub async fn on_uninstall(id: &str, remove_contributions: bool) -> Result<(), AppCommandError> {
    let plugins_root = codeg_plugins_root();
    on_uninstall_at(&plugins_root, id, remove_contributions).await
}

pub async fn on_uninstall_at(
    plugins_root: &Path,
    id: &str,
    remove_contributions: bool,
) -> Result<(), AppCommandError> {
    backend::stop_backend(id).await;
    if remove_contributions {
        contributions::remove_contributions(plugins_root, id).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod builtin_manifests_test;
