import React from "react"
import { render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as api from "@/lib/plugin-host/api"
import { usePluginHostStore } from "@/lib/plugin-host/store"
import type {
  BackendStatusEvent,
  PluginInfo,
  PluginListResult,
} from "@/lib/plugin-host/types"
import { PluginHost } from "./plugin-host"

describe("PluginHost", () => {
  const samplePlugin: PluginInfo = {
    id: "sample-plugin",
    name: "Sample Plugin",
    version: "1.0.0",
    permissions: ["ui"],
    enabled: true,
    status: "ok",
    problems: [],
    source: { kind: "builtin" },
    builtin: true,
    hasMain: true,
    styles: [],
    hasBackend: false,
    applied: { modelProviders: {}, mcpServers: {}, quickMessages: {} },
  }

  const baseListResult: PluginListResult = {
    hostVersion: "1.0.0",
    apiVersion: 1,
    pluginsDir: "/plugins",
    safeMode: false,
    devMode: false,
    plugins: [samplePlugin],
  }

  let changedHandler: ((event: { ids: string[] }) => void) | undefined
  let backendStatusHandler: ((event: BackendStatusEvent) => void) | undefined

  beforeEach(() => {
    localStorage.clear()
    usePluginHostStore.getState().reset()
    vi.clearAllMocks()

    vi.spyOn(api, "pluginHostList").mockResolvedValue(baseListResult)
    vi.spyOn(api, "pluginHostReadEntry").mockResolvedValue({
      code: "export function activate(ctx) {}",
      hash: "abc-123",
    })
    vi.spyOn(api, "pluginHostReportActivated").mockResolvedValue(null)
    vi.spyOn(api, "pluginHostReportError").mockResolvedValue({
      autoDisabled: false,
    })
    vi.spyOn(api, "pluginHostSetEnabled").mockResolvedValue(samplePlugin)
    vi.spyOn(api, "subscribePluginHostChanged").mockImplementation(
      async (handler) => {
        changedHandler = handler
        return () => {
          changedHandler = undefined
        }
      }
    )
    vi.spyOn(api, "subscribePluginHostBackendStatus").mockImplementation(
      async (handler) => {
        backendStatusHandler = handler
        return () => {
          backendStatusHandler = undefined
        }
      }
    )
  })

  afterEach(() => {
    localStorage.clear()
  })

  it("migrates legacy localStorage codeg_plugins_enabled_v1 and removes key", async () => {
    localStorage.setItem(
      "codeg_plugins_enabled_v1",
      JSON.stringify({ "legacy-plug": true, "disabled-plug": false })
    )

    const mockImport = vi.fn().mockResolvedValue({
      activate: vi.fn(),
    })

    render(<PluginHost importFn={mockImport} />)

    await waitFor(() => {
      expect(api.pluginHostSetEnabled).toHaveBeenCalledWith("legacy-plug", true)
      expect(api.pluginHostSetEnabled).not.toHaveBeenCalledWith(
        "disabled-plug",
        true
      )
      expect(localStorage.getItem("codeg_plugins_enabled_v1")).toBeNull()
    })
  })

  it("activates enabled plugin and reports activated", async () => {
    const activateFn = vi.fn()
    const mockImport = vi.fn().mockResolvedValue({
      activate: activateFn,
    })

    render(<PluginHost importFn={mockImport} />)

    await waitFor(() => {
      expect(api.pluginHostReadEntry).toHaveBeenCalledWith("sample-plugin")
      expect(activateFn).toHaveBeenCalled()
      expect(api.pluginHostReportActivated).toHaveBeenCalledWith(
        "sample-plugin"
      )
    })

    const runtime = usePluginHostStore.getState().runtimeStates["sample-plugin"]
    expect(runtime?.active).toBe(true)
    expect(runtime?.error).toBeUndefined()
  })

  it("handles activation failure, cleans up, and reports error to backend", async () => {
    const mockImport = vi.fn().mockResolvedValue({
      activate: () => {
        throw new Error("Activation crash!")
      },
    })

    render(<PluginHost importFn={mockImport} />)

    await waitFor(() => {
      expect(api.pluginHostReportError).toHaveBeenCalledWith(
        "sample-plugin",
        "activate",
        "Activation crash!"
      )
    })

    const runtime = usePluginHostStore.getState().runtimeStates["sample-plugin"]
    expect(runtime?.active).toBe(false)
    expect(runtime?.error).toBe("Activation crash!")
  })

  it("times out if activate() hangs for longer than 5 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const mockImport = vi.fn().mockResolvedValue({
      activate: () => new Promise(() => {}), // Never resolves
    })

    render(<PluginHost importFn={mockImport} />)

    // Advance 5.5 seconds
    await vi.advanceTimersByTimeAsync(5500)

    expect(api.pluginHostReportError).toHaveBeenCalledWith(
      "sample-plugin",
      "activate",
      "Plugin activation timed out after 5000ms"
    )

    vi.useRealTimers()
  })

  it("skips activation in safe mode", async () => {
    vi.spyOn(api, "pluginHostList").mockResolvedValue({
      ...baseListResult,
      safeMode: true,
    })

    const mockImport = vi.fn()
    render(<PluginHost importFn={mockImport} />)

    await waitFor(() => {
      expect(usePluginHostStore.getState().safeMode).toBe(true)
    })

    expect(api.pluginHostReadEntry).not.toHaveBeenCalled()
    expect(mockImport).not.toHaveBeenCalled()
  })

  it("reconciles plugins on changed event and updates backend status", async () => {
    const activateFn = vi.fn()
    const deactivateFn = vi.fn()
    const mockImport = vi.fn().mockResolvedValue({
      activate: activateFn,
      deactivate: deactivateFn,
    })

    render(<PluginHost importFn={mockImport} />)

    await waitFor(() => {
      expect(activateFn).toHaveBeenCalled()
    })

    // Trigger backend status event
    if (backendStatusHandler) {
      backendStatusHandler({
        id: "sample-plugin",
        status: { state: "running", restarts: 0 },
      })
    }

    expect(
      usePluginHostStore
        .getState()
        .plugins.find((p) => p.id === "sample-plugin")?.backend?.state
    ).toBe("running")

    // Now disable the plugin in the backend
    vi.spyOn(api, "pluginHostList").mockResolvedValue({
      ...baseListResult,
      plugins: [{ ...samplePlugin, enabled: false }],
    })

    // Trigger changed event
    if (changedHandler) {
      changedHandler({ ids: ["sample-plugin"] })
    }

    await waitFor(() => {
      expect(deactivateFn).toHaveBeenCalled()
      expect(
        usePluginHostStore.getState().runtimeStates["sample-plugin"]?.active
      ).toBe(false)
    })
  })
})
