use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;

use tempfile::tempdir;

use super::manifest::{
    expand_variables, is_valid_plugin_id, validate_manifest, ConfigSchema,
    ConfigSchemaProperty, PluginBackendConfig, PluginCategory, PluginEngines, PluginManifest,
    PluginPermission, PluginSource, PluginStatus,
};
use super::registry::{scan_plugins, MANIFEST_FILE_NAME};
use super::state::{
    clear_plugin_failures, disable_all_plugins, load_state, record_plugin_failure,
    set_plugin_enabled, write_state_unlocked, PluginHostState, PluginStateEntry,
};
use crate::commands::plugin_host::{
    plugin_host_get_config_core, plugin_host_read_asset_core, plugin_host_read_entry_core,
    plugin_host_report_activated_core, plugin_host_report_error_core,
    plugin_host_set_config_core, plugin_host_set_enabled_core, safe_resolve_plugin_file,
    ASSET_MAX_BYTES, ENTRY_MAX_BYTES,
};
use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};

fn sample_manifest(id: &str) -> PluginManifest {
    PluginManifest {
        id: id.to_string(),
        name: format!("Plugin {id}"),
        version: "1.0.0".to_string(),
        api_version: 1,
        engines: PluginEngines {
            plugin_host: ">=1.0.0 <2.0.0".to_string(),
        },
        description: Some("A test plugin".to_string()),
        author: Some("tester".to_string()),
        category: Some(PluginCategory::Tools),
        icon: Some("icon.png".to_string()),
        permissions: vec![PluginPermission::Ui, PluginPermission::Network],
        main: Some("dist/index.js".to_string()),
        styles: vec!["styles.css".to_string()],
        config_schema: Some(ConfigSchema {
            r#type: "object".to_string(),
            properties: BTreeMap::from([
                (
                    "apiKey".to_string(),
                    ConfigSchemaProperty {
                        r#type: "string".to_string(),
                        title: Some("API Key".to_string()),
                        description: None,
                        default: None,
                        r#enum: None,
                        format: Some("secret".to_string()),
                    },
                ),
                (
                    "endpoint".to_string(),
                    ConfigSchemaProperty {
                        r#type: "string".to_string(),
                        title: Some("Endpoint".to_string()),
                        description: None,
                        default: Some(serde_json::json!("https://api.example.com")),
                        r#enum: None,
                        format: None,
                    },
                ),
            ]),
            required: Some(vec!["endpoint".to_string()]),
        }),
        backend: Some(PluginBackendConfig {
            command: "python".to_string(),
            args: vec!["server.py".to_string()],
            setup: None,
            env: BTreeMap::new(),
            port: Some(serde_json::json!(18080)),
            healthcheck: None,
            restart: Some("on-failure".to_string()),
        }),
        contributes: None,
    }
}

fn create_plugin_dir(parent: &Path, id: &str, manifest: &PluginManifest) -> std::path::PathBuf {
    let dir = parent.join(id);
    fs::create_dir_all(&dir).unwrap();

    let manifest_json = serde_json::to_string_pretty(manifest).unwrap();
    fs::write(dir.join(MANIFEST_FILE_NAME), manifest_json).unwrap();

    if let Some(main) = &manifest.main {
        let main_path = dir.join(main);
        if let Some(p) = main_path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(main_path, "export function activate() {}").unwrap();
    }

    for style in &manifest.styles {
        let style_path = dir.join(style);
        if let Some(p) = style_path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(style_path, "body { color: red; }").unwrap();
    }

    dir
}

// ─── Manifest & ID Tests ──────────────────────────────────────────────────────

#[test]
fn test_plugin_id_validation() {
    assert!(is_valid_plugin_id("my-plugin"));
    assert!(is_valid_plugin_id("plugin123"));
    assert!(is_valid_plugin_id("ab"));
    assert!(is_valid_plugin_id("workbuddy-connect"));

    assert!(!is_valid_plugin_id("")); // empty
    assert!(!is_valid_plugin_id("a")); // too short (len < 2)
    assert!(!is_valid_plugin_id(&"a".repeat(65))); // too long (len > 64)
    assert!(!is_valid_plugin_id("-lead")); // starts with hyphen
    assert!(!is_valid_plugin_id("Upper")); // uppercase
    assert!(!is_valid_plugin_id("has space")); // space
    assert!(!is_valid_plugin_id("has_underscore")); // underscore
    assert!(!is_valid_plugin_id("bad/slash")); // slash
}

