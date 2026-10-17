use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::Extension;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::plugin_host as plugin_commands;
use crate::paths::codeg_plugins_root;
use crate::plugin_host::registry::{PluginInfo, PluginListResult};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginIdParams {
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReadAssetParams {
    pub id: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSetEnabledParams {
    pub id: String,
    pub enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSetConfigParams {
    pub id: String,
    pub values: BTreeMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets: Option<BTreeMap<String, Option<String>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReportErrorParams {
    pub id: String,
    pub phase: String,
    pub message: String,
}

pub async fn plugin_host_list() -> Result<Json<PluginListResult>, AppCommandError> {
    plugin_commands::plugin_host_list_core(&codeg_plugins_root())
        .await
        .map(Json)
}

pub async fn plugin_host_read_entry(
    Json(params): Json<PluginIdParams>,
) -> Result<Json<plugin_commands::PluginEntryResult>, AppCommandError> {
    plugin_commands::plugin_host_read_entry_core(&codeg_plugins_root(), &params.id)
        .await
        .map(Json)
}

pub async fn plugin_host_read_asset(
    Json(params): Json<PluginReadAssetParams>,
) -> Result<Json<plugin_commands::PluginAssetResult>, AppCommandError> {
    plugin_commands::plugin_host_read_asset_core(
        &codeg_plugins_root(),
        &params.id,
        &params.path,
    )
    .await
    .map(Json)
}

pub async fn plugin_host_set_enabled(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PluginSetEnabledParams>,
) -> Result<Json<PluginInfo>, AppCommandError> {
    plugin_commands::plugin_host_set_enabled_core(
        &state.emitter,
        &codeg_plugins_root(),
        &params.id,
        params.enabled,
    )
    .await
    .map(Json)
}

pub async fn plugin_host_get_config(
    Json(params): Json<PluginIdParams>,
) -> Result<Json<plugin_commands::PluginConfig>, AppCommandError> {
    plugin_commands::plugin_host_get_config_core(&codeg_plugins_root(), &params.id)
        .await
        .map(Json)
}

pub async fn plugin_host_set_config(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PluginSetConfigParams>,
) -> Result<Json<plugin_commands::PluginConfig>, AppCommandError> {
    plugin_commands::plugin_host_set_config_core(
        &state.emitter,
        &codeg_plugins_root(),
        &params.id,
        params.values,
        params.secrets,
    )
    .await
    .map(Json)
}

pub async fn plugin_host_report_error(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PluginReportErrorParams>,
) -> Result<Json<plugin_commands::ReportErrorResult>, AppCommandError> {
    plugin_commands::plugin_host_report_error_core(
        &state.emitter,
        &codeg_plugins_root(),
        &params.id,
        &params.phase,
        &params.message,
    )
    .await
    .map(Json)
}

pub async fn plugin_host_report_activated(
    Json(params): Json<PluginIdParams>,
) -> Result<Json<()>, AppCommandError> {
    plugin_commands::plugin_host_report_activated_core(&codeg_plugins_root(), &params.id)
        .await
        .map(Json)
}

pub async fn plugin_host_disable_all(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<PluginListResult>, AppCommandError> {
    plugin_commands::plugin_host_disable_all_core(&state.emitter, &codeg_plugins_root())
        .await
        .map(Json)
}

pub fn routes() -> Router {
    Router::new()
        .route("/plugin_host_list", post(plugin_host_list))
        .route("/plugin_host_read_entry", post(plugin_host_read_entry))
        .route("/plugin_host_read_asset", post(plugin_host_read_asset))
        .route("/plugin_host_set_enabled", post(plugin_host_set_enabled))
        .route("/plugin_host_get_config", post(plugin_host_get_config))
        .route("/plugin_host_set_config", post(plugin_host_set_config))
        .route("/plugin_host_report_error", post(plugin_host_report_error))
        .route(
            "/plugin_host_report_activated",
            post(plugin_host_report_activated),
        )
        .route("/plugin_host_disable_all", post(plugin_host_disable_all))
}
