use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::paths::simplify_verbatim_path;
use super::manifest::{
    BackendStatus, ConfigSchema, PluginCategory, PluginManifest, PluginPermission, PluginSource,
    PluginStatus, ValidationFailureReason,
};
use super::state::{AppliedContributions, PluginHostState};
use super::{PLUGIN_HOST_API_VERSION, PLUGIN_HOST_VERSION};

pub const MANIFEST_FILE_NAME: &str = "codeg-plugin.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<PluginCategory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub permissions: Vec<PluginPermission>,
    pub enabled: bool,
    pub status: PluginStatus,
    pub problems: Vec<String>,
    pub source: PluginSource,
    pub builtin: bool,
    pub has_main: bool,
    pub styles: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_schema: Option<ConfigSchema>,
    pub has_backend: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<BackendStatus>,
    pub applied: AppliedContributions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListResult {
    pub host_version: String,
    pub api_version: u32,
    pub plugins_dir: String,
    pub safe_mode: bool,
    pub dev_mode: bool,
    pub plugins: Vec<PluginInfo>,
}

pub fn scan_plugins(
    plugins_root: &Path,
    state: &PluginHostState,
    safe_mode: bool,
) -> Vec<PluginInfo> {
    let mut plugins = Vec::new();

    let read_dir = match std::fs::read_dir(plugins_root) {
        Ok(rd) => rd,
        Err(_) => return plugins,
    };

    let mut entries = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = match entry.file_name().to_str() {
            Some(name) => name.to_string(),
            None => continue,
        };
        // Skip hidden directories (e.g. .staging, .trash, .git)
        if dir_name.starts_with('.') {
            continue;
        }
        entries.push((dir_name, path));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    for (dir_name, dir_path) in entries {
        let state_entry = state.plugins.get(&dir_name);
        let manifest_path = dir_path.join(MANIFEST_FILE_NAME);

        let source = state_entry
            .map(|s| s.source.clone())
            .unwrap_or(PluginSource::Manual);
        let builtin = matches!(source, PluginSource::Builtin);
        let applied = state_entry
            .map(|s| s.applied.clone())
            .unwrap_or_default();
        let consecutive_failures = state_entry.map(|s| s.consecutive_failures).unwrap_or(0);
        let effective_enabled = if safe_mode {
            false
        } else {
            state_entry.map(|s| s.enabled).unwrap_or(true)
        };

        if !manifest_path.exists() {
            plugins.push(PluginInfo {
                id: dir_name.clone(),
                name: dir_name.clone(),
                version: "0.0.0".to_string(),
                description: None,
                author: None,
                category: None,
                icon: None,
                permissions: Vec::new(),
                enabled: effective_enabled,
                status: PluginStatus::Invalid,
                problems: vec![format!("Missing {MANIFEST_FILE_NAME}")],
                source,
                builtin,
                has_main: false,
                styles: Vec::new(),
                config_schema: None,
                has_backend: false,
                backend: None,
                applied,
            });
            continue;
        }

        let raw_manifest = match std::fs::read_to_string(&manifest_path) {
            Ok(content) => content,
            Err(e) => {
                plugins.push(PluginInfo {
                    id: dir_name.clone(),
                    name: dir_name.clone(),
                    version: "0.0.0".to_string(),
                    description: None,
                    author: None,
                    category: None,
                    icon: None,
                    permissions: Vec::new(),
                    enabled: effective_enabled,
                    status: PluginStatus::Invalid,
                    problems: vec![format!("Could not read {MANIFEST_FILE_NAME}: {e}")],
                    source,
                    builtin,
                    has_main: false,
                    styles: Vec::new(),
                    config_schema: None,
                    has_backend: false,
                    backend: None,
                    applied,
                });
                continue;
            }
        };

        let manifest: PluginManifest = match serde_json::from_str(&raw_manifest) {
            Ok(m) => m,
            Err(e) => {
                plugins.push(PluginInfo {
                    id: dir_name.clone(),
                    name: dir_name.clone(),
                    version: "0.0.0".to_string(),
                    description: None,
                    author: None,
                    category: None,
                    icon: None,
                    permissions: Vec::new(),
                    enabled: effective_enabled,
                    status: PluginStatus::Invalid,
                    problems: vec![format!("Invalid JSON in {MANIFEST_FILE_NAME}: {e}")],
                    source,
                    builtin,
                    has_main: false,
                    styles: Vec::new(),
                    config_schema: None,
                    has_backend: false,
                    backend: None,
                    applied,
                });
                continue;
            }
        };

        let (status, problems) = match super::manifest::validate_manifest(&manifest, &dir_path) {
            Ok(()) => {
                if consecutive_failures >= 3 {
                    (
                        PluginStatus::Error,
                        vec![format!(
                            "Plugin auto-disabled due to {consecutive_failures} consecutive failures"
                        )],
                    )
                } else {
                    (PluginStatus::Ok, Vec::new())
                }
            }
            Err(failures) => {
                let has_incompatible = failures.iter().any(|f| matches!(f, ValidationFailureReason::Incompatible(_)));
                let problem_msgs = failures
                    .into_iter()
                    .map(|f| match f {
                        ValidationFailureReason::Invalid(m) => m,
                        ValidationFailureReason::Incompatible(m) => m,
                    })
                    .collect();
                if has_incompatible {
                    (PluginStatus::Incompatible, problem_msgs)
                } else {
                    (PluginStatus::Invalid, problem_msgs)
                }
            }
        };

        let has_main = manifest.main.is_some();
        let has_backend = manifest.backend.is_some();
        let backend = if has_backend {
            Some(super::backend::get_backend_status(&manifest.id))
        } else {
            None
        };

        plugins.push(PluginInfo {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            author: manifest.author,
            category: manifest.category,
            icon: manifest.icon,
            permissions: manifest.permissions,
            enabled: effective_enabled,
            status,
            problems,
            source,
            builtin,
            has_main,
            styles: manifest.styles,
            config_schema: manifest.config_schema,
            has_backend,
            backend,
            applied,
        });
    }

    plugins
}

pub fn build_plugin_list_result(
    plugins_root: &Path,
    state: &PluginHostState,
    safe_mode: bool,
) -> PluginListResult {
    let plugins = scan_plugins(plugins_root, state, safe_mode);
    let plugins_dir = simplify_verbatim_path(plugins_root)
        .to_string_lossy()
        .to_string();

    PluginListResult {
        host_version: PLUGIN_HOST_VERSION.to_string(),
        api_version: PLUGIN_HOST_API_VERSION,
        plugins_dir,
        safe_mode,
        dev_mode: state.dev_mode,
        plugins,
    }
}