#[test]
fn test_manifest_validation_success() {
    let tmp = tempdir().unwrap();
    let manifest = sample_manifest("test-plugin");
    let plugin_dir = create_plugin_dir(tmp.path(), "test-plugin", &manifest);

    let res = validate_manifest(&manifest, &plugin_dir);
    assert!(res.is_ok(), "validation should pass, got: {:?}", res.err());
}

#[test]
fn test_manifest_id_directory_mismatch() {
    let tmp = tempdir().unwrap();
    let manifest = sample_manifest("plugin-a");
    let plugin_dir = create_plugin_dir(tmp.path(), "plugin-b", &manifest);

    let res = validate_manifest(&manifest, &plugin_dir);
    assert!(res.is_err());
    let errs = res.unwrap_err();
    assert!(errs
        .iter()
        .any(|e| format!("{e:?}").contains("does not match id")));
}

#[test]
fn test_manifest_incompatible_api_version() {
    let tmp = tempdir().unwrap();
    let mut manifest = sample_manifest("test-plugin");
    manifest.api_version = 2; // host only supports 1
    let plugin_dir = create_plugin_dir(tmp.path(), "test-plugin", &manifest);

    let res = validate_manifest(&manifest, &plugin_dir);
    assert!(res.is_err());
    let errs = res.unwrap_err();
    assert!(errs
        .iter()
        .any(|e| format!("{e:?}").contains("Unsupported apiVersion")));
}

#[test]
fn test_manifest_incompatible_engine_version() {
    let tmp = tempdir().unwrap();
    let mut manifest = sample_manifest("test-plugin");
    manifest.engines.plugin_host = ">=2.0.0".to_string(); // host is 1.0.0
    let plugin_dir = create_plugin_dir(tmp.path(), "test-plugin", &manifest);

    let res = validate_manifest(&manifest, &plugin_dir);
    assert!(res.is_err());
    let errs = res.unwrap_err();
    assert!(errs
        .iter()
        .any(|e| format!("{e:?}").contains("does not satisfy engine requirement")));
}

#[test]
fn test_manifest_main_path_traversal_rejected() {
    let tmp = tempdir().unwrap();
    let mut manifest = sample_manifest("test-plugin");
    manifest.main = Some("../secret.js".to_string());
    let plugin_dir = create_plugin_dir(tmp.path(), "test-plugin", &manifest);

    let res = validate_manifest(&manifest, &plugin_dir);
    assert!(res.is_err());
    let errs = res.unwrap_err();
    assert!(errs
        .iter()
        .any(|e| format!("{e:?}").contains("parent traversal")));
}

#[test]
fn test_manifest_styles_missing_file_rejected() {
    let tmp = tempdir().unwrap();
    let mut manifest = sample_manifest("test-plugin");
    manifest.styles = vec!["nonexistent.css".to_string()];
    let plugin_dir = create_plugin_dir(tmp.path(), "test-plugin", &manifest);
    // remove the auto-created file if any
    let _ = fs::remove_file(plugin_dir.join("nonexistent.css"));

    let res = validate_manifest(&manifest, &plugin_dir);
    assert!(res.is_err());
    let errs = res.unwrap_err();
    assert!(errs
        .iter()
        .any(|e| format!("{e:?}").contains("does not exist")));
}

#[test]
fn test_manifest_config_schema_validation() {
    let tmp = tempdir().unwrap();
    let mut manifest = sample_manifest("test-plugin");
    if let Some(schema) = &mut manifest.config_schema {
        schema.properties.insert(
            "badProp".to_string(),
            ConfigSchemaProperty {
                r#type: "array".to_string(), // unsupported type
                title: None,
                description: None,
                default: None,
                r#enum: None,
                format: None,
            },
        );
    }
    let plugin_dir = create_plugin_dir(tmp.path(), "test-plugin", &manifest);

    let res = validate_manifest(&manifest, &plugin_dir);
    assert!(res.is_err());
    let errs = res.unwrap_err();
    assert!(errs
        .iter()
        .any(|e| format!("{e:?}").contains("unsupported type")));
}

// ─── Variable Expansion Tests ─────────────────────────────────────────────────

