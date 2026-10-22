use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde_json::Value;

use crate::app_error::AppCommandError;
use crate::commands::mcp::{mcp_remove_server, mcp_upsert_local_server, McpAppType};
use crate::commands::model_provider::{
    create_model_provider_core, delete_model_provider_core, update_model_provider_core,
};
use crate::db::service::{model_provider_service, quick_message_service};
use crate::db::AppDatabase;
use crate::paths::codeg_home_dir;
use crate::web::event_bridge::EventEmitter;

use super::backend::get_backend_status;
use super::manifest::{PluginManifest, PluginPermission};
use super::runtime_resolve::{expand_json_value, expand_string, VariableContext};
use super::state::{load_state, mutate_state, AppliedContributions};

static CUSTOM_DB: LazyLock<tokio::sync::RwLock<Option<AppDatabase>>> =
    LazyLock::new(|| tokio::sync::RwLock::new(None));

/// Injects a database handle (used by unit tests to supply an in-memory database).
pub async fn set_custom_database(db: AppDatabase) {
    let mut lock = CUSTOM_DB.write().await;
    *lock = Some(db);
}

/// Retrieves or connects to the application database.
pub async fn get_database() -> Result<AppDatabase, AppCommandError> {
    {
        let lock = CUSTOM_DB.read().await;
        if let Some(db) = &*lock {
            return Ok(AppDatabase {
                conn: db.conn.clone(),
            });
        }
    }

    let data_dir = std::env::var("CODEG_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| codeg_home_dir());
    let db_path = data_dir.join(crate::db::database_file_name());
    let db_url = format!(
        "sqlite:{}?mode=rwc",
        urlencoding::encode(&db_path.to_string_lossy())
    );
    let mut opt = sea_orm::ConnectOptions::new(db_url);
    opt.max_connections(5)
        .min_connections(1)
        .connect_timeout(std::time::Duration::from_secs(5));
    let conn = sea_orm::Database::connect(opt)
        .await
        .map_err(|e| AppCommandError::database_error(format!("Failed to connect to database: {e}")))?;
    let db = AppDatabase { conn };
    let mut lock = CUSTOM_DB.write().await;
    *lock = Some(AppDatabase {
        conn: db.conn.clone(),
    });
    Ok(db)
}

/// Applies all declarative contributions defined in `manifest.contributes`.
///
/// Strictly enforces permission declarations:
/// - `contributes.model_providers` requires `permissions: ["modelProviders"]`
/// - `contributes.mcp_servers` requires `permissions: ["mcp"]`
/// - `contributes.quick_messages` requires `permissions: ["quickMessages"]`
pub async fn apply_contributions(
    plugins_root: &Path,
    id: &str,
    manifest: &PluginManifest,
) -> Result<AppliedContributions, AppCommandError> {
    let contributes = match &manifest.contributes {
        Some(c) => c,
        None => return Ok(AppliedContributions::default()),
    };

    let plugin_dir = plugins_root.join(id);
    let data_dir = std::env::var("CODEG_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| codeg_home_dir());

    let state = load_state(plugins_root).await;
    let config_values = state
        .plugins
        .get(id)
        .map(|e| e.config.clone())
        .unwrap_or_default();

    let backend_status = get_backend_status(id);
    let token = crate::plugin_host::secrets::get_secret(&format!("plugin:{id}:token"))
        .ok()
        .flatten();

    let ctx = VariableContext {
        plugin_dir: &plugin_dir,
        data_dir: &data_dir,
        port: backend_status.port,
        token: token.as_deref(),
        config: &config_values,
        plugin_id: Some(id),
    };

    let mut applied = state
        .plugins
        .get(id)
        .map(|e| e.applied.clone())
        .unwrap_or_default();

    // 1. Model Providers
    if let Some(providers) = &contributes.model_providers {
        if !manifest.permissions.contains(&PluginPermission::ModelProviders) {
            tracing::error!(
                "[plugin_host] plugin '{id}' defined modelProviders contributions without 'modelProviders' permission; rejected"
            );
        } else {
            let db = get_database().await?;
            apply_model_providers(&db, id, providers, &ctx, &mut applied).await?;
        }
    }

    // 2. MCP Servers
    if let Some(mcp_spec) = &contributes.mcp_servers {
        if !manifest.permissions.contains(&PluginPermission::Mcp) {
            tracing::error!(
                "[plugin_host] plugin '{id}' defined mcpServers contributions without 'mcp' permission; rejected"
            );
        } else {
            apply_mcp_servers(id, mcp_spec, &ctx, &mut applied).await?;
        }
    }

    // 3. Quick Messages
    if let Some(quick_msgs) = &contributes.quick_messages {
        if !manifest.permissions.contains(&PluginPermission::QuickMessages) {
            tracing::error!(
                "[plugin_host] plugin '{id}' defined quickMessages contributions without 'quickMessages' permission; rejected"
            );
        } else {
            let db = get_database().await?;
            apply_quick_messages(&db, quick_msgs, &ctx, &mut applied).await?;
        }
    }

    let applied_clone = applied.clone();
    mutate_state(plugins_root, |s| {
        let entry = s.plugins.entry(id.to_string()).or_default();
        entry.applied = applied_clone;
        Ok(())
    })
    .await?;

    Ok(applied)
}

async fn apply_model_providers(
    db: &AppDatabase,
    plugin_id: &str,
    providers: &[Value],
    ctx: &VariableContext<'_>,
    applied: &mut AppliedContributions,
) -> Result<(), AppCommandError> {
    for item in providers {
        let key = item
            .get("key")
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string();

        let name = expand_string(
            item.get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(plugin_id),
            ctx,
        );

        let api_url = expand_string(
            item.get("apiUrl")
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
            ctx,
        );

        let api_key = expand_string(
            item.get("apiKey")
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
            ctx,
        );

        let model = item
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| expand_string(s, ctx));

        let agent_types: Vec<String> = item
            .get("agentTypes")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let existing_ids = applied.model_providers.entry(key.clone()).or_default();

        // Check if existing records are still valid in DB
        let mut valid_ids = Vec::new();
        for &id in existing_ids.iter() {
            if let Ok(Some(existing_row)) = model_provider_service::get_by_id(&db.conn, id as i32).await {
                // If api_url changed (e.g. port changed), update it
                if existing_row.api_url != api_url {
                    let _ = update_model_provider_core(
                        db,
                        id as i32,
                        Some(name.clone()),
                        Some(api_url.clone()),
                        Some(api_key.clone()),
                        None,
                        model.clone(),
                        &EventEmitter::Noop,
                    )
                    .await;
                }
                valid_ids.push(id);
            }
        }

        // If not registered yet or missing from DB, create for each agent_type
        if valid_ids.is_empty() {
            for at in agent_types {
                match create_model_provider_core(
                    db,
                    name.clone(),
                    api_url.clone(),
                    api_key.clone(),
                    at,
                    model.clone(),
                )
                .await
                {
                    Ok(created) => {
                        valid_ids.push(created.id as i64);
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[plugin_host] failed to register model provider for '{plugin_id}': {e}"
                        );
                    }
                }
            }
        }

        *existing_ids = valid_ids;
    }

    Ok(())
}

