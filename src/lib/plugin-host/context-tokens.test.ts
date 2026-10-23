import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createPluginContext } from "./context"
import {
  hasTokenMeterListeners,
  resetTokenMeter,
  setTokenMeterSettled,
} from "./token-meter"
import type { PluginInfo } from "./types"

const plugin: PluginInfo = {
  id: "tokens-plugin",
  name: "Tokens Plugin",
  version: "1.0.0",
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

function settled(totalTokens: number | null) {
  return { totalTokens, streaming: false, liveMessageId: null }
}

describe("PluginContext.tokens", () => {
  beforeEach(() => {
    resetTokenMeter()
  })

  afterEach(() => {
    resetTokenMeter()
  })

  it("reads the current snapshot", () => {
    setTokenMeterSettled(settled(1234))
    const { context } = createPluginContext(plugin)

    expect(context.tokens.get()).toEqual({
      totalTokens: 1234,
      liveTokens: 0,
      tokensPerSecond: null,
      streaming: false,
    })
  })

  it("delivers changes, then unsubscribes when the plugin is disposed", () => {
    const { context, dispose } = createPluginContext(plugin)
    const seen: Array<number | null> = []
    context.tokens.onChange((snapshot) => seen.push(snapshot.totalTokens))
    expect(hasTokenMeterListeners()).toBe(true)

    setTokenMeterSettled(settled(10))
    dispose()
    setTokenMeterSettled(settled(20))

    expect(seen).toEqual([10])
    expect(hasTokenMeterListeners()).toBe(false)
  })
})