#[test]
fn test_expand_variables_success() {
    let vars = HashMap::from([
        ("pluginDir".to_string(), "/plugins/my-plugin".to_string()),
        ("port".to_string(), "18080".to_string()),
        ("config.auth".to_string(), "token123".to_string()),
    ]);

    let template = "http://127.0.0.1:${port}/api?dir=${pluginDir}&auth=${config.auth}";
    let expanded = expand_variables(template, &vars).unwrap();
    assert_eq!(
        expanded,
        "http://127.0.0.1:18080/api?dir=/plugins/my-plugin&auth=token123"
    );
}

#[test]
fn test_expand_variables_unknown_var_fails() {
    let vars = HashMap::from([("port".to_string(), "18080".to_string())]);
    let template = "http://127.0.0.1:${port}/${unknown}";
    let res = expand_variables(template, &vars);
    assert!(res.is_err());
    let err = res.unwrap_err();
    assert!(err.message.contains("Unknown variable '${unknown}'"));
}

#[test]
fn test_expand_variables_unclosed_brace_fails() {
    let vars = HashMap::new();
    let template = "hello ${unclosed";
    let res = expand_variables(template, &vars);
    assert!(res.is_err());
    let err = res.unwrap_err();
    assert!(err.message.contains("Unclosed variable reference"));
}

// ─── State Persistence & Corrupt Recovery Tests ───────────────────────────────

#[tokio::test]
async fn test_state_atomic_write_and_reload() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();

    let mut state = PluginHostState::default();
    state.plugins.insert(
        "test-plugin".to_string(),
        PluginStateEntry {
            enabled: true,
            source: PluginSource::Builtin,
            installed_version: Some("1.0.0".to_string()),
            ..Default::default()
        },
    );

    write_state_unlocked(root, &state).unwrap();

    assert!(root.join("state.json").exists());
    assert!(!root.join("state.json.tmp").exists());

    let loaded = load_state(root).await;
    assert_eq!(loaded.plugins.len(), 1);
    assert!(loaded.plugins.get("test-plugin").unwrap().enabled);
}

#[tokio::test]
async fn test_state_corrupt_recovery() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();

    // Write malformed JSON into state.json
    fs::write(root.join("state.json"), "{ invalid json syntax !!").unwrap();

    let loaded = load_state(root).await;
    // Should reset to default empty state and not crash
    assert_eq!(loaded.plugins.len(), 0);

    // Corrupt file should be backed up
    let entries = fs::read_dir(root).unwrap();
    let corrupt_found = entries.flatten().any(|e| {
        e.file_name()
            .to_string_lossy()
            .starts_with("state.json.corrupt-")
    });
    assert!(corrupt_found, "Corrupt state file was not backed up");
}

#[tokio::test]
async fn test_state_consecutive_failures_auto_disable() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();

    let (f1, auto1) = record_plugin_failure(root, "bad-plugin").await.unwrap();
    assert_eq!(f1, 1);
    assert!(!auto1);

    let (f2, auto2) = record_plugin_failure(root, "bad-plugin").await.unwrap();
    assert_eq!(f2, 2);
    assert!(!auto2);

    let (f3, auto3) = record_plugin_failure(root, "bad-plugin").await.unwrap();
    assert_eq!(f3, 3);
    assert!(auto3); // 3rd failure auto-disables

    let state = load_state(root).await;
    let entry = state.plugins.get("bad-plugin").unwrap();
    assert!(!entry.enabled);
    assert_eq!(entry.consecutive_failures, 3);

    // Resetting failures
    clear_plugin_failures(root, "bad-plugin").await.unwrap();
    let state = load_state(root).await;
    assert_eq!(state.plugins.get("bad-plugin").unwrap().consecutive_failures, 0);
}

#[tokio::test]
async fn test_state_disable_all() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();

    set_plugin_enabled(root, "p1", true).await.unwrap();
    set_plugin_enabled(root, "p2", true).await.unwrap();

    disable_all_plugins(root).await.unwrap();

    let state = load_state(root).await;
    assert!(!state.plugins.get("p1").unwrap().enabled);
    assert!(!state.plugins.get("p2").unwrap().enabled);
}

// ─── Registry Scanning Tests ──────────────────────────────────────────────────

