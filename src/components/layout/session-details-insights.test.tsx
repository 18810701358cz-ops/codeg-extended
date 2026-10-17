import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { MessageNavEntry } from "@/components/message/conversation-message-nav"
import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"
import {
  publishTranscriptInsights,
  retractTranscriptInsights,
  useTranscriptInsightsStore,
  type TranscriptInsights,
  type TranscriptInsightsActions,
} from "@/stores/transcript-insights-store"

// A row's model reads the live connection and delegation stores; what this
// panel decides is WHICH rows to list, so a row is just its call id here.
vi.mock("@/components/chat/sub-agent-overlay", () => ({
  SubAgentRow: ({ source }: { source: DelegationCardSource }) => (
    <div data-testid="sub-agent-row">{source.parentToolUseId}</div>
  ),
}))
// The real host pulls in every viewer drawer; none is opened here.
vi.mock("@/components/message/session-viewer-host", () => ({
  SessionViewerHost: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openSessionFileDiff: vi.fn() }),
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { path: "/repo" } }),
}))

import { SessionDetailsInsights } from "./session-details-insights"

const CONVERSATION = 7

function makeActions(): TranscriptInsightsActions {
  return {
    selectNavEntry: vi.fn(),
    retryEarlierNav: vi.fn(),
    loadEarlierHistory: vi.fn(),
  }
}

function navEntry(turnId: string, ordinal: number): MessageNavEntry {
  return {
    threadIndex: ordinal,
    turnIndex: null,
    turnId,
    ordinal,
    label: `message ${ordinal}`,
    additions: 0,
    deletions: 0,
    files: [],
    hasChanges: false,
  }
}

function source(parentToolUseId: string): DelegationCardSource {
  return {
    parentToolUseId,
    input: null,
    output: null,
    state: "output-available",
  }
}

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
      count: 0,
      entries: [],
      earlier: null,
      revealingTurnId: null,
      ...over.nav,
    },
    plan: { entries: [], streaming: false, ...over.plan },
    subAgents: {
      reply: [],
      conversation: [],
      partial: false,
      loadingOlder: false,
      ...over.subAgents,
    },
    actions: over.actions ?? makeActions(),
  }
}

function publish(value: TranscriptInsights) {
  act(() => publishTranscriptInsights(CONVERSATION, "transcript", value))
}

function renderPanel(active = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionDetailsInsights conversationId={CONVERSATION} active={active} />
    </NextIntlClientProvider>
  )
}

function navDemand(): number {
  return useTranscriptInsightsStore.getState().navDemand.get(CONVERSATION) ?? 0
}

const rowIds = () =>
  screen.queryAllByTestId("sub-agent-row").map((row) => row.textContent)

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  retractTranscriptInsights(CONVERSATION, "transcript")
  useTranscriptInsightsStore.setState({
    byConversationId: new Map(),
    navDemand: new Map(),
  })
})

