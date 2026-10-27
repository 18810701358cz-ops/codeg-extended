import React from "react"
import { createRoot } from "react-dom/client"
import { toast } from "sonner"
import { getTransport } from "@/lib/transport"
import {
  pluginHostBackendFetch,
  pluginHostGetConfig,
  pluginHostReadAsset,
  subscribePluginHostBackendStatus,
  subscribePluginHostChanged,
} from "./api"
import { registerSlotContribution } from "./slots"
import { usePluginHostStore } from "./store"
import { injectPluginCSS } from "./styles"
import { getTokenMeterSnapshot, subscribeTokenMeter } from "./token-meter"
import type {
  BackendFetchInit,
  BackendFetchResult,
  BackendStatus,
  PluginContext,
  PluginInfo,
  PluginTokens,
  SlotContribution,
  SlotName,
} from "./types"
import { PLUGIN_HOST_VERSION } from "./types"

function base64ToBlob(b64: string, mime: string): Blob {
  const binStr = atob(b64)
  const bytes = new Uint8Array(binStr.length)
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime })
}

export interface ManagedPluginContext {
  context: PluginContext
  dispose: () => void
}

/**
 * Creates an isolated PluginContext instance for a plugin.
 * Tracks all registered resources, disposers, injected styles, slot contributions,
 * and asset blob URLs, and cleans them up in reverse order (LIFO) when disposed.
 */
export function createPluginContext(plugin: PluginInfo): ManagedPluginContext {
  const disposers: (() => void)[] = []
  const createdBlobUrls: string[] = []

  const onDispose = (fn: () => void) => {
    disposers.push(fn)
  }

  const injectCSS = (css: string) => {
    const cleanup = injectPluginCSS(plugin.id, css)
    onDispose(cleanup)
  }

  const registerSlot = (name: SlotName, contribution: SlotContribution) => {
    const unregister = registerSlotContribution(plugin.id, name, contribution)
    onDispose(unregister)
  }

  const notify = (
    message: string,
    type?: "info" | "success" | "warning" | "error"
  ) => {
    switch (type) {
      case "success":
        toast.success(message)
        break
      case "warning":
        toast.warning(message)
        break
      case "error":
        toast.error(message)
        break
      case "info":
      default:
        toast.info(message)
        break
    }
  }

  const config = {
    async get<T = Record<string, string | number | boolean>>(): Promise<T> {
      const cfg = await pluginHostGetConfig(plugin.id)
      return cfg.values as unknown as T
    },
    onChange<T = Record<string, string | number | boolean>>(
      fn: (config: T) => void
    ): void {
      let active = true
      let unlisten: (() => void) | undefined

      subscribePluginHostChanged(async (event) => {
        if (!active) return
        if (event.ids.length === 0 || event.ids.includes(plugin.id)) {
          try {
            const nextConfig = await pluginHostGetConfig(plugin.id)
            if (active) {
              fn(nextConfig.values as unknown as T)
            }
          } catch (err) {
            console.error(
              `[plugin-host] Failed to reload config for plugin "${plugin.id}":`,
              err
            )
          }
        }
      }).then((unsub) => {
        if (!active) {
          unsub()
        } else {
          unlisten = unsub
        }
      })

      onDispose(() => {
        active = false
        if (unlisten) {
          unlisten()
        }
      })
    },
  }

  const backend = {
    async status(): Promise<BackendStatus | undefined> {
      const state = usePluginHostStore.getState()
      const found = state.plugins.find((p) => p.id === plugin.id)
      return found?.backend
    },
    onStatus(fn: (status: BackendStatus) => void): void {
      let active = true
      let unlisten: (() => void) | undefined

      subscribePluginHostBackendStatus((event) => {
        if (!active) return
        if (event.id === plugin.id) {
          fn(event.status)
        }
      }).then((unsub) => {
        if (!active) {
          unsub()
        } else {
          unlisten = unsub
        }
      })

      onDispose(() => {
        active = false
        if (unlisten) {
          unlisten()
        }
      })
    },
    async fetch(
      path: string,
      init?: BackendFetchInit
    ): Promise<BackendFetchResult> {
      return pluginHostBackendFetch(plugin.id, path, init)
    },
  }

  const assets = {
    async url(path: string): Promise<string> {
      const res = await pluginHostReadAsset(plugin.id, path)
      const blob = base64ToBlob(res.base64, res.mime)
      const url = URL.createObjectURL(blob)
      createdBlobUrls.push(url)
      return url
    },
  }

  const tokens: PluginTokens = {
    get: getTokenMeterSnapshot,
    onChange(fn) {
      onDispose(subscribeTokenMeter(fn))
    },
  }

  const getEnv = () => {
    const isDesktop = getTransport().isDesktop()
    let locale = "en"
    let theme: "light" | "dark" = "light"

    if (typeof document !== "undefined") {
      locale = document.documentElement.lang || "en"
      if (document.documentElement.classList.contains("dark")) {
        theme = "dark"
      }
    }

    return {
      locale,
      theme,
      mode: isDesktop ? ("desktop" as const) : ("web" as const),
    }
  }

  const context: PluginContext = {
    id: plugin.id,
    version: plugin.version,
    hostVersion: PLUGIN_HOST_VERSION,
    onDispose,
    injectCSS,
    registerSlot,
    notify,
    config,
    backend,
    assets,
    tokens,
    get env() {
      return getEnv()
    },
    react: {
      React,
      createRoot,
    },
    logger: {
      info: (...args: unknown[]) =>
        console.info(`[plugin:${plugin.id}]`, ...args),
      warn: (...args: unknown[]) =>
        console.warn(`[plugin:${plugin.id}]`, ...args),
      error: (...args: unknown[]) =>
        console.error(`[plugin:${plugin.id}]`, ...args),
    },
  }

  const dispose = () => {
    // Reverse disposal order (LIFO)
    for (let i = disposers.length - 1; i >= 0; i--) {
      try {
        disposers[i]()
      } catch (err) {
        console.error(
          `[plugin-host] Error during disposal callback in plugin "${plugin.id}":`,
          err
        )
      }
    }
    disposers.length = 0

    // Revoke all created asset URLs
    for (const url of createdBlobUrls) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // ignore
      }
    }
    createdBlobUrls.length = 0
  }

  return { context, dispose }
}
