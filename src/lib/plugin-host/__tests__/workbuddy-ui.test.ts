import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  BackendStatus,
  PluginContext,
  SlotContribution,
  SlotName,
} from "../types"

// Import the pure ESM plugin directly
import {
  activate,
  deactivate,
} from "../../../../plugins/workbuddy-connect/dist/index.js"

describe("WorkBuddy UI Integration", () => {
  let registeredSlots: Map<SlotName, SlotContribution>
  let statusListeners: ((status: BackendStatus) => void)[]
  let configChangeListeners: ((config: Record<string, unknown>) => void)[]
  let mockContext: PluginContext
  let mockBackendStatus: BackendStatus | undefined
  let mockConfig: Record<string, unknown>
  let mockFetchResult: {
    status: number
    headers: Record<string, string>
    body: string
  }

  beforeEach(() => {
    document.body.innerHTML = ""
    registeredSlots = new Map()
    statusListeners = []
    configChangeListeners = []
    mockBackendStatus = {
      state: "stopped",
      restarts: 0,
    }
    mockConfig = {
      probeConsent: false,
    }
    mockFetchResult = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        object: "list",
        data: [
          {
            id: "workbuddy-deepseek-v3",
            name: "WorkBuddy DeepSeek-V3",
            credits: "x0.00",
            badges: ["限时免费"],
            free: true,
          },
          {
            id: "workbuddy-gpt4o",
            name: "WorkBuddy GPT-4o",
            credits: "x1.00",
            badges: ["主力模型"],
            free: false,
          },
        ],
      }),
    }

    mockContext = {
      id: "workbuddy-connect",
      version: "2.0.0",
      hostVersion: "1.0.0",
      onDispose: vi.fn(),
      injectCSS: vi.fn(),
      registerSlot: vi.fn(
        (slotName: SlotName, contribution: SlotContribution) => {
          registeredSlots.set(slotName, contribution)
        }
      ),
      notify: vi.fn(),
      config: {
        get: vi.fn(async <T>() => mockConfig as unknown as T),
        onChange: vi.fn((cb) => {
          configChangeListeners.push(cb)
        }),
      },
      backend: {
        status: vi.fn(async () => mockBackendStatus),
        onStatus: vi.fn((cb) => {
          statusListeners.push(cb)
        }),
        fetch: vi.fn(async () => mockFetchResult),
      },
      assets: {
        url: vi.fn(async (path: string) => `blob:mock-asset/${path}`),
      },
      env: {
        locale: "zh-CN",
        theme: "light",
        mode: "desktop",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      react: {} as any,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }
  })

  afterEach(() => {
    deactivate()
    document.body.innerHTML = ""
    vi.clearAllMocks()
  })

  describe("activate(ctx)", () => {
    it("registers both statusbar.right and settings.plugin-detail slots", () => {
      activate(mockContext)

      expect(mockContext.registerSlot).toHaveBeenCalledTimes(2)
      expect(registeredSlots.has("statusbar.right")).toBe(true)
      expect(registeredSlots.get("statusbar.right")?.id).toBe(
        "workbuddy-status"
      )

      expect(registeredSlots.has("settings.plugin-detail")).toBe(true)
      expect(registeredSlots.get("settings.plugin-detail")?.id).toBe(
        "workbuddy-detail"
      )

      expect(mockContext.injectCSS).toHaveBeenCalled()
      expect(mockContext.onDispose).toHaveBeenCalled()
    })
  })

  describe("Statusbar Widget (statusbar.right)", () => {
    it("renders initial status and reacts to live status changes", async () => {
      mockBackendStatus = {
        state: "starting",
        restarts: 0,
      }

      activate(mockContext)
      const slot = registeredSlots.get("statusbar.right")!
      const el = document.createElement("div")
      document.body.appendChild(el)

      const unmount = slot.mount(el)
      expect(el.children.length).toBe(1)

      const item = el.querySelector(".wb-statusbar-item")!
      expect(item).not.toBeNull()
      expect(item.textContent).toContain("WorkBuddy")

      // Wait for async status() promise resolution
      await new Promise((r) => setTimeout(r, 0))

      const dot = item.querySelector(".wb-status-dot")!
      expect(dot.className).toContain("starting")

      // Simulate live status event: backend transitioned to running on port 18080
      for (const listener of statusListeners) {
        listener({
          state: "running",
          port: 18080,
          pid: 12345,
          restarts: 0,
        })
      }

      expect(dot.className).toContain("running")
      expect(item.getAttribute("title")).toContain("运行中")
      expect(item.getAttribute("title")).toContain("18080")

      // Test click notification
      ;(item as HTMLElement).click()
      expect(mockContext.notify).toHaveBeenCalledWith(
        expect.stringContaining("运行中"),
        "success"
      )

      // Test DOM leak free unmount
      expect(typeof unmount).toBe("function")
      if (unmount) unmount()

      expect(el.childNodes.length).toBe(0)
      expect(el.innerHTML).toBe("")
    })

    it("verifies 0 DOM leak when unmounted immediately or multiple times", () => {
      activate(mockContext)
      const slot = registeredSlots.get("statusbar.right")!
      const el = document.createElement("div")
      document.body.appendChild(el)

      const unmount = slot.mount(el)
      expect(el.childNodes.length).toBeGreaterThan(0)

      if (unmount) unmount()
      expect(el.childNodes.length).toBe(0)

      // Trigger status event after unmount -> must not revive DOM
      for (const listener of statusListeners) {
        listener({ state: "running", restarts: 0 })
      }
      expect(el.childNodes.length).toBe(0)
    })
  })

  describe("Settings Plugin Detail Widget (settings.plugin-detail)", () => {
    it("renders model list with badges and responds to probeConsent config", async () => {
      mockConfig = { probeConsent: true }

      activate(mockContext)
      const slot = registeredSlots.get("settings.plugin-detail")!
      const el = document.createElement("div")
      document.body.appendChild(el)

      const unmount = slot.mount(el)
      expect(el.children.length).toBe(1)

      // Let initial async config.get() and backend.fetch() resolve
      await new Promise((r) => setTimeout(r, 10))

      // Check probe notice banner is displayed because probeConsent is true
      const probeBanner = el.querySelector(".wb-probe-banner") as HTMLElement
      expect(probeBanner).not.toBeNull()
      expect(probeBanner.style.display).not.toBe("none")

      // Check model cards
      const modelCards = el.querySelectorAll(".wb-model-card")
      expect(modelCards.length).toBe(2)

      const card1 = modelCards[0]
      expect(card1.textContent).toContain("WorkBuddy DeepSeek-V3")
      expect(card1.querySelector(".wb-badge-free")?.textContent).toBe("x0.00")
      expect(card1.querySelector(".wb-badge-promo")?.textContent).toBe(
        "限时免费"
      )

      // Simulate live config update: probeConsent changed to false
      for (const listener of configChangeListeners) {
        listener({ probeConsent: false })
      }
      expect(probeBanner.style.display).toBe("none")

      // Simulate refresh click
      const refreshBtn = el.querySelector(".wb-detail-btn") as HTMLButtonElement
      expect(refreshBtn).not.toBeNull()
      refreshBtn.click()

      await new Promise((r) => setTimeout(r, 10))
      expect(mockContext.backend.fetch).toHaveBeenCalledWith("/v1/models")

      // Test DOM leak free unmount
      expect(typeof unmount).toBe("function")
      if (unmount) unmount()

      expect(el.childNodes.length).toBe(0)
      expect(el.innerHTML).toBe("")
    })

    it("renders error state when model fetching fails and cleans up completely", async () => {
      mockFetchResult = {
        status: 500,
        headers: {},
        body: JSON.stringify({ error: { message: "Internal Server Error" } }),
      }

      activate(mockContext)
      const slot = registeredSlots.get("settings.plugin-detail")!
      const el = document.createElement("div")
      document.body.appendChild(el)

      const unmount = slot.mount(el)

      await new Promise((r) => setTimeout(r, 10))

      const errorDiv = el.querySelector(".wb-detail-error")
      expect(errorDiv).not.toBeNull()
      expect(errorDiv?.textContent).toContain("500")

      if (unmount) unmount()
      expect(el.childNodes.length).toBe(0)
      expect(el.innerHTML).toBe("")
    })
  })
})
