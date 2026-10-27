import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  LiveContentBlock,
  LiveMessage,
} from "@/contexts/acp-connections-context"
import type { SessionStats } from "@/lib/types"
import {
  IDLE_TOKEN_METER_SETTLED,
  IDLE_TOKEN_METER_SNAPSHOT,
  LiveTokenCounter,
  buildTokenMeterSnapshot,
  getTokenMeterSnapshot,
  hasTokenMeterListeners,
  resetTokenMeter,
  resolveTotalTokens,
  setTokenMeterLiveSample,
  setTokenMeterSettled,
  subscribeTokenMeter,
  watchTokenMeterListeners,
} from "./token-meter"

function usage(over: Partial<NonNullable<SessionStats["total_usage"]>> = {}) {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  }
}

function stats(over: Partial<SessionStats> = {}): SessionStats {
  return { total_usage: null, total_duration_ms: 0, ...over }
}

function msg(blocks: LiveContentBlock[], id = "live-1"): LiveMessage {
  return { id, role: "assistant", content: blocks, startedAt: 0 }
}

/** A finished tool call: content the turn carries but never scores. */
const TOOL_BLOCK: LiveContentBlock = {
  type: "tool_call",
  info: {
    tool_call_id: "tc-1",
    title: "tool",
    kind: "tool",
    status: "completed",
    content: null,
    raw_input: null,
    raw_output_chunks: [],
    raw_output_total_bytes: 0,
    locations: null,
    meta: null,
    images: [],
  },
}

describe("resolveTotalTokens", () => {
  it("is null without stats", () => {
    expect(resolveTotalTokens(null)).toBeNull()
    expect(resolveTotalTokens(undefined)).toBeNull()
  })

  it("prefers the total the agent reported", () => {
    expect(
      resolveTotalTokens(
        stats({ total_tokens: 900, total_usage: usage({ input_tokens: 5 }) })
      )
    ).toBe(900)
  })

  it("falls back to the sum of the four counters", () => {
    expect(
      resolveTotalTokens(
        stats({
          total_usage: usage({
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 400,
          }),
        })
      )
    ).toBe(550)
  })

  it("treats a reported zero like a missing total", () => {
    expect(
      resolveTotalTokens(
        stats({ total_tokens: 0, total_usage: usage({ output_tokens: 7 }) })
      )
    ).toBe(7)
  })

  it("is null when every counter is zero: nobody said, rather than nothing spent", () => {
    expect(resolveTotalTokens(stats({ total_usage: usage() }))).toBeNull()
    expect(resolveTotalTokens(stats({ total_tokens: 0 }))).toBeNull()
  })
})

describe("buildTokenMeterSnapshot", () => {
  const settled = { totalTokens: 1_000, streaming: true, liveMessageId: "m2" }
  const sample = { messageId: "m2", liveTokens: 42, tokensPerSecond: 30.5 }

  it("is idle when nothing is happening", () => {
    expect(buildTokenMeterSnapshot(IDLE_TOKEN_METER_SETTLED, null)).toEqual(
      IDLE_TOKEN_METER_SNAPSHOT
    )
  })

  it("carries the live sample while its turn streams", () => {
    expect(buildTokenMeterSnapshot(settled, sample)).toEqual({
      totalTokens: 1_000,
      liveTokens: 42,
      tokensPerSecond: 30.5,
      streaming: true,
    })
  })

  it("holds a streaming turn at zero until its first sample arrives", () => {
    expect(buildTokenMeterSnapshot(settled, null)).toEqual({
      totalTokens: 1_000,
      liveTokens: 0,
      tokensPerSecond: null,
      streaming: true,
    })
  })

  it("ignores a sample left over from the previous turn", () => {
    expect(
      buildTokenMeterSnapshot(settled, { ...sample, messageId: "m1" })
    ).toMatchObject({ liveTokens: 0, tokensPerSecond: null, streaming: true })
  })

  it("ignores a sample once the turn has ended", () => {
    expect(
      buildTokenMeterSnapshot({ ...settled, streaming: false }, sample)
    ).toMatchObject({ liveTokens: 0, tokensPerSecond: null, streaming: false })
  })
})

