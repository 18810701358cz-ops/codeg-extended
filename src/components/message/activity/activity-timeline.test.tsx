import { useState, type ReactElement } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  StaticConnectionStoreProvider,
  type ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import {
  StaticDelegationProvider,
  type DelegationContextValue,
} from "@/contexts/delegation-context"
import {
  StaticWorkspaceActionsProvider,
  type WorkspaceActionsValue,
} from "@/contexts/workspace-context"
import {
  adaptMessageTurn,
  type AdaptedContentPart,
} from "@/lib/adapters/ai-elements-adapter"
import {
  MOCKUP_ADAPTER_TEXT,
  MOCKUP_ASSISTANT_TURN,
  MOCKUP_LIVE_TURN,
  toolResult,
  toolUse,
} from "@/lib/activity/__fixtures__/mockup-turn"
import type { MessageTurn } from "@/lib/types"
import { CompletedTurnContent } from "../completed-turn-content"
import { resetDisclosureStore } from "./disclosure-store"

const STORE: ConnectionStoreApi = {
  getConnection: () => undefined,
  getConnectPending: () => undefined,
  getConnectError: () => undefined,
  getActiveKey: () => null,
  subscribeKey: () => () => {},
  subscribeActiveKey: () => () => {},
}
const DELEGATION: DelegationContextValue = {
  findByParentToolUseId: () => undefined,
  findByChildConversationId: () => undefined,
  findByTaskId: () => undefined,
}
const WORKSPACE = new Proxy(
  {},
  { get: () => () => {} }
) as unknown as WorkspaceActionsValue

function renderTurn(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StaticConnectionStoreProvider store={STORE}>
        <StaticDelegationProvider value={DELEGATION}>
          <StaticWorkspaceActionsProvider value={WORKSPACE}>
            {ui}
          </StaticWorkspaceActionsProvider>
        </StaticDelegationProvider>
      </StaticConnectionStoreProvider>
    </NextIntlClientProvider>
  )
}

function partsOf(turn: MessageTurn, live = false, inProgress?: string[]) {
  return adaptMessageTurn(
    turn,
    MOCKUP_ADAPTER_TEXT,
    live,
    inProgress ? new Set(inProgress) : undefined
  ).content
}

/** The thread's current round: open, with its fold owned here (as
 *  `message-list-view` owns it in the app). */
function CurrentRound({
  parts,
  durationMs,
  completed,
}: {
  parts: AdaptedContentPart[]
  durationMs?: number
  completed: boolean
}) {
  const [open, setOpen] = useState(true)
  return (
    <CompletedTurnContent
      parts={parts}
      durationMs={durationMs}
      completed={completed}
      currentRound
      roundOpen={open}
      onRoundOpenChange={setOpen}
    />
  )
}

function renderSettled(parts: AdaptedContentPart[], durationMs = 214000) {
  return renderTurn(
    <CurrentRound parts={parts} durationMs={durationMs} completed />
  )
}

/** The header's fold control: its label. */
const foldControl = (label = "Activity") =>
  screen.getByRole("button", { name: label })

/** The timeline row whose header contains `text`. */
function rowOf(text: string | RegExp): HTMLElement {
  const row = screen.getByText(text).closest("li")
  if (!row) throw new Error(`no row for ${String(text)}`)
  return row as HTMLElement
}

beforeEach(() => {
  resetDisclosureStore()
})

