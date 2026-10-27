import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  PluginContext,
  SlotContribution,
  SlotName,
  TokenMeterSnapshot,
} from "../types"

// Import the pure ESM plugin directly
import {
  activate,
  describeSnapshot,
  formatSpeed,
  formatTokenCount,
  normalizeSide,
  pickStrings,
} from "../../../../plugins/token-meter/dist/index.js"

const IDLE: TokenMeterSnapshot = {
  totalTokens: null,
  liveTokens: 0,
  tokensPerSecond: null,
  streaming: false,
}

const EN = pickStrings("en")

describe("token-meter formatting", () => {
  it("formats token counts the way the host does", () => {
    expect(formatTokenCount(0)).toBe("0")
    expect(formatTokenCount(999)).toBe("999")
    expect(formatTokenCount(1_000)).toBe("1K")
    expect(formatTokenCount(1_234)).toBe("1.2K")
    expect(formatTokenCount(128_400)).toBe("128.4K")
    expect(formatTokenCount(1_000_000)).toBe("1M")
    expect(formatTokenCount(2_500_000)).toBe("2.5M")
  })

  it("formats the speed to one decimal and a missing one as a dash", () => {
    expect(formatSpeed(42.34)).toBe("42.3")
    expect(formatSpeed(0)).toBe("0.0")
    expect(formatSpeed(null)).toBe("—")
  })

  it("picks Chinese for any zh locale and English otherwise", () => {
    expect(pickStrings("zh-CN")).toBe(pickStrings("zh-TW"))
    expect(pickStrings("zh-CN")).not.toBe(EN)
    expect(pickStrings("ja")).toBe(EN)
    expect(pickStrings("")).toBe(EN)
    expect(pickStrings(undefined)).toBe(EN)
  })

  it("accepts only the two sides", () => {
    expect(normalizeSide("right")).toBe("right")
    expect(normalizeSide("left")).toBe("left")
    expect(normalizeSide("middle")).toBe("left")
    expect(normalizeSide(undefined)).toBe("left")
  })
})

describe("token-meter describeSnapshot", () => {
  it("shows dashes and dims when nothing has been reported", () => {
    expect(describeSnapshot(IDLE, EN)).toMatchObject({
      speed: "—",
      total: "—",
      live: "",
      idle: true,
    })
  })

  it("shows the settled total while idle", () => {
    const d = describeSnapshot({ ...IDLE, totalTokens: 128_400 }, EN)

    expect(d.total).toBe("128.4K")
    expect(d.speed).toBe("—")
    expect(d.idle).toBe(true)
  })

  it("shows the speed and the running count while streaming", () => {
    const d = describeSnapshot(
      {
        totalTokens: 128_400,
        liveTokens: 1_200,
        tokensPerSecond: 42.34,
        streaming: true,
      },
      EN
    )

    expect(d).toMatchObject({
      speed: "42.3",
      total: "128.4K",
      live: "+1.2K",
      idle: false,
    })
    expect(d.title).toContain("42.3 tok/s")
    expect(d.title).toContain("~1.2K")
  })

  it("keeps a dash for the speed while the first reading warms up", () => {
    const d = describeSnapshot({ ...IDLE, streaming: true }, EN)

    expect(d).toMatchObject({ speed: "—", live: "", idle: false })
  })

  it("says so when the total was never reported instead of showing 0", () => {
    const d = describeSnapshot(IDLE, EN)

    expect(d.title).toContain(`${EN.total}: ${EN.none}`)
  })
})

describe("token-meter activate", () => {
  let registered: Array<{ slot: SlotName; contribution: SlotContribution }>
  let listeners: Array<(snapshot: TokenMeterSnapshot) => void>
  let snapshot: TokenMeterSnapshot
  let config: Record<string, unknown>
  let ctx: PluginContext

  beforeEach(() => {
    document.body.innerHTML = ""
    registered = []
    listeners = []
    snapshot = IDLE
    config = {}
    ctx = {
      id: "token-meter",
      version: "1.0.0",
      hostVersion: "1.1.0",
      injectCSS: vi.fn(),
      registerSlot: vi.fn((slot: SlotName, contribution: SlotContribution) => {
        registered.push({ slot, contribution })
      }),
      config: { get: vi.fn(async () => config) },
      tokens: {
        get: vi.fn(() => snapshot),
        onChange: vi.fn((fn: (next: TokenMeterSnapshot) => void) => {
          listeners.push(fn)
        }),
      },
      env: { locale: "en", theme: "light", mode: "desktop" },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext
  })

  function emit(next: TokenMeterSnapshot) {
    snapshot = next
    for (const fn of listeners) fn(next)
  }

  it("registers one widget on the left by default and injects its styles once", async () => {
    await activate(ctx)

    expect(ctx.injectCSS).toHaveBeenCalledTimes(1)
    expect(registered.map((r) => r.slot)).toEqual(["statusbar.left"])
    expect(registered[0].contribution.id).toBe("token-meter")
  })

  it("honours the configured side", async () => {
    config = { position: "right" }
    await activate(ctx)

    expect(registered[0].slot).toBe("statusbar.right")
  })

  it("falls back to the left when the config cannot be read", async () => {
    vi.mocked(ctx.config.get).mockRejectedValueOnce(new Error("offline"))
    await activate(ctx)

    expect(registered[0].slot).toBe("statusbar.left")
    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it("renders the current snapshot on mount and follows later changes", async () => {
    snapshot = { ...IDLE, totalTokens: 1_500 }
    await activate(ctx)
    const el = document.createElement("div")
    registered[0].contribution.mount(el)

    expect(el.querySelector(".tkm-total")?.textContent).toBe("1.5K")
    expect(el.querySelector(".tkm-speed")?.textContent).toBe("—")

    emit({
      totalTokens: 1_500,
      liveTokens: 300,
      tokensPerSecond: 12.5,
      streaming: true,
    })

    expect(el.querySelector(".tkm-speed")?.textContent).toBe("12.5")
    expect(el.querySelector(".tkm-live")?.textContent).toBe("+300")
    expect(el.querySelector(".tkm-root")?.classList.contains("tkm-idle")).toBe(
      false
    )
  })

  it("subscribes once however often the slot is mounted, and cleans up", async () => {
    await activate(ctx)
    expect(ctx.tokens.onChange).toHaveBeenCalledTimes(1)

    const first = document.createElement("div")
    const cleanup = registered[0].contribution.mount(first) as () => void
    cleanup()
    expect(first.querySelector(".tkm-root")).toBeNull()

    const second = document.createElement("div")
    registered[0].contribution.mount(second)
    emit({ ...IDLE, totalTokens: 7 })

    expect(second.querySelector(".tkm-total")?.textContent).toBe("7")
    expect(first.querySelector(".tkm-total")).toBeNull()
    expect(ctx.tokens.onChange).toHaveBeenCalledTimes(1)
  })

  it("reads the locale again on every update", async () => {
    await activate(ctx)
    const el = document.createElement("div")
    registered[0].contribution.mount(el)
    const root = el.querySelector<HTMLElement>(".tkm-root")
    expect(root?.title).toContain("Conversation total")

    const env = ctx.env as { locale: string }
    env.locale = "zh-CN"
    emit({ ...IDLE, totalTokens: 10 })

    expect(root?.title).toContain("会话累计")
  })
})
