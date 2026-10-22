use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::app_error::AppCommandError;
use super::manifest::PluginSource;

pub static STATE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

const STATE_FILE_NAME: &str = "state.json";
const STATE_TMP_FILE_NAME: &str = "state.json.tmp";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppliedContributions {
    #[serde(default)]
    pub model_providers: BTreeMap<String, Vec<i64>>,
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub quick_messages: BTreeMap<String, Vec<i64>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStateEntry {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub source: PluginSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    #[serde(default)]
    pub config: BTreeMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_done_for: Option<String>,
    #[serde(default)]
    pub applied: AppliedContributions,
    #[serde(default)]
    pub consecutive_failures: u32,
}

fn default_true() -> bool {
    true
}

impl Default for PluginStateEntry {
    fn default() -> Self {
        Self {
            enabled: true,
            source: PluginSource::Manual,
            installed_version: None,
            config: BTreeMap::new(),
            port: None,
            setup_done_for: None,
            applied: AppliedContributions::default(),
            consecutive_failures: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHostState {
    #[serde(default = "default_state_version")]
    pub version: u32,
    #[serde(default)]
    pub dev_mode: bool,
    #[serde(default)]
    pub plugins: BTreeMap<String, PluginStateEntry>,
}

fn default_state_version() -> u32 {
    1
}

impl Default for PluginHostState {
    fn default() -> Self {
        Self {
            version: 1,
            dev_mode: false,
            plugins: BTreeMap::new(),
        }
    }
}

pub fn read_state_unlocked(plugins_root: &Path) -> PluginHostState {
    let state_path = plugins_root.join(STATE_FILE_NAME);
    if !state_path.exists() {
        return PluginHostState::default();
    }

    let content = match std::fs::read_to_string(&state_path) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                "[plugin_host] failed to read state file {}: {e}",
                state_path.display()
            );
            return PluginHostState::default();
        }
    };

    match serde_json::from_str::<PluginHostState>(&content) {
        Ok(state) => state,
        Err(err) => {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let corrupt_name = format!("state.json.corrupt-{}", timestamp);
            let corrupt_path = plugins_root.join(&corrupt_name);
            tracing::error!(
                "[plugin_host] state.json is corrupt ({err}). Backing up to {} and resetting to empty state",
                corrupt_path.display()
            );
            let _ = std::fs::rename(&state_path, &corrupt_path);
            PluginHostState::default()
        }
    }
}

pub fn write_state_unlocked(
    plugins_root: &Path,
    state: &PluginHostState,
) -> Result<(), AppCommandError> {
    if !plugins_root.exists() {
        std::fs::create_dir_all(plugins_root).map_err(|e| {
            AppCommandError::io_error(format!(
                "Failed to create plugins directory {}: {e}",
                plugins_root.display()
            ))
        })?;
    }

    let json_bytes = serde_json::to_vec_pretty(state).map_err(|e| {
        AppCommandError::invalid_input(format!("Failed to serialize state.json: {e}"))
    })?;

    let tmp_path = plugins_root.join(STATE_TMP_FILE_NAME);
    let state_path = plugins_root.join(STATE_FILE_NAME);

    let mut file = File::create(&tmp_path).map_err(|e| {
        AppCommandError::io_error(format!("Failed to create temp state file: {e}"))
    })?;
    file.write_all(&json_bytes).map_err(|e| {
        AppCommandError::io_error(format!("Failed to write temp state file: {e}"))
    })?;
    file.sync_all().map_err(|e| {
        AppCommandError::io_error(format!("Failed to fsync temp state file: {e}"))
    })?;
    drop(file);

    std::fs::rename(&tmp_path, &state_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        AppCommandError::io_error(format!("Failed to rename state.json.tmp to state.json: {e}"))
    })?;

    Ok(())
}

pub async fn load_state(plugins_root: &Path) -> PluginHostState {
    let _lock = STATE_LOCK.lock().await;
    read_state_unlocked(plugins_root)
}

pub async fn save_state(
    plugins_root: &Path,
    state: &PluginHostState,
) -> Result<(), AppCommandError> {
    let _lock = STATE_LOCK.lock().await;
    write_state_unlocked(plugins_root, state)
}

pub async fn mutate_state<F, R>(plugins_root: &Path, f: F) -> Result<R, AppCommandError>
where
    F: FnOnce(&mut PluginHostState) -> Result<R, AppCommandError>,
{
    let _lock = STATE_LOCK.lock().await;
    let mut state = read_state_unlocked(plugins_root);
    let result = f(&mut state)?;
    write_state_unlocked(plugins_root, &state)?;
    Ok(result)
}

pub async fn set_plugin_enabled(
    plugins_root: &Path,
    id: &str,
    enabled: bool,
) -> Result<(), AppCommandError> {
    mutate_state(plugins_root, |state| {
        let entry = state.plugins.entry(id.to_string()).or_default();
        entry.enabled = enabled;
        Ok(())
    })
    .await
}

pub async fn set_plugin_config(
    plugins_root: &Path,
    id: &str,
    values: BTreeMap<String, serde_json::Value>,
) -> Result<(), AppCommandError> {
    mutate_state(plugins_root, |state| {
        let entry = state.plugins.entry(id.to_string()).or_default();
        for (k, v) in values {
            entry.config.insert(k, v);
        }
        Ok(())
    })
    .await
}

pub async fn record_plugin_failure(
    plugins_root: &Path,
    id: &str,
) -> Result<(u32, bool), AppCommandError> {
    mutate_state(plugins_root, |state| {
        let entry = state.plugins.entry(id.to_string()).or_default();
        entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
        let auto_disabled = if entry.consecutive_failures >= 3 && entry.enabled {
            entry.enabled = false;
            true
        } else {
            false
        };
        Ok((entry.consecutive_failures, auto_disabled))
    })
    .await
}

pub async fn clear_plugin_failures(plugins_root: &Path, id: &str) -> Result<(), AppCommandError> {
    mutate_state(plugins_root, |state| {
        if let Some(entry) = state.plugins.get_mut(id) {
            entry.consecutive_failures = 0;
        }
        Ok(())
    })
    .await
}

pub async fn disable_all_plugins(plugins_root: &Path) -> Result<(), AppCommandError> {
    mutate_state(plugins_root, |state| {
        for entry in state.plugins.values_mut() {
            entry.enabled = false;
        }
        Ok(())
    })
    .await
}

pub async fn set_dev_mode(plugins_root: &Path, enabled: bool) -> Result<(), AppCommandError> {
    mutate_state(plugins_root, |state| {
        state.dev_mode = enabled;
        Ok(())
    })
    .await
}
