import { pluginHostReadAsset } from "./api"
import type { PluginInfo } from "./types"

function base64ToUtf8(b64: string): string {
  if (typeof atob !== "function") return ""
  const binStr = atob(b64)
  const bytes = new Uint8Array(binStr.length)
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Injects a raw CSS string into the document head associated with a plugin.
 * Returns an unmount/cleanup function that removes this specific style element.
 */
export function injectPluginCSS(
  pluginId: string,
  css: string,
  styleId?: string
): () => void {
  if (typeof document === "undefined") return () => {}

  const el = document.createElement("style")
  el.setAttribute("data-plugin-id", pluginId)
  if (styleId) {
    el.setAttribute("data-style-id", styleId)
  }
  el.textContent = css
  document.head.appendChild(el)

  return () => {
    if (el.parentNode) {
      el.parentNode.removeChild(el)
    }
  }
}

/**
 * Removes all <style> elements associated with a given plugin id.
 */
export function removePluginStyles(pluginId: string): void {
  if (typeof document === "undefined") return

  const elements = document.querySelectorAll(
    `style[data-plugin-id="${CSS.escape(pluginId)}"]`
  )
  elements.forEach((el) => {
    el.parentNode?.removeChild(el)
  })
}

/**
 * Loads and injects the declarative stylesheets listed in plugin.styles.
 * Returns a cleanup function that removes all injected styles for this plugin.
 */
export async function applyPluginManifestStyles(
  plugin: PluginInfo
): Promise<() => void> {
  if (
    typeof document === "undefined" ||
    !plugin.styles ||
    plugin.styles.length === 0
  ) {
    return () => {}
  }

  const cleanups: (() => void)[] = []

  for (const stylePath of plugin.styles) {
    try {
      const asset = await pluginHostReadAsset(plugin.id, stylePath)
      const css = base64ToUtf8(asset.base64)
      const cleanup = injectPluginCSS(plugin.id, css, stylePath)
      cleanups.push(cleanup)
    } catch (err) {
      console.error(
        `[plugin-host] Failed to load manifest style "${stylePath}" for plugin "${plugin.id}":`,
        err
      )
    }
  }

  return () => {
    for (const fn of cleanups) {
      try {
        fn()
      } catch {
        // ignore
      }
    }
  }
}
