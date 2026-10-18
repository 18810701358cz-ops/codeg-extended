export const PLUGIN_HOST_VERSION = "1.0.0"
export const PLUGIN_HOST_API_VERSION = 1

export type PluginCategory =
  | "appearance"
  | "model-provider"
  | "tools"
  | "workflow"
  | "utility"

export type PluginPermission =
  | "ui"
  | "process"
  | "modelProviders"
  | "mcp"
  | "quickMessages"
  | "network"

export type PluginStatus = "ok" | "invalid" | "incompatible" | "error"

export type PluginSource =
  | { kind: "builtin" }
  | { kind: "git"; url: string; ref?: string; subdir?: string; commit?: string }
  | { kind: "upload"; fileName?: string }
  | { kind: "manual" }

export type BackendState =
  | "stopped"
  | "starting"
  | "running"
  | "unhealthy"
  | "crashed"
  | "setup_failed"

export interface BackendStatus {
  state: BackendState
  pid?: number
  port?: number
  url?: string
  restarts: number
  lastError?: string
}

export interface ConfigSchemaProperty {
  type: "string" | "number" | "integer" | "boolean"
  title?: string
  description?: string
  default?: string | number | boolean
  enum?: string[]
  format?: "secret"
}

export interface ConfigSchema {
  type: "object"
  properties: Record<string, ConfigSchemaProperty>
  required?: string[]
}

export interface PluginConfig {
  values: Record<string, string | number | boolean>
  secretsSet: string[] // secret 字段只告诉前端「已设置」，不回传值
}

export interface AppliedContributions {
  modelProviders: Record<string, number[]>
  mcpServers: Record<string, string[]>
  quickMessages: Record<string, number[]>
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  category?: PluginCategory
  icon?: string
  permissions: PluginPermission[]
  enabled: boolean
  status: PluginStatus
  problems: string[]
  source: PluginSource
  builtin: boolean
  hasMain: boolean
  styles: string[]
  configSchema?: ConfigSchema
  hasBackend: boolean
  backend?: BackendStatus
  applied: AppliedContributions
}

export interface PluginListResult {
  hostVersion: string
  apiVersion: number
  pluginsDir: string
  safeMode: boolean
  devMode: boolean
  plugins: PluginInfo[]
}

export type InstallSource =
  | { kind: "git"; url: string; ref?: string; subdir?: string }
  | { kind: "path"; path: string }

export interface PluginPreview {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  permissions: PluginPermission[]
  hasBackend: boolean
  hasMain: boolean
  contributes: {
    modelProviders: number
    mcpServers: number
    quickMessages: number
  }
  isUpgrade: boolean
  installedVersion?: string
  problems: string[] // 非空时不允许确认安装
}

export interface StageResult {
  stagingId: string
  preview: PluginPreview
}

export interface RepoUrlParts {
  url: string
  ref?: string
  subdir?: string
}

export interface UpdateCheckResult {
  current: string
  latest?: string
  commit?: string
  updatable: boolean
  stagingId?: string // updatable 为 true 时给出，直接用于 commit_install
}

export interface BackendFetchInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  headers?: Record<string, string>
  body?: string
}

export interface BackendFetchResult {
  status: number
  headers: Record<string, string>
  body: string
}

export interface ChangedEvent {
  ids: string[] // 为空表示整体刷新
}

export interface BackendStatusEvent {
  id: string
  status: BackendStatus
}

export type SlotName =
  | "statusbar.left"
  | "statusbar.right"
  | "workspace.overlay"
  | "settings.plugin-detail"

export interface SlotContribution {
  id: string
  order?: number
  mount(el: HTMLElement): void | (() => void)
}

/** What `ctx.tokens` reports about the conversation in focus. */
export interface TokenMeterSnapshot {
  /**
   * Tokens the agent has reported for the whole conversation so far
   * (input + output + cache): the figure the composer's usage popover shows as
   * "Total". `null` until the agent reports any. It settles after each turn,
   * not while one streams; `liveTokens` is the part still in flight.
   */
  totalTokens: number | null
  /** Estimated tokens generated so far by the turn in flight; `0` when idle. */
  liveTokens: number
  /**
   * Smoothed output speed of the turn in flight, in tok/s. `null` when idle or
   * while the first reading is still warming up.
   */
  tokensPerSecond: number | null
  /** `true` while the conversation is generating a reply. */
  streaming: boolean
}

export interface PluginTokens {
  /** The current snapshot of the conversation in focus. */
  get(): TokenMeterSnapshot
  /** Calls `fn` on every change. Unsubscribed automatically on dispose. */
  onChange(fn: (snapshot: TokenMeterSnapshot) => void): void
}

export interface PluginContext {
  readonly id: string
  readonly version: string
  readonly hostVersion: string
  onDispose(fn: () => void): void
  injectCSS(css: string): void
  registerSlot(name: SlotName, contribution: SlotContribution): void
  notify(message: string, type?: "info" | "success" | "warning" | "error"): void
  config: {
    get<T = Record<string, string | number | boolean>>(): Promise<T>
    onChange<T = Record<string, string | number | boolean>>(
      fn: (config: T) => void
    ): void
  }
  backend: {
    status(): Promise<BackendStatus | undefined>
    onStatus(fn: (status: BackendStatus) => void): void
    fetch(path: string, init?: BackendFetchInit): Promise<BackendFetchResult>
  }
  assets: { url(path: string): Promise<string> }
  tokens: PluginTokens
  env: { locale: string; theme: "light" | "dark"; mode: "desktop" | "web" }
  react: {
    React: typeof import("react")
    createRoot: typeof import("react-dom/client").createRoot
  }
  logger: {
    info(msg: string): void
    warn(msg: string): void
    error(msg: string): void
  }
}
