import { create } from "zustand"

import type { MessageNavEntry } from "@/components/message/conversation-message-nav"
import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"
import type { FileChangeStat } from "@/lib/session-files"
import type { PlanEntryInfo } from "@/lib/types"

/**
 * What a conversation's transcript knows about itself that the Session Details
 * side panel shows: the message navigator, the agent's plan and the sub-agents
 * it delegated to.
 *
 * All three are derived inside `MessageListView`, which owns the adapted
 * thread they come from and the virtual list a navigator jump has to scroll.
 * The side panel sits in another branch of the tree, so the transcript of the
 * conversation page publishes them here, keyed by the runtime conversation id
 * (the tab's `runtimeConversationId ?? conversationId`), and the panel reads
 * the active tab's entry.
 *
 * `publishTranscriptInsights` keeps every unchanged part of the previous value
 * (see `mergeTranscriptInsights`), so a streaming batch that changes none of
 * this re-renders no reader: the transcript re-derives on every batch, but the
 * store only moves when a plan entry, a sub-agent or a navigator row does.
 */

export interface TranscriptNavInsights {
  /** Every user message of the conversation, loaded or not. */
  count: number
  /** One row per user message. Only computed while a surface wants them (see
   *  `demandTranscriptNav`): grouping them parses every turn's diffs. */
  entries: readonly MessageNavEntry[]
  /** The messages above the loaded window aren't listed yet: their outline is
   *  loading, or failed to. */
  earlier: "loading" | "error" | null
  /** The message being paged in for a jump, if any. */
  revealingTurnId: string | null
}

export interface TranscriptPlanInsights {
  /** The latest plan: the live reply's when it has one, else the history's. */
  entries: readonly PlanEntryInfo[]
  /** The agent is replying, so an in-progress entry is really in progress. */
  streaming: boolean
}

export interface TranscriptSubAgentInsights {
  /** The delegations in the latest agent reply. */
  reply: readonly DelegationCardSource[]
  /** The delegations across the whole loaded thread, one row per sub-agent. */
  conversation: readonly DelegationCardSource[]
  /** History above the loaded window isn't loaded, so `conversation` can be
   *  missing the sub-agents it started. */
  partial: boolean
  /** That history is being paged in. */
  loadingOlder: boolean
}

export interface TranscriptInsightsActions {
  /** Scroll the transcript to a message, paging it in first when it sits
   *  above the loaded window. */
  selectNavEntry: (entry: MessageNavEntry) => void
  /** Fetch the outline of the messages above the window again. */
  retryEarlierNav: () => void
  /** Page in the whole history above the loaded window. */
  loadEarlierHistory: () => void
}

export interface TranscriptInsights {
  nav: TranscriptNavInsights
  plan: TranscriptPlanInsights
  subAgents: TranscriptSubAgentInsights
  /** Must keep its identity for as long as its publisher lives: a new object
   *  counts as a change. */
  actions: TranscriptInsightsActions
}

interface PublishedInsights {
  /** The transcript that published it. A view remounted for a reparent
   *  publishes under the same conversation id before the old one unmounts, and
   *  the old one's retraction must not take the new one's value with it. */
  owner: string
  insights: TranscriptInsights
}

interface TranscriptInsightsState {
  byConversationId: ReadonlyMap<number, PublishedInsights>
  /** How many mounted surfaces currently show a conversation's navigator rows. */
  navDemand: ReadonlyMap<number, number>
}

export const useTranscriptInsightsStore = create<TranscriptInsightsState>(
  () => ({
    byConversationId: new Map(),
    navDemand: new Map(),
  })
)

function sameFile(a: FileChangeStat, b: FileChangeStat): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.path === b.path &&
      a.additions === b.additions &&
      a.deletions === b.deletions &&
      a.diff === b.diff)
  )
}

function sameNavEntry(a: MessageNavEntry, b: MessageNavEntry): boolean {
  return (
    a.turnId === b.turnId &&
    a.threadIndex === b.threadIndex &&
    a.turnIndex === b.turnIndex &&
    a.ordinal === b.ordinal &&
    a.label === b.label &&
    a.additions === b.additions &&
    a.deletions === b.deletions &&
    a.hasChanges === b.hasChanges &&
    (a.files === b.files ||
      (a.files.length === b.files.length &&
        a.files.every((file, i) => sameFile(file, b.files[i]))))
  )
}

function samePlanEntry(a: PlanEntryInfo, b: PlanEntryInfo): boolean {
  return (
    a.content === b.content &&
    a.status === b.status &&
    a.priority === b.priority
  )
}

function sameMeta(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined
): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  // Small JSON snapshots; a streaming reply re-adapts its parts on every batch,
  // so equal content routinely arrives as a new object.
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function sameDelegationSource(
  a: DelegationCardSource,
  b: DelegationCardSource
): boolean {
  return (
    a === b ||
    (a.parentToolUseId === b.parentToolUseId &&
      (a.taskIdHint ?? null) === (b.taskIdHint ?? null) &&
      (a.input ?? null) === (b.input ?? null) &&
      (a.output ?? null) === (b.output ?? null) &&
      (a.errorText ?? null) === (b.errorText ?? null) &&
      a.state === b.state &&
      sameMeta(a.meta, b.meta))
  )
}

/**
 * `next`, except that every item equal to the one `prev` holds under the same
 * key is `prev`'s object — and `prev` itself when nothing changed. Keyed rather
 * than positional so paging older history in (a prepend) keeps the rows that
 * were already there.
 */