#[test]
fn test_scan_plugins_various_statuses() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();

    // 1. Valid plugin
    let p_ok = sample_manifest("plugin-ok");
    create_plugin_dir(root, "plugin-ok", &p_ok);

    // 2. Missing manifest
    let p_invalid_dir = root.join("plugin-no-manifest");
    fs::create_dir_all(&p_invalid_dir).unwrap();

    // 3. Incompatible plugin
    let mut p_incompat = sample_manifest("plugin-incompat");
    p_incompat.engines.plugin_host = ">=3.0.0".to_string();
    create_plugin_dir(root, "plugin-incompat", &p_incompat);

    // 4. Staging hidden directory (should be skipped)
    let staging = root.join(".staging");
    fs::create_dir_all(&staging).unwrap();

    let mut state = PluginHostState::default();
    state.plugins.insert(
        "plugin-ok".to_string(),
        PluginStateEntry {
            enabled: true,
            consecutive_failures: 0,
            ..Default::default()
        },
    );

    let plugins = scan_plugins(root, &state, false);
    assert_eq!(plugins.len(), 3); // skips .staging

    let info_ok = plugins.iter().find(|p| p.id == "plugin-ok").unwrap();
    assert_eq!(info_ok.status, PluginStatus::Ok);

    let info_missing = plugins.iter().find(|p| p.id == "plugin-no-manifest").unwrap();
    assert_eq!(info_missing.status, PluginStatus::Invalid);

    let info_incompat = plugins.iter().find(|p| p.id == "plugin-incompat").unwrap();
    assert_eq!(info_incompat.status, PluginStatus::Incompatible);
}

#[test]
fn test_scan_plugins_safe_mode_disables_all() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();

    let p_ok = sample_manifest("plugin-ok");
    create_plugin_dir(root, "plugin-ok", &p_ok);

    let mut state = PluginHostState::default();
    state.plugins.insert(
        "plugin-ok".to_string(),
        PluginStateEntry {
            enabled: true,
            ..Default::default()
        },
    );

    let plugins = scan_plugins(root, &state, true); // safe_mode = true
    assert!(!plugins[0].enabled);
}

// ─── File Resolution & Path Traversal Security Tests ──────────────────────────

#[test]
fn test_safe_resolve_plugin_file_security() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();
    let p = sample_manifest("sec-plugin");
    let plugin_dir = create_plugin_dir(root, "sec-plugin", &p);

    let asset_path = plugin_dir.join("asset.txt");
    fs::write(&asset_path, "hello asset").unwrap();

    // Normal access works
    let resolved = safe_resolve_plugin_file(&plugin_dir, "asset.txt", ASSET_MAX_BYTES);
    assert!(resolved.is_ok());

    // Path traversal parent rejected
    let traversal = safe_resolve_plugin_file(&plugin_dir, "../outside.txt", ASSET_MAX_BYTES);
    assert!(traversal.is_err());

    // Absolute path rejected
    let abs = safe_resolve_plugin_file(&plugin_dir, "/etc/passwd", ASSET_MAX_BYTES);
    assert!(abs.is_err());

    // Symlink pointing outside plugin directory rejected
    let outside_file = root.join("secret_outside.txt");
    fs::write(&outside_file, "super secret").unwrap();

    let symlink_path = plugin_dir.join("symlink_outside.txt");
    #[cfg(windows)]
    let symlink_created = std::os::windows::fs::symlink_file(&outside_file, &symlink_path).is_ok();
    #[cfg(unix)]
    let symlink_created = std::os::unix::fs::symlink(&outside_file, &symlink_path).is_ok();

    if symlink_created {
        let sym_res =
            safe_resolve_plugin_file(&plugin_dir, "symlink_outside.txt", ASSET_MAX_BYTES);
        assert!(
            sym_res.is_err(),
            "Symlink escaping plugin dir must be rejected"
        );
    }
}

#[tokio::test]
async fn test_read_entry_and_asset() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();
    let p = sample_manifest("test-read");
    let plugin_dir = create_plugin_dir(root, "test-read", &p);

    // Read entry
    let entry = plugin_host_read_entry_core(root, "test-read").await.unwrap();
    assert_eq!(entry.code, "export function activate() {}");
    assert!(!entry.hash.is_empty());

    // Read asset
    fs::write(plugin_dir.join("image.png"), b"\x89PNG\r\n\x1a\nfakeimage").unwrap();
    let asset = plugin_host_read_asset_core(root, "test-read", "image.png")
        .await
        .unwrap();
    assert_eq!(asset.mime, "image/png");
    assert!(!asset.base64.is_empty());
}