describe("activity timeline: the reference turn", () => {
  it("summarizes the turn in the header, its time at the end", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const time = screen.getByText("3m 34s")
    const header = time.parentElement!
    expect(header.textContent).toBe(
      "Activity14 steps · 6 commands · 1 edit · 1 agent · 1 failed, recovered3m 34s"
    )
    expect(header.lastElementChild).toBe(time)
    expect(foldControl()).toHaveAttribute("aria-expanded", "true")
  })

  it("folds the reads and the grep into one Explored row", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const explored = rowOf("Explored")
    expect(within(explored).getByText("3 files, 1 search")).toBeTruthy()
    expect(within(explored).queryByText("84 lines")).toBeNull()

    fireEvent.click(within(explored).getAllByRole("button")[0]!)
    expect(within(explored).getByText("84 lines")).toBeTruthy()
    expect(within(explored).getByText("212 lines")).toBeTruthy()
    expect(within(explored).getByText("4 hits")).toBeTruthy()
    expect(within(explored).getAllByText("read")).toHaveLength(3)
    expect(within(explored).getByText("grep")).toBeTruthy()
  })

  it("folds the first two commands and reports that they passed", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const groups = screen.getAllByText("Ran 2 commands")
    expect(groups).toHaveLength(2)
    expect(
      within(groups[0]!.closest("li")!).getByText("all passed")
    ).toBeTruthy()
  })

  it("leaves a failure that was redone folded, with its exit code", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const failed = screen
      .getAllByText("pnpm --filter web test")
      .map((el) => el.closest("li")!)
      .find((li) => li.getAttribute("data-status") === "failed")!
    expect(within(failed).getByText("exit 1")).toBeTruthy()
    expect(within(failed).queryByText(/Tests: 1 failed/)).toBeNull()
    expect(
      within(failed).getByRole("img", {
        name: "Command, failed with exit code 1",
      })
    ).toBeTruthy()
  })

  it("names the MCP server and summarizes the call", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const mcp = rowOf("get_issue")
    expect(within(mcp).getByText("mcp · linear")).toBeTruthy()
    expect(
      within(mcp).getByText("HVAC-212 · Inactive bindings leak into report")
    ).toBeTruthy()
    fireEvent.click(within(mcp).getByRole("button"))
    expect(within(mcp).getByText("args")).toBeTruthy()
    expect(within(mcp).getByText("result")).toBeTruthy()
  })

  it("shows the edited file, its changed lines and counts", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const edit = rowOf("Edited")
    expect(within(edit).getByText("query_tasks.py")).toBeTruthy()
    expect(within(edit).getByText("L44–46")).toBeTruthy()
    expect(within(edit).getByText("+3")).toBeTruthy()
    expect(within(edit).getByText("−1")).toBeTruthy()
    fireEvent.click(within(edit).getByRole("button"))
    expect(
      within(edit).getByText(
        "binding for binding in item.source_bindings if binding.active",
        {
          exact: false,
        }
      )
    ).toBeTruthy()
  })

  it("titles a thought and opens to its body without repeating the title", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const thought = rowOf("Summarizing log status")
    fireEvent.click(within(thought).getByRole("button"))
    expect(within(thought).getByText(/I need to gather the logs/)).toBeTruthy()
    expect(within(thought).getAllByText("Summarizing log status")).toHaveLength(
      1
    )
  })

  it("hides and shows the process, keeping the answer", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    fireEvent.click(foldControl())
    expect(foldControl()).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("Explored")).toBeNull()
    expect(screen.getByText(/The web build is clean/)).toBeTruthy()
    fireEvent.click(foldControl())
    expect(foldControl()).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Explored")).toBeTruthy()
  })

  it("draws the header's chevron after its text, turned while open", () => {
    // Like a row's: after the summary, pointing down while the process shows.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const summary = screen.getByText(/14 steps/)
    const header = screen.getByText("3m 34s").parentElement!
    const chevron = header.querySelector("svg.lucide-chevron-right")!
    expect(
      summary.compareDocumentPosition(chevron) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(chevron.getAttribute("class")).toMatch(/\brotate-90\b/)
    fireEvent.click(foldControl())
    expect(chevron.getAttribute("class")).not.toMatch(/\brotate-90\b/)
  })

  it("folds and unfolds from anywhere on the header", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    fireEvent.click(screen.getByText(/14 steps/))
    expect(foldControl()).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("Explored")).toBeNull()
    fireEvent.click(screen.getByText("3m 34s"))
    expect(foldControl()).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Explored")).toBeTruthy()
  })

  it("turns an open row's chevron to point down in either direction", () => {
    // Mirrored under RTL, the chevron has to turn the other way.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const thought = rowOf("Summarizing log status")
    fireEvent.click(within(thought).getByRole("button"))
    const chevron = thought.querySelector("svg.lucide-chevron-right")
    expect(chevron?.getAttribute("class")).toMatch(
      /\brotate-90\b.*\brtl:-rotate-90\b/
    )
  })

  it("sets row headers on the 1.5rem line the rail is drawn for", () => {
    // tailwind-merge drops a line height that a later font size follows; the
    // rings, dots and chevrons are placed for this line.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const explored = within(rowOf("Explored")).getAllByRole("button")[0]!
    expect(explored.className).toMatch(/\btext-sm\b.*\bleading-6\b/)
    fireEvent.click(explored)
    const child = within(rowOf(/\/Makefile$/)).getByRole("button")
    expect(child.className).toMatch(/\bleading-6\b/)
  })
})

