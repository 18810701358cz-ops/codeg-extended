import type { LiveMessage } from "@/contexts/acp-connections-context"
import { TokenCountAccumulator } from "@/lib/token-speed"
import type { SessionStats } from "@/lib/types"
import type { TokenMeterSnapshot } from "./types"

/**
 * The state behind `ctx.tokens`: what the focused conversation has been
 * reported to spend (the settled half) and what its turn in flight is doing
 * right now (the live half).
 *
 * Two writers feed it and neither needs the other's inputs. The bridge
 * (`components/plugin-host/token-meter-bridge.tsx`) writes the settled half
 * whenever the focus, the stats or the streaming status change; a sampler it
 * mounts only while a turn streams and a plugin listens writes the live half
 * twice a second. The snapshot is rebuilt from both on every write, so a stats
 * refresh in the middle of a turn cannot blank the speed reading.
 */

/** The settled half: changes with the focus, the stats and the status. */
export interface TokenMeterSettled {
  /** See `resolveTotalTokens`. */
  totalTokens: number | null
  /** The connection is prompting and a live message exists. */
  streaming: boolean
  /** The live message a sample must belong to in order to count. */
  liveMessageId: string | null
}

/** The live half: one reading of the turn in flight. */
export interface TokenMeterLiveSample {
  messageId: string
  liveTokens: number
  tokensPerSecond: number | null
}

export const IDLE_TOKEN_METER_SETTLED: TokenMeterSettled = Object.freeze({
  totalTokens: null,
  streaming: false,
  liveMessageId: null,
})

export const IDLE_TOKEN_METER_SNAPSHOT: TokenMeterSnapshot = Object.freeze({
  totalTokens: null,
  liveTokens: 0,
  tokensPerSecond: null,
  streaming: false,
})

/**
 * The conversation's cumulative token count, by the rule the composer's usage
 * popover uses for its "Total" row (`components/chat/composer-context-usage.tsx`):
 * the agent's own `total_tokens` when it reports a positive one, otherwise the
 * sum of the four counters, and `null` when every counter is zero, which means
 * "nobody said" rather than "nothing was spent".
 *
 * Deliberately a copy of that rule and not an import: sharing it would mean
 * editing an upstream file. `token-meter.test.ts` pins the behaviour.
 */
export function resolveTotalTokens(
  stats: SessionStats | null | undefined
): number | null {
  if (!stats) return null
  const reported = stats.total_tokens
  if (reported != null && reported > 0) return reported
  const usage = stats.total_usage
  if (!usage) return null
  const sum =
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  return sum > 0 ? sum : null
}

/**
 * Joins the two halves. A sample counts only while it belongs to the live
 * message the settled half names, so a reading left over from the previous
 * turn can never show up at the start of the next one.
 */
export function buildTokenMeterSnapshot(
  settled: TokenMeterSettled,
  sample: TokenMeterLiveSample | null
): TokenMeterSnapshot {
  const live =
    settled.streaming &&
    sample !== null &&
    sample.messageId === settled.liveMessageId
      ? sample
      : null
  return {
    totalTokens: settled.totalTokens,
    liveTokens: live ? live.liveTokens : 0,
    tokensPerSecond: live ? live.tokensPerSecond : null,
    streaming: settled.streaming,
  }
}

/**
 * Running token estimate for a turn in flight. It scores the same blocks
 * `useTokenOutputSpeed` does (the root agent's text and thinking), so the
 * count and the speed describe the same output. Incremental: only text
 * appended since the last call is scanned.
 */
export class LiveTokenCounter {
  private readonly counts = new TokenCountAccumulator()
  private messageId: string | null = null

  measure(message: LiveMessage): number {
    // A snapshot hydration swaps the message out wholesale instead of
    // appending to it, so the cached per-block prefixes can describe entirely
    // different text. Re-seat on an identity change.
    if (message.id !== this.messageId) {
      this.messageId = message.id
      this.counts.reset()
    }
    this.counts.beginPass()
    for (const block of message.content) {
      if (
        (block.type === "text" || block.type === "thinking") &&
        block.parentToolUseId == null
      ) {
        this.counts.push(block.text)
      }
    }
    return this.counts.endPass()
  }
}

type Listener = (snapshot: TokenMeterSnapshot) => void

let settled: TokenMeterSettled = IDLE_TOKEN_METER_SETTLED
let sample: TokenMeterLiveSample | null = null
let current: TokenMeterSnapshot = IDLE_TOKEN_METER_SNAPSHOT
const listeners = new Set<Listener>()
const listenerWatchers = new Set<() => void>()

function sameSnapshot(a: TokenMeterSnapshot, b: TokenMeterSnapshot): boolean {
  return (
    a.totalTokens === b.totalTokens &&
    a.liveTokens === b.liveTokens &&
    a.tokensPerSecond === b.tokensPerSecond &&
    a.streaming === b.streaming
  )
}

function recompute(): void {
  const next = buildTokenMeterSnapshot(settled, sample)
  if (sameSnapshot(current, next)) return
  current = Object.freeze(next)
  for (const listener of Array.from(listeners)) {
    try {
      listener(current)
    } catch (err) {
      console.error("[plugin-host] Error in token meter listener:", err)
    }
  }
}

function notifyWatchers(): void {
  for (const watcher of Array.from(listenerWatchers)) {
    try {
      watcher()
    } catch (err) {
      console.error("[plugin-host] Error in token meter watcher:", err)
    }
  }
}

export function setTokenMeterSettled(next: TokenMeterSettled): void {
  settled = next
  recompute()
}

export function setTokenMeterLiveSample(
  next: TokenMeterLiveSample | null
): void {
  sample = next
  recompute()
}

export function getTokenMeterSnapshot(): TokenMeterSnapshot {
  return current
}

export function subscribeTokenMeter(fn: Listener): () => void {
  listeners.add(fn)
  notifyWatchers()
  return () => {
    if (listeners.delete(fn)) notifyWatchers()
  }
}

/** Whether any plugin is listening: the bridge mounts its sampler only then. */
export function hasTokenMeterListeners(): boolean {
  return listeners.size > 0
}

/** Fires when a listener is added or removed (`useSyncExternalStore` source). */
export function watchTokenMeterListeners(cb: () => void): () => void {
  listenerWatchers.add(cb)
  return () => {
    listenerWatchers.delete(cb)
  }
}

/** Back to the start state, listeners included. For tests. */
export function resetTokenMeter(): void {
  settled = IDLE_TOKEN_METER_SETTLED
  sample = null
  current = IDLE_TOKEN_METER_SNAPSHOT
  listeners.clear()
  listenerWatchers.clear()
}
