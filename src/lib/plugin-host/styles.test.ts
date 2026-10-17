import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as api from "./api"
import {
  applyPluginManifestStyles,
  injectPluginCSS,
  removePluginStyles,
} from "./styles"
import type { PluginInfo } from "./types"

describe("styles", () => {
  beforeEach(() => {
    document.head.innerHTML = ""
  })

  afterEach(() => {
    document.head.innerHTML = ""
  })

  it("injects and removes raw CSS string with data attributes", () => {
    const cleanup = injectPluginCSS(
      "test-plugin",
      ".btn { color: red; }",
      "custom-id"
    )

    const el = document.querySelector('style[data-plugin-id="test-plugin"]')
    expect(el).not.toBeNull()
    expect(el?.getAttribute("data-style-id")).toBe("custom-id")
    expect(el?.textContent).toBe(".btn { color: red; }")

    cleanup()
    expect(
      document.querySelector('style[data-plugin-id="test-plugin"]')
    ).toBeNull()
  })

  it("removePluginStyles removes all styles for a given plugin", () => {
    injectPluginCSS("plugin-x", ".a { color: blue; }", "s1")
    injectPluginCSS("plugin-x", ".b { color: green; }", "s2")
    injectPluginCSS("plugin-y", ".c { color: red; }", "s3")

    expect(
      document.querySelectorAll('style[data-plugin-id="plugin-x"]')
    ).toHaveLength(2)
    expect(
      document.querySelectorAll('style[data-plugin-id="plugin-y"]')
    ).toHaveLength(1)

    removePluginStyles("plugin-x")
    expect(
      document.querySelectorAll('style[data-plugin-id="plugin-x"]')
    ).toHaveLength(0)
    expect(
      document.querySelectorAll('style[data-plugin-id="plugin-y"]')
    ).toHaveLength(1)
  })

  it("applyPluginManifestStyles reads assets and injects decoded CSS", async () => {
    const css = "body { background: darkblue; }"
    const b64 = Buffer.from(css).toString("base64")

    vi.spyOn(api, "pluginHostReadAsset").mockResolvedValue({
      mime: "text/css",
      base64: b64,
    })

    const plugin: PluginInfo = {
      id: "manifest-plugin",
      name: "Manifest Plugin",
      version: "1.0.0",
      permissions: ["ui"],
      enabled: true,
      status: "ok",
      problems: [],
      source: { kind: "builtin" },
      builtin: true,
      hasMain: false,
      styles: ["theme.css"],
      hasBackend: false,
      applied: { modelProviders: {}, mcpServers: {}, quickMessages: {} },
    }

    const cleanup = await applyPluginManifestStyles(plugin)

    expect(api.pluginHostReadAsset).toHaveBeenCalledWith(
      "manifest-plugin",
      "theme.css"
    )

    const el = document.querySelector('style[data-plugin-id="manifest-plugin"]')
    expect(el).not.toBeNull()
    expect(el?.textContent).toBe(css)

    cleanup()
    expect(
      document.querySelector('style[data-plugin-id="manifest-plugin"]')
    ).toBeNull()
  })
})