#[tokio::test]
async fn test_read_entry_size_limit() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();
    let mut p = sample_manifest("test-big");
    p.main = Some("dist/big.js".to_string());
    let plugin_dir = create_plugin_dir(root, "test-big", &p);

    // Write file larger than 5 MiB
    let big_data = vec![b'a'; (ENTRY_MAX_BYTES + 1024) as usize];
    fs::write(plugin_dir.join("dist/big.js"), big_data).unwrap();

    let res = plugin_host_read_entry_core(root, "test-big").await;
    assert!(res.is_err());
    assert!(res.unwrap_err().message.contains("exceeds maximum size"));
}

// ─── Config & Secret Keyring Tests ───────────────────────────────────────────

#[tokio::test]
async fn test_plugin_config_and_secrets() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();
    let p = sample_manifest("test-config");
    create_plugin_dir(root, "test-config", &p);

    let emitter = EventEmitter::test_web_only(std::sync::Arc::new(WebEventBroadcaster::new()));

    // Set config with secret and non-secret
    let values = BTreeMap::from([
        ("endpoint".to_string(), serde_json::json!("https://custom.api")),
        ("apiKey".to_string(), serde_json::json!("super-secret-key")),
    ]);
    let secrets = Some(BTreeMap::from([(
        "apiKey".to_string(),
        Some("super-secret-key".to_string()),
    )]));

    let config = plugin_host_set_config_core(&emitter, root, "test-config", values, secrets)
        .await
        .unwrap();

    // Values must NOT contain secret apiKey
    assert_eq!(
        config.values.get("endpoint"),
        Some(&serde_json::json!("https://custom.api"))
    );
    assert!(!config.values.contains_key("apiKey"));
    assert!(config.secrets_set.contains(&"apiKey".to_string()));

    // get_config must return the same stripped values
    let fetched = plugin_host_get_config_core(root, "test-config")
        .await
        .unwrap();
    assert_eq!(
        fetched.values.get("endpoint"),
        Some(&serde_json::json!("https://custom.api"))
    );
    assert!(!fetched.values.contains_key("apiKey"));
    assert!(fetched.secrets_set.contains(&"apiKey".to_string()));

    // Deleting secret by passing None
    let del_secrets = Some(BTreeMap::from([("apiKey".to_string(), None)]));
    let after_del = plugin_host_set_config_core(
        &emitter,
        root,
        "test-config",
        BTreeMap::new(),
        del_secrets,
    )
    .await
    .unwrap();
    assert!(!after_del.secrets_set.contains(&"apiKey".to_string()));
}

#[tokio::test]
async fn test_plugin_commands_lifecycle_and_errors() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();
    let p = sample_manifest("test-cmds");
    create_plugin_dir(root, "test-cmds", &p);

    let broadcaster = std::sync::Arc::new(WebEventBroadcaster::new());
    let emitter = EventEmitter::test_web_only(broadcaster);

    // Set enabled
    let info = plugin_host_set_enabled_core(&emitter, root, "test-cmds", true)
        .await
        .unwrap();
    assert!(info.enabled);

    // Report error: 1st
    let r1 = plugin_host_report_error_core(&emitter, root, "test-cmds", "runtime", "first fail")
        .await
        .unwrap();
    assert!(!r1.auto_disabled);

    // Report error: 2nd
    let r2 = plugin_host_report_error_core(&emitter, root, "test-cmds", "runtime", "second fail")
        .await
        .unwrap();
    assert!(!r2.auto_disabled);

    // Report error: 3rd -> auto disabled
    let r3 = plugin_host_report_error_core(&emitter, root, "test-cmds", "runtime", "third fail")
        .await
        .unwrap();
    assert!(r3.auto_disabled);

    // Verify disabled
    let state = load_state(root).await;
    assert!(!state.plugins.get("test-cmds").unwrap().enabled);

    // Report activated clears failures
    plugin_host_report_activated_core(root, "test-cmds").await.unwrap();
    let state2 = load_state(root).await;
    assert_eq!(state2.plugins.get("test-cmds").unwrap().consecutive_failures, 0);
}

#[tokio::test]
async fn test_builtin_plugins_installation() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();

    // Call builtin installation on empty root; should succeed without error
    super::builtin::ensure_builtin_plugins_installed(root).await.unwrap();
}
