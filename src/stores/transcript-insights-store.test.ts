import { afterEach, describe, expect, it, vi } from "vitest"

import type { MessageNavEntry } from "@/components/message/conversation-message-nav"
import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"
import {
  demandTranscriptNav,
  mergeTranscriptInsights,
  publishTranscriptInsights,
  retractTranscriptInsights,
  useTranscriptInsightsStore,
  type TranscriptInsights,
  type TranscriptInsightsActions,
} from "./transcript-insights-store"

const actions: TranscriptInsightsActions = {
  selectNavEntry: vi.fn(),
  retryEarlierNav: vi.fn(),
  loadEarlierHistory: vi.fn(),
}

function navEntry(
  turnId: string,
  over: Partial<MessageNavEntry> = {}
): MessageNavEntry {
  return {
    threadIndex: 0,
    turnIndex: null,
    turnId,
    ordinal: 1,
    label: `message ${turnId}`,
    additions: 0,
    deletions: 0,
    files: [],
    hasChanges: false,
    ...over,
  }
}

function source(
  parentToolUseId: string,
  over: Partial<DelegationCardSource> = {}
): DelegationCardSource {
  return {
    parentToolUseId,
    input: '{"agent_type":"codex","task":"t"}',
    output: null,
    errorText: null,
    state: "input-available",
    meta: null,
    ...over,
  }
}

/** Built fresh on every call: equal content, new objects — what a streaming
 *  batch hands the store. */
function insights(
  over: {
    nav?: Partial<TranscriptInsights["nav"]>
    plan?: Partial<TranscriptInsights["plan"]>
    subAgents?: Partial<TranscriptInsights["subAgents"]>
    actions?: TranscriptInsightsActions
  } = {}
): TranscriptInsights {
  return {
    nav: {
      count: 2,
      entries: [navEntry("u1"), navEntry("u2", { ordinal: 2 })],
      earlier: null,
      revealingTurnId: null,
      ...over.nav,
    },
    plan: {
      entries: [
        { content: "step one", status: "completed", priority: "high" },
        { content: "step two", status: "in_progress", priority: "medium" },
      ],
      streaming: true,
      ...over.plan,
    },
    subAgents: {
      reply: [source("tu-2")],
      conversation: [source("tu-1"), source("tu-2")],
      partial: false,
      loadingOlder: false,
      ...over.subAgents,
    },
    actions: over.actions ?? actions,
  }
}

function published(conversationId: number): TranscriptInsights | undefined {
  return useTranscriptInsightsStore
    .getState()
    .byConversationId.get(conversationId)?.insights
}

afterEach(() => {
  useTranscriptInsightsStore.setState({
    byConversationId: new Map(),
    navDemand: new Map(),
  })
})

