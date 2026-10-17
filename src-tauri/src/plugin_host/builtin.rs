use std::path::Path;

use include_dir::{include_dir, Dir};

use crate::app_error::AppCommandError;
use super::manifest::{PluginManifest, PluginSource};
use super::registry::MANIFEST_FILE_NAME;
use super::state::{mutate_state, PluginStateEntry};

pub static BUILTIN_PLUGINS_BUNDLE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/builtin-plugins");

pub async fn ensure_builtin_plugins_installed(
    plugins_root: &Path,
) -> Result<(), AppCommandError> {
    ensure_builtin_plugins_installed_from(&BUILTIN_PLUGINS_BUNDLE, plugins_root).await
}

pub async fn ensure_builtin_plugins_installed_from(
    bundle: &Dir<'_>,
    plugins_root: &Path,
) -> Result<(), AppCommandError> {
    if !plugins_root.exists() {
        std::fs::create_dir_all(plugins_root).map_err(|e| {
            AppCommandError::io_error(format!(
                "Failed to create plugins root directory {}: {e}",
                plugins_root.display()
            ))
        })?;
    }

    for plugin_dir in bundle.dirs() {
        let plugin_id = match plugin_dir.path().file_name().and_then(|s| s.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        let manifest_file = match plugin_dir.get_file(plugin_dir.path().join(MANIFEST_FILE_NAME)) {
            Some(f) => f,
            None => match plugin_dir.get_file(MANIFEST_FILE_NAME) {
                Some(f) => f,
                None => continue,
            },
        };

        let manifest_str = match manifest_file.contents_utf8() {
            Some(s) => s,
            None => continue,
        };

        let builtin_manifest: PluginManifest = match serde_json::from_str(manifest_str) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(
                    "[plugin_host] failed to parse builtin plugin manifest for '{}': {e}",
                    plugin_id
                );
                continue;
            }
        };

        let target_dir = plugins_root.join(&plugin_id);

        let should_extract = mutate_state(plugins_root, |state| {
            if let Some(existing) = state.plugins.get(&plugin_id) {
                // If the user installed this id from another source, do not overwrite
                if !matches!(existing.source, PluginSource::Builtin) {
                    return Ok(false);
                }
            }

            if !target_dir.exists() {
                let entry = state.plugins.entry(plugin_id.clone()).or_insert_with(|| {
                    PluginStateEntry {
                        enabled: true,
                        source: PluginSource::Builtin,
                        installed_version: Some(builtin_manifest.version.clone()),
                        ..Default::default()
                    }
                });
                entry.source = PluginSource::Builtin;
                entry.installed_version = Some(builtin_manifest.version.clone());
                return Ok(true);
            }

            // Target dir exists. Check disk manifest version
            let disk_manifest_path = target_dir.join(MANIFEST_FILE_NAME);
            let mut is_upgrade = false;
            if disk_manifest_path.exists() {
                if let Ok(content) = std::fs::read_to_string(&disk_manifest_path) {
                    if let Ok(disk_manifest) = serde_json::from_str::<PluginManifest>(&content) {
                        let builtin_semver = semver::Version::parse(&builtin_manifest.version);
                        let disk_semver = semver::Version::parse(&disk_manifest.version);
                        if let (Ok(bv), Ok(dv)) = (builtin_semver, disk_semver) {
                            if bv > dv {
                                is_upgrade = true;
                            }
                        }
                    }
                }
            } else {
                is_upgrade = true;
            }

            if is_upgrade {
                let entry = state.plugins.entry(plugin_id.clone()).or_default();
                entry.source = PluginSource::Builtin;
                entry.installed_version = Some(builtin_manifest.version.clone());
                Ok(true)
            } else {
                Ok(false)
            }
        })
        .await?;

        if should_extract {
            extract_bundle_dir(plugin_dir, plugin_dir.path(), &target_dir).map_err(|e| {
                AppCommandError::io_error(format!(
                    "Failed to extract builtin plugin '{}' to {}: {e}",
                    plugin_id,
                    target_dir.display()
                ))
            })?;
        }
    }

    Ok(())
}

fn extract_bundle_dir(dir: &Dir<'_>, base_path: &Path, target_root: &Path) -> std::io::Result<()> {
    for file in dir.files() {
        let rel = file.path().strip_prefix(base_path).unwrap_or(file.path());
        let dest = target_root.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&dest, file.contents())?;
    }
    for sub in dir.dirs() {
        extract_bundle_dir(sub, base_path, target_root)?;
    }
    Ok(())
}
