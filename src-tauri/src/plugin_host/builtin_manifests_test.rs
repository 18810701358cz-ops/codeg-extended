use std::fs;
use std::path::{Path, PathBuf};
use tempfile::tempdir;

use super::builtin::ensure_builtin_plugins_installed;
use super::manifest::{validate_manifest, PluginManifest, PluginSource};
use super::registry::MANIFEST_FILE_NAME;
use super::state::load_state;

fn builtin_plugins_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("builtin-plugins")
}

fn repo_plugins_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("parent of src-tauri should exist")
        .join("plugins")
}

#[test]
fn test_builtin_plugins_manifests_pass_validation() {
    let base = builtin_plugins_dir();
    assert!(base.exists(), "builtin-plugins directory must exist");

    let expected_builtins = ["dsh-cyber-glow", "dsh-compact-layout", "dsh-quick-actions"];

    for id in &expected_builtins {
        let plugin_dir = base.join(id);
        assert!(
            plugin_dir.exists(),
            "Builtin plugin directory '{id}' must exist at {}",
            plugin_dir.display()
        );

        let manifest_path = plugin_dir.join(MANIFEST_FILE_NAME);
        assert!(
            manifest_path.exists(),
            "Manifest file must exist at {}",
            manifest_path.display()
        );

        let content = fs::read_to_string(&manifest_path)
            .unwrap_or_else(|e| panic!("Failed to read {}: {e}", manifest_path.display()));
        let manifest: PluginManifest = serde_json::from_str(&content)
            .unwrap_or_else(|e| panic!("Failed to parse manifest for '{id}': {e}"));

        assert_eq!(&manifest.id, id, "Manifest id must match directory name");
        assert_eq!(manifest.api_version, 1, "apiVersion must be 1");

        let val_res = validate_manifest(&manifest, &plugin_dir);
        assert!(
            val_res.is_ok(),
            "Builtin plugin '{id}' failed manifest validation: {:?}",
            val_res.err()
        );
    }
}

#[test]
fn test_repo_plugins_manifests_pass_validation() {
    let base = repo_plugins_dir();
    assert!(base.exists(), "plugins directory must exist");

    let direct_plugins = ["workbuddy-connect", "prompt-pack"];

    for id in &direct_plugins {
        let plugin_dir = base.join(id);
        assert!(
            plugin_dir.exists(),
            "Plugin directory '{id}' must exist at {}",
            plugin_dir.display()
        );

        let manifest_path = plugin_dir.join(MANIFEST_FILE_NAME);
        assert!(
            manifest_path.exists(),
            "Manifest file must exist at {}",
            manifest_path.display()
        );

        let content = fs::read_to_string(&manifest_path)
            .unwrap_or_else(|e| panic!("Failed to read {}: {e}", manifest_path.display()));
        let manifest: PluginManifest = serde_json::from_str(&content)
            .unwrap_or_else(|e| panic!("Failed to parse manifest for '{id}': {e}"));

        assert_eq!(&manifest.id, id, "Manifest id must match directory name");
        assert_eq!(manifest.api_version, 1, "apiVersion must be 1");

        let val_res = validate_manifest(&manifest, &plugin_dir);
        assert!(
            val_res.is_ok(),
            "Plugin '{id}' failed manifest validation: {:?}",
            val_res.err()
        );
    }
}

#[test]
fn test_template_manifest_and_structure() {
    let base = repo_plugins_dir();
    let template_dir = base.join("_template");
    assert!(template_dir.exists(), "_template directory must exist");

    let manifest_path = template_dir.join(MANIFEST_FILE_NAME);
    assert!(
        manifest_path.exists(),
        "_template/codeg-plugin.json must exist"
    );

    let content = fs::read_to_string(&manifest_path)
        .unwrap_or_else(|e| panic!("Failed to read {}: {e}", manifest_path.display()));
    let manifest: PluginManifest = serde_json::from_str(&content)
        .unwrap_or_else(|e| panic!("Failed to parse _template manifest: {e}"));

    assert_eq!(manifest.api_version, 1, "apiVersion must be 1");

    // Copy _template to a temporary directory named with manifest.id to test instantiation
    let tmp = tempdir().unwrap();
    let instance_dir = tmp.path().join(&manifest.id);
    fs::create_dir_all(&instance_dir).unwrap();

    copy_dir_recursive(&template_dir, &instance_dir).unwrap();

    let val_res = validate_manifest(&manifest, &instance_dir);
    assert!(
        val_res.is_ok(),
        "_template failed manifest validation when instantiated: {:?}",
        val_res.err()
    );
}

#[tokio::test]
async fn test_builtin_plugins_default_disabled() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();

    ensure_builtin_plugins_installed(root).await.unwrap();

    let state = load_state(root).await;
    let expected_builtins = ["dsh-cyber-glow", "dsh-compact-layout", "dsh-quick-actions"];

    for id in &expected_builtins {
        let entry = state
            .plugins
            .get(*id)
            .unwrap_or_else(|| panic!("Built-in plugin '{id}' not found in state after install"));
        assert!(
            !entry.enabled,
            "Built-in plugin '{id}' must be disabled by default (enabled: false)"
        );
        assert_eq!(
            entry.source,
            PluginSource::Builtin,
            "Built-in plugin '{id}' must have PluginSource::Builtin"
        );
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ft.is_dir() {
            fs::create_dir_all(&target)?;
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