describe("LiveTokenCounter", () => {
  it("scores text and thinking, and skips tool calls and sub-agent output", () => {
    const counter = new LiveTokenCounter()
    const total = counter.measure(
      msg([
        { type: "text", text: "a".repeat(80) },
        { type: "thinking", text: "a".repeat(80) },
        { type: "text", text: "a".repeat(800), parentToolUseId: "pt-1" },
        TOOL_BLOCK,
      ])
    )

    // 160 Latin characters at 4 characters per token.
    expect(total).toBeCloseTo(40)
  })

  it("only scans what was appended between measurements", () => {
    const counter = new LiveTokenCounter()

    expect(
      counter.measure(msg([{ type: "text", text: "a".repeat(80) }]))
    ).toBeCloseTo(20)
    expect(
      counter.measure(msg([{ type: "text", text: "a".repeat(280) }]))
    ).toBeCloseTo(70)
  })

  it("starts over when the message is replaced rather than appended to", () => {
    const counter = new LiveTokenCounter()
    counter.measure(msg([{ type: "text", text: "a".repeat(80) }], "live-1"))

    // Same length, different text: without the re-seat the cached prefix
    // would be taken for "unchanged" and the old 20 would come back.
    expect(
      counter.measure(msg([{ type: "text", text: "你".repeat(80) }], "live-2"))
    ).toBeCloseTo(80 / 1.8)
  })
})

describe("snapshot store", () => {
  beforeEach(() => {
    resetTokenMeter()
  })

  afterEach(() => {
    resetTokenMeter()
    vi.restoreAllMocks()
  })

  it("starts idle", () => {
    expect(getTokenMeterSnapshot()).toEqual(IDLE_TOKEN_METER_SNAPSHOT)
  })

  it("rebuilds the snapshot from both halves and notifies listeners", () => {
    const seen: unknown[] = []
    subscribeTokenMeter((snapshot) => seen.push(snapshot))

    setTokenMeterSettled({
      totalTokens: 500,
      streaming: true,
      liveMessageId: "m1",
    })
    setTokenMeterLiveSample({
      messageId: "m1",
      liveTokens: 10,
      tokensPerSecond: 25,
    })

    expect(seen).toEqual([
      {
        totalTokens: 500,
        liveTokens: 0,
        tokensPerSecond: null,
        streaming: true,
      },
      {
        totalTokens: 500,
        liveTokens: 10,
        tokensPerSecond: 25,
        streaming: true,
      },
    ])
  })

  it("keeps the live reading when only the settled half changes", () => {
    setTokenMeterSettled({
      totalTokens: 500,
      streaming: true,
      liveMessageId: "m1",
    })
    setTokenMeterLiveSample({
      messageId: "m1",
      liveTokens: 10,
      tokensPerSecond: 25,
    })
    setTokenMeterSettled({
      totalTokens: 900,
      streaming: true,
      liveMessageId: "m1",
    })

    expect(getTokenMeterSnapshot()).toEqual({
      totalTokens: 900,
      liveTokens: 10,
      tokensPerSecond: 25,
      streaming: true,
    })
  })

  it("does not notify when a write changes nothing", () => {
    const listener = vi.fn()
    subscribeTokenMeter(listener)

    setTokenMeterSettled({
      totalTokens: 5,
      streaming: false,
      liveMessageId: null,
    })
    setTokenMeterSettled({
      totalTokens: 5,
      streaming: false,
      liveMessageId: null,
    })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTokenMeter(listener)
    unsubscribe()

    setTokenMeterSettled({
      totalTokens: 5,
      streaming: false,
      liveMessageId: null,
    })

    expect(listener).not.toHaveBeenCalled()
  })

  it("isolates a throwing listener from the others", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const good = vi.fn()
    subscribeTokenMeter(() => {
      throw new Error("boom")
    })
    subscribeTokenMeter(good)

    setTokenMeterSettled({
      totalTokens: 1,
      streaming: false,
      liveMessageId: null,
    })

    expect(good).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
  })

  it("hands out frozen snapshots", () => {
    setTokenMeterSettled({
      totalTokens: 1,
      streaming: false,
      liveMessageId: null,
    })
    const snapshot = getTokenMeterSnapshot() as { totalTokens: number | null }

    expect(() => {
      snapshot.totalTokens = 2
    }).toThrow(TypeError)
  })

  it("tells watchers when listeners come and go", () => {
    const watcher = vi.fn()
    watchTokenMeterListeners(watcher)
    expect(hasTokenMeterListeners()).toBe(false)

    const unsubscribe = subscribeTokenMeter(() => {})
    expect(hasTokenMeterListeners()).toBe(true)
    unsubscribe()
    expect(hasTokenMeterListeners()).toBe(false)

    expect(watcher).toHaveBeenCalledTimes(2)
  })
})