function mergeKeyedList<T>(
  prev: readonly T[],
  next: readonly T[],
  keyOf: (item: T) => string,
  same: (a: T, b: T) => boolean
): readonly T[] {
  if (prev === next) return prev
  const previous = new Map<string, T>()
  for (const item of prev) previous.set(keyOf(item), item)
  let changed = prev.length !== next.length
  const merged = next.map((item, i) => {
    const old = previous.get(keyOf(item))
    const kept = old !== undefined && same(old, item) ? old : item
    if (kept !== prev[i]) changed = true
    return kept
  })
  return changed ? merged : prev
}

function mergePositionalList<T>(
  prev: readonly T[],
  next: readonly T[],
  same: (a: T, b: T) => boolean
): readonly T[] {
  if (prev === next) return prev
  if (prev.length !== next.length) return next
  return next.every((item, i) => same(prev[i], item)) ? prev : next
}

function mergeNav(
  prev: TranscriptNavInsights,
  next: TranscriptNavInsights
): TranscriptNavInsights {
  const entries = mergeKeyedList(
    prev.entries,
    next.entries,
    (entry) => entry.turnId,
    sameNavEntry
  )
  if (
    entries === prev.entries &&
    next.count === prev.count &&
    next.earlier === prev.earlier &&
    next.revealingTurnId === prev.revealingTurnId
  ) {
    return prev
  }
  return { ...next, entries }
}

function mergePlan(
  prev: TranscriptPlanInsights,
  next: TranscriptPlanInsights
): TranscriptPlanInsights {
  const entries = mergePositionalList(prev.entries, next.entries, samePlanEntry)
  if (entries === prev.entries && next.streaming === prev.streaming) {
    return prev
  }
  return { ...next, entries }
}

function mergeSubAgents(
  prev: TranscriptSubAgentInsights,
  next: TranscriptSubAgentInsights
): TranscriptSubAgentInsights {
  const keyOf = (source: DelegationCardSource) => source.parentToolUseId
  const reply = mergeKeyedList(
    prev.reply,
    next.reply,
    keyOf,
    sameDelegationSource
  )
  const conversation = mergeKeyedList(
    prev.conversation,
    next.conversation,
    keyOf,
    sameDelegationSource
  )
  if (
    reply === prev.reply &&
    conversation === prev.conversation &&
    next.partial === prev.partial &&
    next.loadingOlder === prev.loadingOlder
  ) {
    return prev
  }
  return { ...next, reply, conversation }
}

/**
 * `next` with every part that equals `prev`'s part replaced by `prev`'s, and
 * `prev` itself when nothing changed — so a reader that selects one part
 * re-renders only when that part does.
 */
export function mergeTranscriptInsights(
  prev: TranscriptInsights | null,
  next: TranscriptInsights
): TranscriptInsights {
  if (prev == null || prev === next) return next
  const nav = mergeNav(prev.nav, next.nav)
  const plan = mergePlan(prev.plan, next.plan)
  const subAgents = mergeSubAgents(prev.subAgents, next.subAgents)
  if (
    nav === prev.nav &&
    plan === prev.plan &&
    subAgents === prev.subAgents &&
    next.actions === prev.actions
  ) {
    return prev
  }
  return { nav, plan, subAgents, actions: next.actions }
}

/** Publish (or update) a conversation's insights. The latest publisher owns
 *  the entry. */
export function publishTranscriptInsights(
  conversationId: number,
  owner: string,
  insights: TranscriptInsights
): void {
  useTranscriptInsightsStore.setState((state) => {
    const current = state.byConversationId.get(conversationId)
    const merged = mergeTranscriptInsights(current?.insights ?? null, insights)
    if (current?.owner === owner && current.insights === merged) return state
    const byConversationId = new Map(state.byConversationId)
    byConversationId.set(conversationId, { owner, insights: merged })
    return { byConversationId }
  })
}

/** Drop a conversation's insights — only if `owner` still owns them. */
export function retractTranscriptInsights(
  conversationId: number,
  owner: string
): void {
  useTranscriptInsightsStore.setState((state) => {
    if (state.byConversationId.get(conversationId)?.owner !== owner) {
      return state
    }
    const byConversationId = new Map(state.byConversationId)
    byConversationId.delete(conversationId)
    return { byConversationId }
  })
}

/**
 * Ask for a conversation's navigator rows. Returns the release; the rows stay
 * computed while anyone holds a request.
 */
export function demandTranscriptNav(conversationId: number): () => void {
  const adjust = (delta: number) =>
    useTranscriptInsightsStore.setState((state) => {
      const count = (state.navDemand.get(conversationId) ?? 0) + delta
      const navDemand = new Map(state.navDemand)
      if (count > 0) navDemand.set(conversationId, count)
      else navDemand.delete(conversationId)
      return { navDemand }
    })
  adjust(1)
  let released = false
  return () => {
    if (released) return
    released = true
    adjust(-1)
  }
}

/** Whether a surface currently wants this conversation's navigator rows. */
export function useTranscriptNavDemanded(
  conversationId: number,
  enabled: boolean
): boolean {
  return useTranscriptInsightsStore(
    (state) => enabled && (state.navDemand.get(conversationId) ?? 0) > 0
  )
}

/**
 * One part of a conversation's published insights, or null while nothing is
 * published for it. `pick` must return a part of the insights (not a value
 * built from them) so the result keeps its identity between changes.
 */
export function useTranscriptInsightsPart<T>(
  conversationId: number | null,
  pick: (insights: TranscriptInsights) => T
): T | null {
  return useTranscriptInsightsStore((state) => {
    if (conversationId == null) return null
    const published = state.byConversationId.get(conversationId)
    return published ? pick(published.insights) : null
  })
}
