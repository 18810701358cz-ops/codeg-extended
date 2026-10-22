"use client"

import { useEffect, useRef } from "react"
import {
  pluginHostList,
  pluginHostReadEntry,
  pluginHostReportActivated,
  pluginHostReportError,
  pluginHostSetEnabled,
  subscribePluginHostBackendStatus,
  subscribePluginHostChanged,
} from "@/lib/plugin-host/api"
import { createPluginContext } from "@/lib/plugin-host/context"
import {
  defaultImportFn,
  loadPluginModule,
  type ImportFn,
} from "@/lib/plugin-host/loader"
import { unregisterAllPluginSlotContributions } from "@/lib/plugin-host/slots"
import { usePluginHostStore } from "@/lib/plugin-host/store"
import {
  applyPluginManifestStyles,
  removePluginStyles,
} from "@/lib/plugin-host/styles"
import type { PluginInfo } from "@/lib/plugin-host/types"

interface ActivePluginHandle {
  codeHash?: string
  contextDispose?: () => void
  styleCleanup?: () => void
  moduleDeactivate?: () => void | Promise<void>
}

const LEGACY_STORAGE_KEY = "codeg_plugins_enabled_v1"

export interface PluginHostProps {
  importFn?: ImportFn
}

export function PluginHost({ importFn = defaultImportFn }: PluginHostProps) {
  const activePluginsRef = useRef<Map<string, ActivePluginHandle>>(new Map())
  const bootedRef = useRef(false)

  useEffect(() => {
    // Only boot once per workspace lifecycle
    if (bootedRef.current) return
    bootedRef.current = true

    let cancelled = false
    const activePlugins = activePluginsRef.current

    async function migrateLegacySettings() {
      if (typeof window === "undefined" || !window.localStorage) return
      try {
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
        if (legacy) {
          const parsed = JSON.parse(legacy)
          if (typeof parsed === "object" && parsed !== null) {
            for (const [id, enabled] of Object.entries(parsed)) {
              if (enabled) {
                try {
                  await pluginHostSetEnabled(id, true)
                } catch (err) {
                  console.error(
                    `[plugin-host] Failed to migrate legacy plugin ${id}:`,
                    err
                  )
                }
              }
            }
          }
          localStorage.removeItem(LEGACY_STORAGE_KEY)
        }
      } catch (err) {
        console.error("[plugin-host] Error migrating legacy storage key:", err)
      }
    }

    async function deactivatePlugin(pluginId: string) {
      const handle = activePlugins.get(pluginId)
      if (!handle) return
      activePlugins.delete(pluginId)

      if (handle.moduleDeactivate) {
        try {
          await handle.moduleDeactivate()
        } catch (err) {
          console.error(
            `[plugin-host] Error in deactivate() for plugin "${pluginId}":`,
            err
          )
        }
      }

      if (handle.contextDispose) {
        try {
          handle.contextDispose()
        } catch (err) {
          console.error(
            `[plugin-host] Error in context disposal for plugin "${pluginId}":`,
            err
          )
        }
      }

      if (handle.styleCleanup) {
        try {
          handle.styleCleanup()
        } catch {
          // ignore
        }
      }

      removePluginStyles(pluginId)
      unregisterAllPluginSlotContributions(pluginId)

      usePluginHostStore
        .getState()
        .setPluginRuntimeState(pluginId, { active: false })
    }

    async function activatePlugin(plugin: PluginInfo) {
      if (activePlugins.has(plugin.id)) return
      if (!plugin.enabled || plugin.status !== "ok") return

      usePluginHostStore.getState().setPluginRuntimeState(plugin.id, {
        loading: true,
        error: undefined,
      })

      let styleCleanup: (() => void) | undefined
      if (plugin.styles && plugin.styles.length > 0) {
        try {
          styleCleanup = await applyPluginManifestStyles(plugin)
        } catch (err) {
          console.error(
            `[plugin-host] Failed to apply styles for plugin "${plugin.id}":`,
            err
          )
        }
      }

      if (!plugin.hasMain) {
        activePlugins.set(plugin.id, { styleCleanup })
        usePluginHostStore.getState().setPluginRuntimeState(plugin.id, {
          active: true,
          loading: false,
          error: undefined,
        })
        return
      }

      try {
        const { code, hash } = await pluginHostReadEntry(plugin.id)
        if (cancelled) {
          if (styleCleanup) styleCleanup()
          removePluginStyles(plugin.id)
          return
        }

        const mod = await loadPluginModule(code, importFn)
        const managed = createPluginContext(plugin)

        if (typeof mod.activate === "function") {
          let timer: ReturnType<typeof setTimeout>
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error("Plugin activation timed out after 5000ms"))
            }, 5000)
          })

          try {
            await Promise.race([
              Promise.resolve(mod.activate(managed.context)),
              timeoutPromise,
            ])
            clearTimeout(timer!)

            try {
              await pluginHostReportActivated(plugin.id)
            } catch (err) {
              console.error(
                `[plugin-host] Failed to report activation for "${plugin.id}":`,
                err
              )
            }

            activePlugins.set(plugin.id, {
              codeHash: hash,
              contextDispose: managed.dispose,
              styleCleanup,
              moduleDeactivate: mod.deactivate,
            })

            usePluginHostStore.getState().setPluginRuntimeState(plugin.id, {
              active: true,
              loading: false,
              error: undefined,
            })
          } catch (err: unknown) {
            clearTimeout(timer!)
            const message = err instanceof Error ? err.message : String(err)
            console.error(
              `[plugin-host] Activation failed for plugin "${plugin.id}":`,
              err
            )

            managed.dispose()
            if (styleCleanup) styleCleanup()
            removePluginStyles(plugin.id)

            try {
              await pluginHostReportError(plugin.id, "activate", message)
            } catch (reportErr) {
              console.error(
                `[plugin-host] Failed to report error for "${plugin.id}":`,
                reportErr
              )
            }

            usePluginHostStore.getState().setPluginRuntimeState(plugin.id, {
              active: false,
              loading: false,
              error: message,
            })
          }
        } else {
          // No activate function exported
          activePlugins.set(plugin.id, {
            codeHash: hash,
            contextDispose: managed.dispose,
            styleCleanup,
            moduleDeactivate: mod.deactivate,
          })

          usePluginHostStore.getState().setPluginRuntimeState(plugin.id, {
            active: true,
            loading: false,
            error: undefined,
          })
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          `[plugin-host] Failed to load module for plugin "${plugin.id}":`,
          err
        )

        if (styleCleanup) styleCleanup()
        removePluginStyles(plugin.id)

        try {
          await pluginHostReportError(plugin.id, "activate", message)
        } catch (reportErr) {
          console.error(
            `[plugin-host] Failed to report error for "${plugin.id}":`,
            reportErr
          )
        }

        usePluginHostStore.getState().setPluginRuntimeState(plugin.id, {
          active: false,
          loading: false,
          error: message,
        })
      }
    }

    async function reconcile() {
      try {
        const res = await pluginHostList()
        if (cancelled) return

        usePluginHostStore.getState().setListResult(res)

        if (res.safeMode) {
          console.info(
            "[plugin-host] Safe mode active: skipping plugin activation"
          )
          for (const id of Array.from(activePlugins.keys())) {
            await deactivatePlugin(id)
          }
          return
        }

        const pluginMap = new Map(res.plugins.map((p) => [p.id, p]))

        // Deactivate plugins that are no longer enabled or removed
        for (const [id] of Array.from(activePlugins.entries())) {
          const plugin = pluginMap.get(id)
          if (!plugin || !plugin.enabled || plugin.status !== "ok") {
            await deactivatePlugin(id)
          }
        }

        // Activate enabled plugins
        for (const plugin of res.plugins) {
          if (
            plugin.enabled &&
            plugin.status === "ok" &&
            !activePlugins.has(plugin.id)
          ) {
            await activatePlugin(plugin)
          }
        }
      } catch (err) {
        console.error("[plugin-host] Error during reconciliation:", err)
      }
    }

    async function boot() {
      usePluginHostStore.getState().setLoading(true)
      await migrateLegacySettings()
      await reconcile()
      usePluginHostStore.getState().setBooted(true)
      usePluginHostStore.getState().setLoading(false)
    }

    boot()

    let unlistenChanged: (() => void) | undefined
    let unlistenStatus: (() => void) | undefined

    subscribePluginHostChanged(() => {
      if (!cancelled) {
        reconcile()
      }
    }).then((unsub) => {
      if (cancelled) unsub()
      else unlistenChanged = unsub
    })

    subscribePluginHostBackendStatus((event) => {
      if (!cancelled) {
        usePluginHostStore
          .getState()
          .updateBackendStatus(event.id, event.status)
      }
    }).then((unsub) => {
      if (cancelled) unsub()
      else unlistenStatus = unsub
    })

    return () => {
      cancelled = true
      bootedRef.current = false
      if (unlistenChanged) unlistenChanged()
      if (unlistenStatus) unlistenStatus()

      // Deactivate all running plugins in reverse order
      const ids = Array.from(activePlugins.keys()).reverse()
      for (const id of ids) {
        deactivatePlugin(id)
      }
      activePlugins.clear()
    }
  }, [importFn])

  return null
}