describe("SessionDetailsInsights", () => {
  it("shows nothing while the transcript has published nothing", () => {
    const { container } = renderPanel()
    expect(container).toBeEmptyDOMElement()
  })

  it("shows nothing while there is no plan, sub-agent or message", () => {
    publish(insights())
    const { container } = renderPanel()
    expect(container).toBeEmptyDOMElement()
  })

  describe("plan", () => {
    const plan = {
      entries: [
        { content: "Read the code", status: "completed", priority: "high" },
        { content: "Write the fix", status: "in_progress", priority: "low" },
      ],
      streaming: true,
    }

    it("lists the plan under its progress", () => {
      publish(insights({ plan }))
      renderPanel()
      const header = screen.getByRole("button", { name: /Agent Plan/ })
      expect(header).toHaveAttribute("aria-expanded", "true")
      expect(header).toHaveTextContent("1/2")
      expect(screen.getByText("Read the code")).toBeInTheDocument()
      expect(screen.getByText("Write the fix")).toBeInTheDocument()
    })

    it("collapses, and stays collapsed for the next panel", () => {
      publish(insights({ plan }))
      const { unmount } = renderPanel()
      fireEvent.click(screen.getByRole("button", { name: /Agent Plan/ }))
      expect(screen.queryByText("Read the code")).not.toBeInTheDocument()
      unmount()
      renderPanel()
      expect(
        screen.getByRole("button", { name: /Agent Plan/ })
      ).toHaveAttribute("aria-expanded", "false")
      expect(screen.queryByText("Read the code")).not.toBeInTheDocument()
    })

    it("follows a plan that changes while it shows", () => {
      publish(insights({ plan }))
      renderPanel()
      publish(
        insights({
          plan: {
            ...plan,
            entries: [
              plan.entries[0],
              { ...plan.entries[1], status: "completed" },
            ],
          },
        })
      )
      expect(
        screen.getByRole("button", { name: /Agent Plan/ })
      ).toHaveTextContent("2/2")
    })
  })

  describe("sub-agents", () => {
    const subAgents = {
      reply: [source("tu-3")],
      conversation: [source("tu-1"), source("tu-2"), source("tu-3")],
    }

    it("lists the current message's sub-agents by default", () => {
      publish(insights({ subAgents }))
      renderPanel()
      expect(rowIds()).toEqual(["tu-3"])
      expect(
        screen.getByRole("button", { name: "Current message" })
      ).toHaveAttribute("aria-pressed", "true")
      expect(
        screen.getByRole("button", { name: /Sub-agents/ })
      ).toHaveTextContent("1")
    })

    it("switches to the whole session's sub-agents, and remembers it", () => {
      publish(insights({ subAgents }))
      const { unmount } = renderPanel()
      fireEvent.click(screen.getByRole("button", { name: "Current session" }))
      expect(rowIds()).toEqual(["tu-1", "tu-2", "tu-3"])
      expect(
        screen.getByRole("button", { name: "Current session" })
      ).toHaveAttribute("aria-pressed", "true")
      expect(
        screen.getByRole("button", { name: /Sub-agents/ })
      ).toHaveTextContent("3")
      unmount()
      renderPanel()
      expect(rowIds()).toEqual(["tu-1", "tu-2", "tu-3"])
    })

    it("says so when the current message started none", () => {
      publish(insights({ subAgents: { ...subAgents, reply: [] } }))
      renderPanel()
      expect(rowIds()).toEqual([])
      expect(
        screen.getByText("The current message started no sub-agents.")
      ).toBeInTheDocument()
    })

    it("is absent while the conversation started none", () => {
      publish(insights({ subAgents: { reply: [], conversation: [] } }))
      renderPanel()
      expect(
        screen.queryByRole("button", { name: /Sub-agents/ })
      ).not.toBeInTheDocument()
    })

    it("offers to load the history above the window in the session scope", () => {
      const actions = makeActions()
      publish(insights({ subAgents: { ...subAgents, partial: true }, actions }))
      renderPanel()
      // Not in the current-message scope: the latest reply is always loaded.
      expect(
        screen.queryByRole("button", { name: "Load all" })
      ).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Current session" }))
      fireEvent.click(screen.getByRole("button", { name: "Load all" }))
      expect(actions.loadEarlierHistory).toHaveBeenCalledTimes(1)
    })

    it("can't be asked twice while that history loads", () => {
      localStorage.setItem(
        "workspace:session-details:sub-agent-scope",
        "conversation"
      )
      publish(
        insights({
          subAgents: { ...subAgents, partial: true, loadingOlder: true },
        })
      )
      renderPanel()
      expect(screen.getByRole("button", { name: "Load all" })).toBeDisabled()
    })
  })

  describe("message navigator", () => {
    const nav = {
      count: 2,
      entries: [navEntry("u1", 1), navEntry("u2", 2)],
    }

    it("asks the transcript for its rows while they show", () => {
      publish(insights({ nav }))
      const { unmount } = renderPanel()
      expect(navDemand()).toBe(1)
      unmount()
      expect(navDemand()).toBe(0)
    })

    it("doesn't ask while the panel is hidden", () => {
      publish(insights({ nav }))
      renderPanel(false)
      expect(navDemand()).toBe(0)
      // Still listed, by count, for when it shows.
      expect(
        screen.getByRole("button", { name: /Message navigation/ })
      ).toHaveTextContent("2")
    })

    it("stops asking once collapsed", () => {
      publish(insights({ nav }))
      renderPanel()
      fireEvent.click(
        screen.getByRole("button", { name: /Message navigation/ })
      )
      expect(navDemand()).toBe(0)
      expect(screen.queryByText("message 1")).not.toBeInTheDocument()
    })

    it("jumps to a message through the transcript", () => {
      const actions = makeActions()
      publish(insights({ nav, actions }))
      renderPanel()
      fireEvent.click(screen.getByText("message 2"))
      expect(actions.selectNavEntry).toHaveBeenCalledWith(nav.entries[1])
    })

    it("is absent, and asks nothing, while there are no messages", () => {
      publish(insights({ nav: { count: 0, entries: [] } }))
      renderPanel()
      expect(
        screen.queryByRole("button", { name: /Message navigation/ })
      ).not.toBeInTheDocument()
      expect(navDemand()).toBe(0)
    })
  })

  it("lists plan, sub-agents and messages in that order", () => {
    publish(
      insights({
        plan: {
          entries: [{ content: "step", status: "pending", priority: "low" }],
        },
        subAgents: { reply: [source("tu-1")], conversation: [source("tu-1")] },
        nav: { count: 1, entries: [navEntry("u1", 1)] },
      })
    )
    renderPanel()
    const headers = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent)
    expect(headers).toEqual([
      expect.stringContaining("Agent Plan"),
      expect.stringContaining("Sub-agents"),
      expect.stringContaining("Message navigation"),
    ])
  })
})
