import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import * as api from "./api"
import { createPluginContext } from "./context"
import { getSlotContributions } from "./slots"
import type { PluginInfo } from "./types"

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}))

describe("PluginContext", () => {
  const plugin: PluginInfo = {
    id: "test-plugin",
    name: "Test Plugin",
    version: "2.1.0",
    permissions: ["ui"],
    enabled: true,
    status: "ok",
    problems: [],
    source: { kind: "manual" },
    builtin: false,
    hasMain: true,
    styles: [],
    hasBackend: false,
    applied: { modelProviders: {}, mcpServers: {}, quickMessages: {} },
  }

  beforeEach(() => {
    document.head.innerHTML = ""
    vi.clearAllMocks()
  })

  afterEach(() => {
    document.head.innerHTML = ""
  })

  it("executes disposal callbacks in reverse (LIFO) order", () => {
    const { context, dispose } = createPluginContext(plugin)
    const callOrder: string[] = []

    context.onDispose(() => callOrder.push("first"))
    context.onDispose(() => callOrder.push("second"))
    context.onDispose(() => callOrder.push("third"))

    dispose()

    expect(callOrder).toEqual(["third", "second", "first"])
  })

  it("continues disposal even if one callback throws", () => {
    const { context, dispose } = createPluginContext(plugin)
    const callOrder: string[] = []

    context.onDispose(() => callOrder.push("first"))
    context.onDispose(() => {
      throw new Error("Failed disposal")
    })
    context.onDispose(() => callOrder.push("third"))

    dispose()

    expect(callOrder).toEqual(["third", "first"])
  })

  it("injects CSS and removes it automatically on disposal", () => {
    const { context, dispose } = createPluginContext(plugin)

    context.injectCSS(".plugin-box { display: flex; }")
    expect(
      document.querySelector('style[data-plugin-id="test-plugin"]')
    ).not.toBeNull()

    dispose()
    expect(
      document.querySelector('style[data-plugin-id="test-plugin"]')
    ).toBeNull()
  })

  it("registers slot contribution and unregisters it on disposal", () => {
    const { context, dispose } = createPluginContext(plugin)

    context.registerSlot("statusbar.left", {
      id: "clock",
      mount: vi.fn(),
    })

    expect(getSlotContributions("statusbar.left")).toHaveLength(1)

    dispose()
    expect(getSlotContributions("statusbar.left")).toHaveLength(0)
  })

  it("creates asset blob URLs and revokes them on disposal", async () => {
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL")
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock-asset-url")

    vi.spyOn(api, "pluginHostReadAsset").mockResolvedValue({
      mime: "image/png",
      base64: Buffer.from("fake-png-data").toString("base64"),
    })

    const { context, dispose } = createPluginContext(plugin)
    const url = await context.assets.url("icon.png")

    expect(url).toBe("blob:mock-asset-url")

    dispose()
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock-asset-url")

    revokeSpy.mockRestore()
    createSpy.mockRestore()
  })

  it("sends notifications through sonner toast", () => {
    const { context } = createPluginContext(plugin)

    context.notify("Default info")
    expect(toast.info).toHaveBeenCalledWith("Default info")

    context.notify("Success message", "success")
    expect(toast.success).toHaveBeenCalledWith("Success message")

    context.notify("Warning message", "warning")
    expect(toast.warning).toHaveBeenCalledWith("Warning message")

    context.notify("Error message", "error")
    expect(toast.error).toHaveBeenCalledWith("Error message")
  })

  it("reads config through pluginHostGetConfig", async () => {
    vi.spyOn(api, "pluginHostGetConfig").mockResolvedValue({
      values: { theme: "dark", count: 42 },
      secretsSet: ["apiKey"],
    })

    const { context } = createPluginContext(plugin)
    const cfg = await context.config.get<{ theme: string; count: number }>()

    expect(cfg).toEqual({ theme: "dark", count: 42 })
    expect(api.pluginHostGetConfig).toHaveBeenCalledWith("test-plugin")
  })
})
