use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Extension, Multipart};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::plugin_host as plugin_commands;
use crate::paths::codeg_plugins_root;
use crate::plugin_host::git_source;
use crate::plugin_host::installer;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginParseRepoUrlParams {
    pub url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStageParams {
    pub source: installer::InstallSource,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommitInstallParams {
    pub staging_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiscardStagingParams {
    pub staging_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCheckUpdateParams {
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUninstallParams {
    pub id: String,
    pub remove_contributions: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBackendFetchParams {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReadLogParams {
    pub id: String,
    #[serde(default)]
    pub tail_bytes: Option<u64>,
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

pub async fn plugin_host_parse_repo_url(
    Json(params): Json<PluginParseRepoUrlParams>,
) -> Result<Json<git_source::RepoUrlParts>, AppCommandError> {
    plugin_commands::plugin_host_parse_repo_url_core(&params.url)
        .await
        .map(Json)
}

pub async fn plugin_host_stage(
    Json(params): Json<PluginStageParams>,
) -> Result<Json<installer::StageResult>, AppCommandError> {
    plugin_commands::plugin_host_stage_core(&codeg_plugins_root(), params.source)
        .await
        .map(Json)
}

pub async fn plugin_host_stage_upload(
    mut multipart: Multipart,
) -> Result<Json<installer::StageResult>, AppCommandError> {
    let mut zip_bytes = Vec::new();
    let mut file_name = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        AppCommandError::invalid_input(format!("Multipart upload error: {e}"))
    })? {
        if field.name() == Some("file") {
            if let Some(name) = field.file_name() {
                file_name = Some(name.to_string());
            }
            let bytes = field.bytes().await.map_err(|e| {
                AppCommandError::io_error(format!("Failed to read multipart upload bytes: {e}"))
            })?;
            zip_bytes = bytes.to_vec();
            break;
        }
    }

    if zip_bytes.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Multipart upload is missing the `file` field",
        ));
    }

    installer::stage_zip_bytes(&codeg_plugins_root(), &zip_bytes, file_name.as_deref())
        .await
        .map(Json)
}

pub async fn plugin_host_commit_install(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PluginCommitInstallParams>,
) -> Result<Json<PluginInfo>, AppCommandError> {
    plugin_commands::plugin_host_commit_install_core(
        &state.emitter,
        &codeg_plugins_root(),
        &params.staging_id,
    )
    .await
    .map(Json)
}

pub async fn plugin_host_discard_staging(
    Json(params): Json<PluginDiscardStagingParams>,
) -> Result<Json<()>, AppCommandError> {
    plugin_commands::plugin_host_discard_staging_core(&codeg_plugins_root(), &params.staging_id)
        .await
        .map(Json)
}

pub async fn plugin_host_check_update(
    Json(params): Json<PluginCheckUpdateParams>,
) -> Result<Json<installer::UpdateCheckResult>, AppCommandError> {
    plugin_commands::plugin_host_check_update_core(&codeg_plugins_root(), &params.id)
        .await
        .map(Json)
}

pub async fn plugin_host_uninstall(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PluginUninstallParams>,
) -> Result<Json<()>, AppCommandError> {
    plugin_commands::plugin_host_uninstall_core(
        &state.emitter,
        &codeg_plugins_root(),
        &params.id,
        params.remove_contributions,
    )
    .await
    .map(Json)
}

pub async fn plugin_host_backend_restart(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PluginIdParams>,
) -> Result<Json<crate::plugin_host::manifest::BackendStatus>, AppCommandError> {
    plugin_commands::plugin_host_backend_restart_core(
        &state.emitter,
        &codeg_plugins_root(),
        &params.id,
    )
    .await
    .map(Json)
}

pub async fn plugin_host_backend_fetch(
    Json(params): Json<PluginBackendFetchParams>,
) -> Result<Json<crate::plugin_host::backend::BackendFetchResult>, AppCommandError> {
    plugin_commands::plugin_host_backend_fetch_core(
        &params.id,
        &params.path,
        params.method.as_deref(),
        params.headers.as_ref(),
        params.body.as_deref(),
    )
    .await
    .map(Json)
}

pub async fn plugin_host_read_log(
    Json(params): Json<PluginReadLogParams>,
) -> Result<Json<String>, AppCommandError> {
    plugin_commands::plugin_host_read_log_core(&params.id, params.tail_bytes)
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
        .route(
            "/plugin_host_parse_repo_url",
            post(plugin_host_parse_repo_url),
        )
        .route("/plugin_host_stage", post(plugin_host_stage))
        .route(
            "/plugin_host_stage_upload",
            post(plugin_host_stage_upload).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route(
            "/plugin_host_commit_install",
            post(plugin_host_commit_install),
        )
        .route(
            "/plugin_host_discard_staging",
            post(plugin_host_discard_staging),
        )
        .route(
            "/plugin_host_check_update",
            post(plugin_host_check_update),
        )
        .route("/plugin_host_uninstall", post(plugin_host_uninstall))
        .route(
            "/plugin_host_backend_restart",
            post(plugin_host_backend_restart),
        )
        .route(
            "/plugin_host_backend_fetch",
            post(plugin_host_backend_fetch),
        )
        .route("/plugin_host_read_log", post(plugin_host_read_log))
}
