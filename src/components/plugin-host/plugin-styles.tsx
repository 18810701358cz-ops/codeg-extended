"use client"

import { useEffect, useRef } from "react"
import { usePathname } from "next/navigation"
import {
  pluginHostList,
  subscribePluginHostChanged,
} from "@/lib/plugin-host/api"
import { usePluginHostStore } from "@/lib/plugin-host/store"
import {
  applyPluginManifestStyles,
  removePluginStyles,
} from "@/lib/plugin-host/styles"
import type { PluginInfo } from "@/lib/plugin-host/types"

export function PluginStyles() {
  const pathname = usePathname()
  const activeCleanupsRef = useRef<Map<string, () => void>>(new Map())

  useEffect(() => {
    const activeCleanups = activeCleanupsRef.current

    // If on /settings/plugins, guarantee no plugin styles are injected
    // so a broken stylesheet can never obscure or break the disable/uninstall UI.
    const isPluginsSettingsPage =
      pathname === "/settings/plugins" ||
      pathname.startsWith("/settings/plugins/")

    if (isPluginsSettingsPage) {
      // Clean up any existing injected styles
      activeCleanups.forEach((cleanup, id) => {
        try {
          cleanup()
        } catch {
          // ignore
        }
        removePluginStyles(id)
      })
      activeCleanups.clear()
      return
    }

    let cancelled = false

    const syncStyles = async () => {
      try {
        const res = await pluginHostList()
        if (cancelled) return

        // In safe mode, do not inject any styles
        if (res.safeMode) {
          activeCleanups.forEach((cleanup, id) => {
            try {
              cleanup()
            } catch {
              // ignore
            }
            removePluginStyles(id)
          })
          activeCleanups.clear()
          return
        }

        usePluginHostStore.getState().setListResult(res)

        const enabledPluginsWithStyles = res.plugins.filter(
          (p: PluginInfo) => p.enabled && p.styles && p.styles.length > 0
        )
        const activeIds = new Set(enabledPluginsWithStyles.map((p) => p.id))

        // Remove styles for plugins that are no longer enabled
        for (const [id, cleanup] of Array.from(activeCleanups.entries())) {
          if (!activeIds.has(id)) {
            try {
              cleanup()
            } catch {
              // ignore
            }
            removePluginStyles(id)
            activeCleanups.delete(id)
          }
        }

        // Inject styles for newly enabled plugins
        for (const plugin of enabledPluginsWithStyles) {
          if (!activeCleanups.has(plugin.id)) {
            const cleanup = await applyPluginManifestStyles(plugin)
            if (cancelled) {
              cleanup()
              removePluginStyles(plugin.id)
            } else {
              activeCleanups.set(plugin.id, cleanup)
            }
          }
        }
      } catch (err) {
        console.error("[plugin-host] Failed to sync declarative styles:", err)
      }
    }

    syncStyles()

    let unlisten: (() => void) | undefined
    subscribePluginHostChanged(() => {
      if (!cancelled) {
        syncStyles()
      }
    }).then((unsub) => {
      if (cancelled) {
        unsub()
      } else {
        unlisten = unsub
      }
    })

    return () => {
      cancelled = true
      if (unlisten) {
        unlisten()
      }
      activeCleanups.forEach((cleanup, id) => {
        try {
          cleanup()
        } catch {
          // ignore
        }
        removePluginStyles(id)
      })
      activeCleanups.clear()
    }
  }, [pathname])

  return null
}
