export interface PluginMetadata {
  id: string
  name: string
  version: string
  description: string
  author?: string
  category?: "appearance" | "model-provider" | "tools" | "workflow" | "utility"
  icon?: string
  css?: string
  script?: string
  defaultEnabled?: boolean
  settings?: Record<string, unknown>
}

export interface PluginUIHook {
  id: string
  pluginId: string
  target: "topbar" | "sidebar-bottom" | "settings-header" | "floating-panel"
  render: (container: HTMLElement) => void | (() => void)
}

export interface CodegPluginAPI {
  version: string
  injectCSS: (id: string, cssText: string) => void
  removeCSS: (id: string) => void
  registerUIHook: (hook: PluginUIHook) => void
  unregisterUIHook: (hookId: string) => void
  notify: (msg: string, type?: "info" | "success" | "warning" | "error") => void
  getPlugins: () => PluginMetadata[]
  isPluginEnabled: (id: string) => boolean
  setPluginEnabled: (id: string, enabled: boolean) => void
}
