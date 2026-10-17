use std::path::Path;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::paths::codeg_plugins_root;

pub mod builtin;
pub mod git_source;
pub mod installer;
pub mod manifest;
pub mod registry;
pub mod state;

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
/// Empty placeholder for WP1; WP7 will terminate running backend processes.
pub fn stop_all() {
    tracing::info!("[plugin_host] stop_all invoked");
}

/// Lifecycle hook: called when a plugin is enabled. Handed over to WP7.
pub async fn on_enabled(_id: &str) -> Result<(), AppCommandError> {
    Ok(())
}

/// Lifecycle hook: called when a plugin is disabled. Handed over to WP7.
pub async fn on_disabled(_id: &str) -> Result<(), AppCommandError> {
    Ok(())
}

/// Lifecycle hook: called when a plugin is uninstalled. Handed over to WP7.
pub async fn on_uninstall(_id: &str) -> Result<(), AppCommandError> {
    Ok(())
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod builtin_manifests_test;