describe("mergeTranscriptInsights", () => {
  it("keeps the previous value when the new one has equal content", () => {
    const prev = insights()
    expect(mergeTranscriptInsights(prev, insights())).toBe(prev)
  })

  it("replaces only the part that changed", () => {
    const prev = insights()
    const next = mergeTranscriptInsights(
      prev,
      insights({ plan: { streaming: false } })
    )
    expect(next).not.toBe(prev)
    expect(next.plan).not.toBe(prev.plan)
    expect(next.plan.streaming).toBe(false)
    expect(next.plan.entries).toBe(prev.plan.entries)
    expect(next.nav).toBe(prev.nav)
    expect(next.subAgents).toBe(prev.subAgents)
  })

  it("keeps the unchanged rows of a changed list, matched by key", () => {
    const prev = insights()
    // A page of older history prepended: a new row above two kept ones.
    const next = mergeTranscriptInsights(
      prev,
      insights({
        nav: {
          count: 3,
          entries: [
            navEntry("u0", { ordinal: 1 }),
            navEntry("u1"),
            navEntry("u2", { ordinal: 2 }),
          ],
        },
      })
    )
    expect(next.nav.entries).toHaveLength(3)
    expect(next.nav.entries[1]).toBe(prev.nav.entries[0])
    expect(next.nav.entries[2]).toBe(prev.nav.entries[1])
  })

  it("notices a changed file inside a row", () => {
    const file = {
      id: "f1",
      path: "/repo/a.ts",
      additions: 1,
      deletions: 0,
      diff: "@@ -0,0 +1 @@\n+a",
    }
    const prev = insights({
      nav: { entries: [navEntry("u1", { files: [file], hasChanges: true })] },
    })
    const next = mergeTranscriptInsights(
      prev,
      insights({
        nav: {
          entries: [
            navEntry("u1", {
              files: [{ ...file, additions: 2, diff: "@@ -0,0 +1,2 @@" }],
              hasChanges: true,
            }),
          ],
        },
      })
    )
    expect(next.nav.entries[0]).not.toBe(prev.nav.entries[0])
    expect(next.nav.entries[0].files[0].additions).toBe(2)
  })

  it("treats a sub-agent with equal fields in a new object as unchanged", () => {
    const prev = insights({
      subAgents: {
        reply: [source("tu-1", { meta: { "codeg.delegation": { a: 1 } } })],
      },
    })
    const next = mergeTranscriptInsights(
      prev,
      insights({
        subAgents: {
          reply: [source("tu-1", { meta: { "codeg.delegation": { a: 1 } } })],
        },
      })
    )
    expect(next).toBe(prev)
  })

  it("sees a sub-agent's new state", () => {
    const prev = insights()
    const next = mergeTranscriptInsights(
      prev,
      insights({
        subAgents: {
          conversation: [
            source("tu-1"),
            source("tu-2", { state: "output-available", output: "{}" }),
          ],
        },
      })
    )
    expect(next.subAgents).not.toBe(prev.subAgents)
    expect(next.subAgents.conversation[0]).toBe(prev.subAgents.conversation[0])
    expect(next.subAgents.conversation[1].state).toBe("output-available")
    expect(next.subAgents.reply).toBe(prev.subAgents.reply)
  })

  it("counts new actions as a change", () => {
    const prev = insights()
    const otherActions = { ...actions }
    const next = mergeTranscriptInsights(
      prev,
      insights({ actions: otherActions })
    )
    expect(next).not.toBe(prev)
    expect(next.actions).toBe(otherActions)
    expect(next.nav).toBe(prev.nav)
  })
})

describe("publishTranscriptInsights", () => {
  it("wakes no subscriber when republished content is unchanged", () => {
    publishTranscriptInsights(7, "owner-a", insights())
    const first = published(7)
    const listener = vi.fn()
    const unsubscribe = useTranscriptInsightsStore.subscribe(listener)
    publishTranscriptInsights(7, "owner-a", insights())
    expect(listener).not.toHaveBeenCalled()
    expect(published(7)).toBe(first)
    publishTranscriptInsights(7, "owner-a", insights({ nav: { count: 3 } }))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(published(7)?.nav.count).toBe(3)
    unsubscribe()
  })

  it("keeps each conversation's insights apart", () => {
    publishTranscriptInsights(1, "owner-a", insights({ nav: { count: 1 } }))
    publishTranscriptInsights(2, "owner-b", insights({ nav: { count: 5 } }))
    expect(published(1)?.nav.count).toBe(1)
    expect(published(2)?.nav.count).toBe(5)
  })
})

describe("retractTranscriptInsights", () => {
  it("drops the publisher's insights", () => {
    publishTranscriptInsights(7, "owner-a", insights())
    retractTranscriptInsights(7, "owner-a")
    expect(published(7)).toBeUndefined()
  })

  // A view remounted for a reparent publishes before the old one unmounts.
  it("leaves insights a later publisher took over", () => {
    publishTranscriptInsights(7, "old-view", insights({ nav: { count: 1 } }))
    publishTranscriptInsights(7, "new-view", insights({ nav: { count: 2 } }))
    retractTranscriptInsights(7, "old-view")
    expect(published(7)?.nav.count).toBe(2)
  })
})

describe("demandTranscriptNav", () => {
  const demand = (id: number) =>
    useTranscriptInsightsStore.getState().navDemand.get(id) ?? 0

  it("counts every holder and releases each once", () => {
    const releaseA = demandTranscriptNav(7)
    const releaseB = demandTranscriptNav(7)
    expect(demand(7)).toBe(2)
    releaseA()
    releaseA()
    expect(demand(7)).toBe(1)
    releaseB()
    expect(demand(7)).toBe(0)
    expect(useTranscriptInsightsStore.getState().navDemand.has(7)).toBe(false)
  })
})