async fn apply_mcp_servers(
    plugin_id: &str,
    mcp_spec: &Value,
    ctx: &VariableContext<'_>,
    applied: &mut AppliedContributions,
) -> Result<(), AppCommandError> {
    // Spec can be an object mapping key -> server config, or a single config
    let servers: BTreeMap<String, Value> = if let Some(map) = mcp_spec.as_object() {
        map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    } else {
        let mut m = BTreeMap::new();
        m.insert("default".to_string(), mcp_spec.clone());
        m
    };

    for (key, spec_val) in servers {
        let server_id = format!("plugin-{plugin_id}-{key}");
        let expanded_spec = expand_json_value(&spec_val, ctx);

        let apps: Vec<McpAppType> = expanded_spec
            .get("apps")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| serde_json::from_value::<McpAppType>(item.clone()).ok())
                    .collect()
            })
            .unwrap_or_else(|| {
                vec![
                    McpAppType::ClaudeCode,
                    McpAppType::Codex,
                    McpAppType::OpenCode,
                ]
            });

        match mcp_upsert_local_server(server_id.clone(), expanded_spec, apps, None).await {
            Ok(_) => {
                let list = applied.mcp_servers.entry(key).or_default();
                if !list.contains(&server_id) {
                    list.push(server_id);
                }
            }
            Err(e) => {
                tracing::warn!(
                    "[plugin_host] failed to register MCP server '{server_id}': {e}"
                );
            }
        }
    }

    Ok(())
}

async fn apply_quick_messages(
    db: &AppDatabase,
    quick_msgs: &[Value],
    ctx: &VariableContext<'_>,
    applied: &mut AppliedContributions,
) -> Result<(), AppCommandError> {
    for (idx, item) in quick_msgs.iter().enumerate() {
        let key = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or(&idx.to_string())
            .to_string();

        let title = expand_string(
            item.get("title").and_then(|v| v.as_str()).unwrap_or(""),
            ctx,
        );
        let content = expand_string(
            item.get("content").and_then(|v| v.as_str()).unwrap_or(""),
            ctx,
        );

        if title.is_empty() || content.is_empty() {
            continue;
        }

        let existing_ids = applied.quick_messages.entry(key.clone()).or_default();
        if existing_ids.is_empty() {
            match quick_message_service::create(&db.conn, &title, &content).await {
                Ok(created) => {
                    existing_ids.push(created.id as i64);
                }
                Err(e) => {
                    tracing::warn!("[plugin_host] failed to create quick message: {e}");
                }
            }
        }
    }

    Ok(())
}

/// Removes all contributions recorded in `applied`.
///
/// Invoked on uninstall when `remove_contributions` is true.
pub async fn remove_contributions(
    plugins_root: &Path,
    id: &str,
) -> Result<(), AppCommandError> {
    let state = load_state(plugins_root).await;
    let Some(entry) = state.plugins.get(id) else {
        return Ok(());
    };

    let applied = entry.applied.clone();
    let db = get_database().await?;

    // 1. Remove model providers
    for ids in applied.model_providers.values() {
        for &prov_id in ids {
            if let Err(e) = delete_model_provider_core(&db, prov_id as i32).await {
                tracing::warn!(
                    "[plugin_host] could not delete model provider {prov_id} for '{id}': {e}"
                );
            }
        }
    }

    // 2. Remove MCP servers
    for servers in applied.mcp_servers.values() {
        for server_id in servers {
            if let Err(e) = mcp_remove_server(server_id.clone(), None).await {
                tracing::warn!(
                    "[plugin_host] could not remove MCP server '{server_id}' for '{id}': {e}"
                );
            }
        }
    }

    // 3. Remove quick messages
    for msg_ids in applied.quick_messages.values() {
        for &msg_id in msg_ids {
            if let Err(e) = quick_message_service::delete(&db.conn, msg_id as i32).await {
                tracing::warn!(
                    "[plugin_host] could not delete quick message {msg_id} for '{id}': {e}"
                );
            }
        }
    }

    // Clear applied in state
    let _ = mutate_state(plugins_root, |s| {
        if let Some(e) = s.plugins.get_mut(id) {
            e.applied = AppliedContributions::default();
        }
        Ok(())
    })
    .await;

    Ok(())
}