describe("activity timeline: failures", () => {
  const FAILURE: MessageTurn = {
    id: "turn-f",
    role: "assistant",
    timestamp: "2026-10-22T09:00:00Z",
    blocks: [
      toolUse("f1", "Bash", { command: "pnpm build" }),
      toolResult("f1", "Type error\n[terminal exited: exit code: 2]", true),
      { type: "text", text: "It does not build." },
    ],
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("opens a failure nobody redid and says so in red in the header", () => {
    renderSettled(partsOf(FAILURE))
    expect(screen.getByText("1 failed")).toBeTruthy()
    const row = rowOf("pnpm build")
    expect(within(row).getByText("exit 2")).toBeTruthy()
    expect(within(row).getByText(/Type error/)).toBeTruthy()
  })

  it("leaves the failure link and a text selection to themselves", () => {
    renderSettled(partsOf(FAILURE))
    fireEvent.click(screen.getByText("1 failed"))
    expect(foldControl()).toHaveAttribute("aria-expanded", "true")
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "1 failed",
    } as Selection)
    fireEvent.click(screen.getByText("3m 34s"))
    expect(foldControl()).toHaveAttribute("aria-expanded", "true")
  })
})

describe("activity timeline: a live turn", () => {
  it("shows the running command with the tail of its output", () => {
    renderTurn(
      <CurrentRound
        parts={partsOf(MOCKUP_LIVE_TURN, true, ["l3"])}
        completed={false}
      />
    )
    expect(screen.getByText("Working")).toBeTruthy()
    const row = rowOf("pnpm --filter web test -- --watch=false")
    expect(row.getAttribute("data-status")).toBe("running")
    expect(within(row).getByText(/lib\/state\.test\.ts/)).toBeTruthy()
  })
})

describe("activity timeline: where the rail ends", () => {
  // The rail itself is CSS (globals.css): the list says whether it is done.
  const list = () => document.querySelector(".activity-timeline")!

  it("ends a finished reply's steps on the end mark", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    expect(list()).toHaveAttribute("data-end", "reached")
  })

  it("keeps the room for the mark, but not the mark, while the reply runs", () => {
    renderTurn(
      <CurrentRound
        parts={partsOf(MOCKUP_LIVE_TURN, true, ["l3"])}
        completed={false}
      />
    )
    expect(list()).toHaveAttribute("data-end", "pending")
  })

  it("ends an open group's members on their own mark once the group is done", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const group = rowOf("Explored")
    fireEvent.click(within(group).getAllByRole("button")[0]!)
    expect(group.querySelector(".activity-children")).toHaveAttribute(
      "data-end",
      "reached"
    )
  })

  it("holds a running group's mark back, and draws none under its folded member", () => {
    const LIVE: MessageTurn = {
      id: "turn-g",
      role: "assistant",
      timestamp: "2026-10-22T09:00:00Z",
      blocks: [
        toolUse("g1", "Bash", { command: "pnpm lint" }),
        toolResult("g1", "ok"),
        toolUse("g2", "Bash", { command: "pnpm test" }),
      ],
    }
    renderTurn(
      <CurrentRound parts={partsOf(LIVE, true, ["g2"])} completed={false} />
    )
    const group = rowOf("Running 2 commands")
    // Folded, the running member shows under the header: one row, no list.
    expect(group.querySelector(".activity-children")).not.toHaveAttribute(
      "data-end"
    )
    fireEvent.click(within(group).getAllByRole("button")[0]!)
    expect(group.querySelector(".activity-children")).toHaveAttribute(
      "data-end",
      "pending"
    )
  })
})

describe("activity timeline: replies without steps", () => {
  it("keeps a Reply header with no fold control", () => {
    renderSettled([{ type: "text", text: "Already on main." }], 3000)
    expect(screen.getByText("Reply")).toBeTruthy()
    expect(screen.getByText("3s")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
    expect(document.querySelector("svg.lucide-chevron-right")).toBeNull()
  })
})
