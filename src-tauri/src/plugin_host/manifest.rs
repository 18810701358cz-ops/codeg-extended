
pub fn parse_version_req(req_str: &str) -> Result<semver::VersionReq, semver::Error> {
    if let Ok(req) = semver::VersionReq::parse(req_str) {
        return Ok(req);
    }
    // Normalize npm-style spaces between constraints: ">=1.0.0 <2.0.0" -> ">=1.0.0, <2.0.0"
    let parts: Vec<&str> = req_str.split_whitespace().collect();
    if parts.len() > 1 {
        let comma_separated = parts.join(", ");
        if let Ok(req) = semver::VersionReq::parse(&comma_separated) {
            return Ok(req);
        }
    }
    semver::VersionReq::parse(req_str)
}

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use super::{PLUGIN_HOST_API_VERSION, PLUGIN_HOST_VERSION};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginCategory {
    Appearance,
    ModelProvider,
    Tools,
    Workflow,
    Utility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginPermission {
    Ui,
    Process,
    ModelProviders,
    Mcp,
    QuickMessages,
    Network,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginStatus {
    Ok,
    Invalid,
    Incompatible,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PluginSource {
    Builtin,
    Git {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit: Option<String>,
    },
    Upload {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_name: Option<String>,
    },
    #[default]
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendState {
    Stopped,
    Starting,
    Running,
    Unhealthy,
    Crashed,
    SetupFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub state: BackendState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub restarts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl Default for BackendStatus {
    fn default() -> Self {
        Self {
            state: BackendState::Stopped,
            pid: None,
            port: None,
            url: None,
            restarts: 0,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSchemaProperty {
    pub r#type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#enum: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSchema {
    pub r#type: String,
    #[serde(default)]
    pub properties: BTreeMap<String, ConfigSchemaProperty>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEngines {
    pub plugin_host: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBackendSetup {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBackendHealthcheck {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBackendConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<PluginBackendSetup>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub healthcheck: Option<PluginBackendHealthcheck>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginContributes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_providers: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quick_messages: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub engines: PluginEngines,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<PluginCategory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub permissions: Vec<PluginPermission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main: Option<String>,
    #[serde(default)]
    pub styles: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_schema: Option<ConfigSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<PluginBackendConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contributes: Option<PluginContributes>,
}

pub fn is_valid_plugin_id(id: &str) -> bool {
    let len = id.len();
    if !(2..=64).contains(&len) {
        return false;
    }
    let bytes = id.as_bytes();
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    for &b in &bytes[1..] {
        if !b.is_ascii_lowercase() && !b.is_ascii_digit() && b != b'-' {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationFailureReason {
    Invalid(String),
    Incompatible(String),
}

pub fn validate_manifest(
    manifest: &PluginManifest,
    plugin_dir: &Path,
) -> Result<(), Vec<ValidationFailureReason>> {
    let mut failures = Vec::new();

    // 1. ID format
    if !is_valid_plugin_id(&manifest.id) {
        failures.push(ValidationFailureReason::Invalid(format!(
            "Plugin id '{}' does not match format ^[a-z0-9][a-z0-9-]{{1,63}}$",
            manifest.id
        )));
    }

    // 2. ID matches directory name
    if let Some(dir_name) = plugin_dir.file_name().and_then(|s| s.to_str()) {
        if dir_name != manifest.id {
            failures.push(ValidationFailureReason::Invalid(format!(
                "Plugin directory name '{}' does not match id '{}'",
                dir_name, manifest.id
            )));
        }
    }

    // 3. Name non-empty
    if manifest.name.trim().is_empty() {
        failures.push(ValidationFailureReason::Invalid(
            "Plugin name cannot be empty".to_string(),
        ));
    }

    // 4. Semver
    if let Err(e) = semver::Version::parse(&manifest.version) {
        failures.push(ValidationFailureReason::Invalid(format!(
            "Invalid semver version '{}': {e}",
            manifest.version
        )));
    }

    // 5. apiVersion == 1
    if manifest.api_version != PLUGIN_HOST_API_VERSION {
        failures.push(ValidationFailureReason::Incompatible(format!(
            "Unsupported apiVersion {}: host requires {}",
            manifest.api_version, PLUGIN_HOST_API_VERSION
        )));
    }

    // 6. engines.pluginHost
    match parse_version_req(&manifest.engines.plugin_host) {
        Ok(req) => {
            let host_ver = semver::Version::parse(PLUGIN_HOST_VERSION)
                .expect("PLUGIN_HOST_VERSION must be valid semver");
            if !req.matches(&host_ver) {
                failures.push(ValidationFailureReason::Incompatible(format!(
                    "Host version {} does not satisfy engine requirement '{}'",
                    PLUGIN_HOST_VERSION, manifest.engines.plugin_host
                )));
            }
        }
        Err(e) => {
            failures.push(ValidationFailureReason::Incompatible(format!(
                "Invalid engines.pluginHost semver range '{}': {e}",
                manifest.engines.plugin_host
            )));
        }
    }

    // 7. main path
    if let Some(main_path) = &manifest.main {
        if let Err(err) = validate_relative_path(plugin_dir, main_path, "main") {
            failures.push(ValidationFailureReason::Invalid(err));
        }
    }

    // 8. styles paths
    for style_path in &manifest.styles {
        if let Err(err) = validate_relative_path(plugin_dir, style_path, "styles") {
            failures.push(ValidationFailureReason::Invalid(err));
        }
    }

    // 9. configSchema
    if let Some(schema) = &manifest.config_schema {
        if schema.r#type != "object" {
            failures.push(ValidationFailureReason::Invalid(format!(
                "configSchema.type must be 'object', got '{}'",
                schema.r#type
            )));
        }
        for (prop_key, prop) in &schema.properties {
            match prop.r#type.as_str() {
                "string" | "number" | "integer" | "boolean" => {}
                other => {
                    failures.push(ValidationFailureReason::Invalid(format!(
                        "configSchema property '{}' has unsupported type '{}'",
                        prop_key, other
                    )));
                }
            }
            if prop.r#enum.is_some() && prop.r#type != "string" {
                failures.push(ValidationFailureReason::Invalid(format!(
                    "configSchema property '{}' specifies enum but type is not 'string'",
                    prop_key
                )));
            }
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures)
    }
}

pub fn validate_relative_path(plugin_dir: &Path, rel_path: &str, field_name: &str) -> Result<(), String> {
    if rel_path.is_empty() {
        return Err(format!("{field_name} path cannot be empty"));
    }
    let p = Path::new(rel_path);
    if p.is_absolute() || rel_path.starts_with('/') || rel_path.starts_with('\\') {
        return Err(format!("{field_name} path '{rel_path}' must be relative"));
    }
    for comp in p.components() {
        match comp {
            std::path::Component::ParentDir => {
                return Err(format!(
                    "{field_name} path '{rel_path}' contains parent traversal '..'"
                ));
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err(format!("{field_name} path '{rel_path}' is not relative"));
            }
            _ => {}
        }
    }

    let joined = plugin_dir.join(p);
    let canonical_dir = match plugin_dir.canonicalize() {
        Ok(cd) => cd,
        Err(e) => return Err(format!("Cannot canonicalize plugin dir: {e}")),
    };
    let canonical_file = match joined.canonicalize() {
        Ok(cf) => cf,
        Err(e) => return Err(format!("{field_name} file '{rel_path}' does not exist: {e}")),
    };

    if !canonical_file.starts_with(&canonical_dir) {
        return Err(format!(
            "{field_name} file '{rel_path}' escapes plugin directory"
        ));
    }
    if !canonical_file.is_file() {
        return Err(format!("{field_name} path '{rel_path}' is not a regular file"));
    }

    Ok(())
}

/// Expands variables in `template` like `${varName}` or `${config.key}`.
/// Returns an error if any unknown variable is referenced.
pub fn expand_variables(
    template: &str,
    vars: &HashMap<String, String>,
) -> Result<String, AppCommandError> {
    let mut result = String::with_capacity(template.len());
    let mut chars = template.char_indices().peekable();

    while let Some((i, ch)) = chars.next() {
        if ch == '$' {
            if let Some(&(_, '{')) = chars.peek() {
                chars.next(); // consume '{'
                let var_start = i + 2;
                let mut found_close = false;
                let mut var_end = var_start;
                for (j, inner_ch) in chars.by_ref() {
                    if inner_ch == '}' {
                        var_end = j;
                        found_close = true;
                        break;
                    }
                }
                if !found_close {
                    return Err(AppCommandError::invalid_input(format!(
                        "Unclosed variable reference starting at position {i}"
                    )));
                }
                let var_name = &template[var_start..var_end];
                if let Some(val) = vars.get(var_name) {
                    result.push_str(val);
                } else {
                    return Err(AppCommandError::invalid_input(format!(
                        "Unknown variable '${{{var_name}}}' in template"
                    )));
                }
                continue;
            }
        }
        result.push(ch);
    }

    Ok(result)
}
