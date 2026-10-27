import { act, render } from "@testing-library/react"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest"

import type { LiveMessage } from "@/contexts/acp-connections-context"
import type { SessionStats } from "@/lib/types"

vi.mock("@/contexts/acp-connections-context", () => ({
  useConnectionStore: vi.fn(),
}))
vi.mock("@/contexts/tab-context", () => ({ useTabStore: vi.fn() }))
vi.mock("@/stores/conversation-runtime-store", () => ({
  useConversationRuntimeStore: vi.fn(),
}))
vi.mock("@/hooks/use-token-output-speed", () => ({
  useTokenOutputSpeed: vi.fn(),
}))

import { TokenMeterBridge } from "./token-meter-bridge"
import { useConnectionStore } from "@/contexts/acp-connections-context"
import { useTabStore } from "@/contexts/tab-context"
import { useTokenOutputSpeed } from "@/hooks/use-token-output-speed"
import {
  IDLE_TOKEN_METER_SNAPSHOT,
  getTokenMeterSnapshot,
  resetTokenMeter,
  subscribeTokenMeter,
} from "@/lib/plugin-host/token-meter"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"

const mockConnections = useConnectionStore as unknown as Mock
const mockTabs = useTabStore as unknown as Mock
const mockRuntime = useConversationRuntimeStore as unknown as Mock
const mockSpeed = useTokenOutputSpeed as unknown as Mock

type TabSlice = {
  activeTabId: string | null
  tabs: Array<{
    id: string
    kind: string
    conversationId: number | null
    runtimeConversationId?: number
  }>
}
type RuntimeSlice = {
  byConversationId: Map<
    number,
    { sessionStats: SessionStats | null; liveMessage: LiveMessage | null }
  >
}

function session(over: { total?: number; live?: LiveMessage | null } = {}) {
  return {
    sessionStats:
      over.total != null
        ? ({
            total_usage: null,
            total_tokens: over.total,
            total_duration_ms: 0,
          } as SessionStats)
        : null,
    liveMessage: over.live ?? null,
  }
}

function liveMessage(text: string, id = "live-1"): LiveMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text }],
    startedAt: 0,
  }
}

describe("TokenMeterBridge", () => {
  let tabs: TabSlice
  let runtime: RuntimeSlice
  let status: string | undefined

  beforeEach(() => {
    resetTokenMeter()
    vi.useFakeTimers()
    tabs = {
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", kind: "conversation", conversationId: 7 }],
    }
    runtime = { byConversationId: new Map() }
    status = undefined
    mockTabs.mockImplementation((sel: (s: TabSlice) => unknown) => sel(tabs))
    mockRuntime.mockImplementation((sel: (s: RuntimeSlice) => unknown) =>
      sel(runtime)
    )
    mockConnections.mockReturnValue({
      getConnection: () => (status === undefined ? undefined : { status }),
      subscribeKey: () => () => {},
    })
    mockSpeed.mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    resetTokenMeter()
    vi.clearAllMocks()
  })

  it("publishes the focused conversation's reported total", () => {
    runtime.byConversationId.set(7, session({ total: 1_500 }))
    render(<TokenMeterBridge />)

    expect(getTokenMeterSnapshot()).toEqual({
      totalTokens: 1_500,
      liveTokens: 0,
      tokensPerSecond: null,
      streaming: false,
    })
  })

  it("reads the tab's runtime conversation before its saved id", () => {
    tabs.tabs = [
      {
        id: "tab-1",
        kind: "conversation",
        conversationId: 7,
        runtimeConversationId: -1,
      },
    ]
    runtime.byConversationId.set(7, session({ total: 99 }))
    runtime.byConversationId.set(-1, session({ total: 42 }))
    render(<TokenMeterBridge />)

    expect(getTokenMeterSnapshot().totalTokens).toBe(42)
  })

  it("reports nothing when no conversation tab is focused", () => {
    tabs.activeTabId = null
    runtime.byConversationId.set(7, session({ total: 1_500 }))
    render(<TokenMeterBridge />)

    expect(getTokenMeterSnapshot()).toEqual(IDLE_TOKEN_METER_SNAPSHOT)
  })

  it("follows the focus when another tab is activated", () => {
    tabs.tabs.push({ id: "tab-2", kind: "conversation", conversationId: 8 })
    runtime.byConversationId.set(7, session({ total: 100 }))
    runtime.byConversationId.set(8, session({ total: 200 }))
    const { rerender } = render(<TokenMeterBridge />)
    expect(getTokenMeterSnapshot().totalTokens).toBe(100)

    tabs.activeTabId = "tab-2"
    rerender(<TokenMeterBridge />)

    expect(getTokenMeterSnapshot().totalTokens).toBe(200)
  })

  it("counts a turn as streaming only while the connection is prompting", () => {
    runtime.byConversationId.set(7, session({ live: liveMessage("hello") }))
    status = "connected"
    const { rerender } = render(<TokenMeterBridge />)
    expect(getTokenMeterSnapshot().streaming).toBe(false)

    status = "prompting"
    rerender(<TokenMeterBridge />)

    expect(getTokenMeterSnapshot().streaming).toBe(true)
  })

  it("measures the live turn only while a plugin is listening", () => {
    runtime.byConversationId.set(
      7,
      session({ live: liveMessage("a".repeat(80)) })
    )
    status = "prompting"
    mockSpeed.mockReturnValue(42.5)
    render(<TokenMeterBridge />)
    expect(mockSpeed).not.toHaveBeenCalled()

    act(() => {
      subscribeTokenMeter(() => {})
    })
    expect(mockSpeed).toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(500)
    })

    // 80 Latin characters at 4 characters per token.
    expect(getTokenMeterSnapshot()).toEqual({
      totalTokens: null,
      liveTokens: 20,
      tokensPerSecond: 42.5,
      streaming: true,
    })
  })

  it("clears the live reading when the turn ends", () => {
    runtime.byConversationId.set(
      7,
      session({ total: 300, live: liveMessage("a".repeat(80)) })
    )
    status = "prompting"
    mockSpeed.mockReturnValue(30)
    const { rerender } = render(<TokenMeterBridge />)
    act(() => {
      subscribeTokenMeter(() => {})
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(getTokenMeterSnapshot()).toMatchObject({
      streaming: true,
      liveTokens: 20,
      tokensPerSecond: 30,
    })

    runtime.byConversationId.set(7, session({ total: 300 }))
    status = "connected"
    rerender(<TokenMeterBridge />)

    expect(getTokenMeterSnapshot()).toEqual({
      totalTokens: 300,
      liveTokens: 0,
      tokensPerSecond: null,
      streaming: false,
    })
  })

  it("goes idle when the bridge unmounts", () => {
    runtime.byConversationId.set(7, session({ total: 300 }))
    const { unmount } = render(<TokenMeterBridge />)
    expect(getTokenMeterSnapshot().totalTokens).toBe(300)

    unmount()

    expect(getTokenMeterSnapshot()).toEqual(IDLE_TOKEN_METER_SNAPSHOT)
  })
})
