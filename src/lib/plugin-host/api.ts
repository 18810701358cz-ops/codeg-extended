import { getTransport } from "@/lib/transport"
import type {
  BackendFetchInit,
  BackendFetchResult,
  BackendStatus,
  BackendStatusEvent,
  ChangedEvent,
  InstallSource,
  PluginConfig,
  PluginInfo,
  PluginListResult,
  RepoUrlParts,
  StageResult,
  UpdateCheckResult,
} from "./types"

export async function pluginHostList(): Promise<PluginListResult> {
  return getTransport().call("plugin_host_list")
}

export async function pluginHostReadEntry(
  id: string
): Promise<{ code: string; hash: string }> {
  return getTransport().call("plugin_host_read_entry", { id })
}

export async function pluginHostReadAsset(
  id: string,
  path: string
): Promise<{ mime: string; base64: string }> {
  return getTransport().call("plugin_host_read_asset", { id, path })
}

export async function pluginHostSetEnabled(
  id: string,
  enabled: boolean
): Promise<PluginInfo> {
  return getTransport().call("plugin_host_set_enabled", { id, enabled })
}

export async function pluginHostGetConfig(id: string): Promise<PluginConfig> {
  return getTransport().call("plugin_host_get_config", { id })
}

export async function pluginHostSetConfig(
  id: string,
  values: Record<string, string | number | boolean>,
  secrets?: Record<string, string | null>
): Promise<PluginConfig> {
  return getTransport().call("plugin_host_set_config", {
    id,
    values,
    ...(secrets !== undefined ? { secrets } : {}),
  })
}

export async function pluginHostReportError(
  id: string,
  phase: "activate" | "runtime",
  message: string
): Promise<{ autoDisabled: boolean }> {
  return getTransport().call("plugin_host_report_error", {
    id,
    phase,
    message,
  })
}

export async function pluginHostReportActivated(id: string): Promise<null> {
  return getTransport().call("plugin_host_report_activated", { id })
}

export async function pluginHostDisableAll(): Promise<PluginListResult> {
  return getTransport().call("plugin_host_disable_all")
}

export async function pluginHostParseRepoUrl(
  url: string
): Promise<RepoUrlParts> {
  return getTransport().call("plugin_host_parse_repo_url", { url })
}

export async function pluginHostStage(
  source: InstallSource
): Promise<StageResult> {
  return getTransport().call("plugin_host_stage", { source })
}

export async function pluginHostCommitInstall(
  stagingId: string
): Promise<PluginInfo> {
  return getTransport().call("plugin_host_commit_install", { stagingId })
}

export async function pluginHostDiscardStaging(
  stagingId: string
): Promise<null> {
  return getTransport().call("plugin_host_discard_staging", { stagingId })
}

export async function pluginHostCheckUpdate(
  id: string
): Promise<UpdateCheckResult> {
  return getTransport().call("plugin_host_check_update", { id })
}

export async function pluginHostUninstall(
  id: string,
  removeContributions?: boolean
): Promise<null> {
  return getTransport().call("plugin_host_uninstall", {
    id,
    ...(removeContributions !== undefined ? { removeContributions } : {}),
  })
}

export async function pluginHostBackendRestart(
  id: string
): Promise<BackendStatus> {
  return getTransport().call("plugin_host_backend_restart", { id })
}

export async function pluginHostBackendFetch(
  id: string,
  path: string,
  init?: BackendFetchInit
): Promise<BackendFetchResult> {
  return getTransport().call("plugin_host_backend_fetch", {
    id,
    path,
    ...(init?.method ? { method: init.method } : {}),
    ...(init?.headers ? { headers: init.headers } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {}),
  })
}

export async function pluginHostReadLog(
  id: string,
  tailBytes?: number
): Promise<string> {
  return getTransport().call("plugin_host_read_log", {
    id,
    ...(tailBytes !== undefined ? { tailBytes } : {}),
  })
}

export async function pluginHostSetDevMode(enabled: boolean): Promise<null> {
  return getTransport().call("plugin_host_set_dev_mode", { enabled })
}

export async function subscribePluginHostChanged(
  handler: (event: ChangedEvent) => void
): Promise<() => void> {
  return getTransport().subscribe<ChangedEvent>(
    "plugin-host://changed",
    handler
  )
}

export async function subscribePluginHostBackendStatus(
  handler: (event: BackendStatusEvent) => void
): Promise<() => void> {
  return getTransport().subscribe<BackendStatusEvent>(
    "plugin-host://backend-status",
    handler
  )
}
