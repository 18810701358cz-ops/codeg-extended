import React from "react"
import { render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as api from "@/lib/plugin-host/api"
import { usePluginHostStore } from "@/lib/plugin-host/store"
import type { PluginInfo, PluginListResult } from "@/lib/plugin-host/types"
import { PluginStyles } from "./plugin-styles"

const nav = vi.hoisted(() => ({ pathname: "/settings/appearance" }))

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
}))

describe("PluginStyles", () => {
  const pluginWithStyles: PluginInfo = {
    id: "style-plugin",
    name: "Style Plugin",
    version: "1.0.0",
    permissions: ["ui"],
    enabled: true,
    status: "ok",
    problems: [],
    source: { kind: "builtin" },
    builtin: true,
    hasMain: false,
    styles: ["main.css"],
    hasBackend: false,
    applied: { modelProviders: {}, mcpServers: {}, quickMessages: {} },
  }

  const mockListResult: PluginListResult = {
    hostVersion: "1.0.0",
    apiVersion: 1,
    pluginsDir: "/plugins",
    safeMode: false,
    devMode: false,
    plugins: [pluginWithStyles],
  }

  beforeEach(() => {
    nav.pathname = "/settings/appearance"
    document.head.innerHTML = ""
    usePluginHostStore.getState().reset()
    vi.clearAllMocks()

    vi.spyOn(api, "pluginHostList").mockResolvedValue(mockListResult)
    vi.spyOn(api, "pluginHostReadAsset").mockResolvedValue({
      mime: "text/css",
      base64: Buffer.from(".custom-theme { color: purple; }").toString(
        "base64"
      ),
    })
    vi.spyOn(api, "subscribePluginHostChanged").mockResolvedValue(() => {})
  })

  afterEach(() => {
    document.head.innerHTML = ""
  })

  it("injects declarative styles on general settings pages", async () => {
    render(<PluginStyles />)

    await waitFor(() => {
      const el = document.querySelector('style[data-plugin-id="style-plugin"]')
      expect(el).not.toBeNull()
      expect(el?.textContent).toContain(".custom-theme { color: purple; }")
    })
  })

  it("does NOT inject styles on /settings/plugins", async () => {
    nav.pathname = "/settings/plugins"
    render(<PluginStyles />)

    // Wait a tick to ensure sync would have run
    await new Promise((r) => setTimeout(r, 50))
    expect(
      document.querySelector('style[data-plugin-id="style-plugin"]')
    ).toBeNull()
  })

  it("cleans up injected styles when navigating to /settings/plugins", async () => {
    nav.pathname = "/settings/appearance"
    const { rerender } = render(<PluginStyles />)

    await waitFor(() => {
      expect(
        document.querySelector('style[data-plugin-id="style-plugin"]')
      ).not.toBeNull()
    })

    nav.pathname = "/settings/plugins"
    rerender(<PluginStyles />)

    await waitFor(() => {
      expect(
        document.querySelector('style[data-plugin-id="style-plugin"]')
      ).toBeNull()
    })
  })
})
