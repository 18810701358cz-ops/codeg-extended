import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import postcss from "postcss"
import { useState, type ReactElement } from "react"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
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
import { mockTruncateLayout } from "@/test-layout"
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

function renderTurn(ui: ReactElement, workspace = WORKSPACE) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StaticConnectionStoreProvider store={STORE}>
        <StaticDelegationProvider value={DELEGATION}>
          <StaticWorkspaceActionsProvider value={workspace}>
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
      .getAllByText("Run web unit tests")
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

  it("draws the header's chevron after its text, always in view, turned while open", () => {
    // Like a row's: after the summary, pointing down while the process shows —
    // but in view folded too, not only on hover.
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
    expect(chevron.getAttribute("class")).not.toMatch(/\bopacity-0\b/)
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

  it("marks a group with the group icon and draws its chevron after the label", () => {
    // Like any row's: shown on hover, turned while open — the ring keeps its
    // icon.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    for (const label of ["Explored", "Ran 2 commands"]) {
      const group = screen.getAllByText(label)[0]!.closest("li")!
      const ring = group.querySelector(':scope > span [role="img"]')!
      expect(ring.querySelector("svg.lucide-layers")).toBeTruthy()
      expect(ring.querySelector("svg.lucide-chevron-right")).toBeNull()
      const header = within(group).getAllByRole("button")[0]!
      const chevron = header.querySelector("svg.lucide-chevron-right")!
      expect(
        within(header).getByText(label).compareDocumentPosition(chevron) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(chevron.getAttribute("class")).toMatch(/\bopacity-0\b/)
      fireEvent.click(header)
      expect(chevron.getAttribute("class")).toMatch(/\brotate-90\b/)
      expect(ring.querySelector("svg.lucide-layers")).toBeTruthy()
    }
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

  it("lets the agent's own words on a row take their own direction", () => {
    // Under an Arabic UI, English the agent wrote would inherit right to left
    // and be cut at its start; it follows its own direction instead.
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    for (const text of [
      "Summarizing log status",
      "HVAC-212 · Inactive bindings leak into report",
      "Regenerate audit report · report.md written",
      "Commit the fix",
    ]) {
      expect(screen.getByText(text)).toHaveAttribute("dir", "auto")
    }
  })

  it("sets a row's verb and a group's title in the light ink, what they act on in the dark", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    for (const label of ["Explored", "Ran 2 commands", "Edited"]) {
      expect(screen.getAllByText(label)[0]).toHaveClass("text-muted-foreground")
    }
    expect(screen.getByText("query_tasks.py")).toHaveClass("text-foreground")
  })

  it("spaces a group's members like the rows around the group", () => {
    // The same room above and below the line as a main row's header, and the
    // same gap between rows, so an open group keeps the timeline's rhythm
    // instead of packing its members together.
    const stylesheet = postcss.parse(
      readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8")
    )
    const gap = (selector: string) => {
      let value: string | undefined
      stylesheet.walkRules((rule) => {
        if (rule.selector !== selector) return
        rule.walkDecls("margin-top", (decl) => {
          value = decl.value
        })
      })
      return value
    }
    expect(gap(".activity-item + .activity-item")).toBeTruthy()
    expect(gap(".activity-child + .activity-child")).toBe(
      gap(".activity-item + .activity-item")
    )
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const explored = within(rowOf("Explored")).getAllByRole("button")[0]!
    fireEvent.click(explored)
    const child = within(rowOf(/\/Makefile$/)).getByRole("button")
    expect(child.className).toMatch(/\bpy-0\.5\b/)
    expect(explored.className).toMatch(/\bpy-0\.5\b/)
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
    const row = rowOf("Run web unit tests")
    expect(row.getAttribute("data-status")).toBe("running")
    expect(within(row).getByText(/lib\/state\.test\.ts/)).toBeTruthy()
    // Its label shimmers while it runs, as a running row's verb does.
    expect(within(row).getByText("Command")).toHaveClass("activity-shimmer")
    expect(within(row).getByText("Run web unit tests")).toHaveClass(
      "text-muted-foreground"
    )
  })
})

describe("activity timeline: where the rail ends", () => {
  // The rail itself is CSS (globals.css): the list says whether it is done.
  const list = () => document.querySelector(".activity-timeline")!

  it("ends a finished reply's steps on the end mark", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    expect(list()).toHaveAttribute("data-end", "reached")
  })

  it("levels the end marks with the line the list measures, else a footer's", () => {
    // Each mark is centred on `--activity-end-line` (use-end-mark-line.ts),
    // half its height below it; unmeasured, on a panel footer's, a group
    // member's or a line of prose's centre: 0.125rem of padding under a 1.5rem
    // line, 0.875rem above the row's bottom edge.
    const stylesheet = postcss.parse(
      readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8")
    )
    const decl = (selector: string, prop: string) => {
      let value: string | undefined
      stylesheet.walkRules((rule) => {
        if (rule.selector.replace(/\s+/g, " ") !== selector) return
        rule.walkDecls(prop, (d) => {
          value = d.value
        })
      })
      return value
    }
    // The main mark: a 0.5rem ring at the bottom of the segment's box.
    expect(
      decl(
        '.activity-timeline[data-end="reached"] > .activity-item:last-child::before',
        "bottom"
      )
    ).toBe("calc(var(--activity-end-line, 0.875rem) - 0.25rem)")
    const child =
      '.activity-children[data-end="reached"] > .activity-child:last-child[data-body]::after'
    expect(decl(child, "height")).toBe("0.375rem")
    expect(decl(child, "bottom")).toBe(
      "calc(var(--activity-end-line, 0.875rem) - 0.1875rem)"
    )
  })

  it("holds the end mark back while the reply runs", () => {
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

  it("runs the rail past the last row only beside a body under its line", () => {
    renderSettled(partsOf(MOCKUP_ASSISTANT_TURN))
    const rows = list().querySelectorAll(":scope > li")
    const last = rows[rows.length - 1] as HTMLElement
    // Folded, the last row ends the rail at its ring: no segment, no mark.
    expect(last).not.toHaveAttribute("data-body")
    fireEvent.click(within(last).getAllByRole("button")[0]!)
    expect(last).toHaveAttribute("data-body")
    // Prose is a body under its line, open or not.
    expect(
      list().querySelector(':scope > li[data-marker="dot"]')
    ).toHaveAttribute("data-body")
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

describe("activity timeline: commands", () => {
  const LONG = "pnpm --filter web test -- --watch=false --reporter=verbose"
  const RUN: MessageTurn = {
    id: "turn-c",
    role: "assistant",
    timestamp: "2026-10-22T09:00:00Z",
    blocks: [
      toolUse("c1", "Bash", { command: LONG }),
      toolResult("c1", "48 passed"),
      { type: "text", text: "All green." },
    ],
  }
  let restoreMetrics: (() => void) | null = null
  afterEach(() => {
    restoreMetrics?.()
    restoreMetrics = null
  })

  it("says the command on one line, and the whole of it in the panel when that line cuts it", () => {
    restoreMetrics = mockTruncateLayout(600, 200)
    renderSettled(partsOf(RUN))
    const row = screen.getByTitle(LONG).closest("li")!
    const line = row.querySelector(":scope > button .truncate")!
    // After the fixed label, which stands for the prompt sign on the row.
    expect(line.textContent).toBe(LONG)
    expect(line.previousElementSibling?.textContent).toBe("Command")
    expect(line.parentElement).toHaveClass("overflow-hidden")
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    const panel = row.querySelector(".activity-detail")!
    expect(panel.querySelector("pre")?.textContent).toBe(`$ ${LONG}`)
    expect(within(panel as HTMLElement).getByText("48 passed")).toBeTruthy()
  })

  it("keeps a command its line shows whole out of the panel", () => {
    renderSettled(partsOf(RUN))
    const row = screen.getByTitle(LONG).closest("li")!
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    const panel = row.querySelector(".activity-detail")!
    expect(panel.querySelector("pre")?.textContent).toBe("48 passed")
  })

  it("says what a command is for when the agent did, and opens on the command", () => {
    // After the fixed label, the agent's description is the row's title, in
    // the label's light ink — words, not a command, so no count of the
    // command's lines — and the command takes the description's place atop
    // the panel, whole.
    const DESCRIBED: MessageTurn = {
      id: "turn-d",
      role: "assistant",
      timestamp: "2026-10-22T09:00:00Z",
      blocks: [
        toolUse("d1", "Bash", {
          command: "pnpm install\npnpm --filter web test",
          description: "Install and run the web tests",
        }),
        toolResult("d1", "48 passed"),
        { type: "text", text: "All green." },
      ],
    }
    renderSettled(partsOf(DESCRIBED))
    const row = rowOf("Install and run the web tests")
    const header = within(row).getAllByRole("button")[0]!
    expect(header.textContent).toBe("CommandInstall and run the web tests")
    expect(within(header).getByText("Command")).toHaveClass(
      "text-muted-foreground"
    )
    expect(
      within(header).getByText("Install and run the web tests")
    ).toHaveClass("text-muted-foreground")
    expect(header).toHaveAttribute("title", "Install and run the web tests")
    fireEvent.click(header)
    const panel = row.querySelector(".activity-detail") as HTMLElement
    const [command, output] = panel.querySelectorAll("pre")
    expect(command?.textContent).toBe("$ pnpm install\npnpm --filter web test")
    expect(output?.textContent).toBe("48 passed")
    expect(
      within(panel).queryByText("Install and run the web tests")
    ).toBeNull()
  })

  it("scrolls a panel on the app's overlay scrollbars", () => {
    renderSettled(partsOf(RUN))
    const row = screen.getByTitle(LONG).closest("li")!
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    const box = row.querySelector(".activity-detail-box")!
    expect(
      box.querySelector("[data-overlayscrollbars-initialize]")
    ).toBeTruthy()
  })
})

describe("activity timeline: file panels", () => {
  const LAYOUT = "/repo/web/app/layout.tsx"
  const PAGE = "/repo/web/app/settings/page.tsx"
  const FILES: MessageTurn = {
    id: "turn-files",
    role: "assistant",
    timestamp: "2026-10-22T09:00:00Z",
    blocks: [
      toolUse("r1", "Read", { file_path: LAYOUT, offset: 10, limit: 2 }),
      toolResult(
        "r1",
        JSON.stringify({
          start_line: 10,
          content: "export default function RootLayout() {\n  return (",
        })
      ),
      toolUse("w1", "Write", {
        file_path: PAGE,
        content: "export default function Page() {}\n",
      }),
      toolResult("w1", `File created successfully at: ${PAGE}`),
      toolUse("e1", "Edit", {
        file_path: LAYOUT,
        old_string: "<nav>Home</nav>",
        new_string: "<nav>\n  <a>Settings</a>\n</nav>",
      }),
      toolResult("e1", `The file ${LAYOUT} has been updated successfully.`),
      { type: "text", text: "Done." },
    ],
  }

  function renderFiles() {
    const openFilePreview = vi.fn(async () => {})
    const workspace = new Proxy(
      { openFilePreview },
      {
        get: (target, key) =>
          key in target ? target[key as keyof typeof target] : () => {},
      }
    ) as unknown as WorkspaceActionsValue
    renderTurn(
      <CurrentRound parts={partsOf(FILES)} durationMs={1000} completed />,
      workspace
    )
    return openFilePreview
  }

  /** Open the row whose header names `text`, and return its panel. */
  function openPanel(text: string | RegExp): HTMLElement {
    const row = screen.getAllByText(text)[0]!.closest("li")!
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    return row.querySelector(".activity-detail") as HTMLElement
  }

  afterEach(() => {
    localStorage.removeItem("workspace:diff-view-mode")
  })

  it("heads a read with the file it read, opening it at the first line read", () => {
    const openFilePreview = renderFiles()
    const panel = openPanel(LAYOUT)
    const name = within(panel).getByTitle(LAYOUT)
    expect(name.textContent).toBe(LAYOUT)
    fireEvent.click(name)
    expect(openFilePreview).toHaveBeenCalledWith(LAYOUT, {
      line: 10,
      folderId: undefined,
    })
  })

  it("heads an edit with the file, its counts and a switch to side by side", () => {
    renderFiles()
    const panel = openPanel("Edited")
    expect(within(panel).getByTitle(LAYOUT).textContent).toBe(LAYOUT)
    expect(within(panel).getByText("+3")).toBeTruthy()
    expect(within(panel).getByText("−1")).toBeTruthy()
    const toggle = within(panel).getByRole("button", {
      name: "Switch to side-by-side view",
    })
    fireEvent.click(toggle)
    // The old and the new text, each in a half of its own.
    const halves = panel.querySelector(".grid-cols-2")!.children
    expect(halves).toHaveLength(2)
    expect(halves[0]!.textContent).toContain("<nav>Home</nav>")
    expect(halves[0]!.textContent).not.toContain("Settings")
    expect(halves[1]!.textContent).toContain("<a>Settings</a>")
    fireEvent.click(
      within(panel).getByRole("button", { name: "Switch to inline view" })
    )
    expect(panel.querySelector(".grid-cols-2")).toBeNull()
  })

  describe("with the overlay scrollbars set up", () => {
    // The real library: its setup is deferred into an idle callback and then
    // an animation frame, queued here and flushed by the test; it measures
    // only an element with a size, and jsdom lays nothing out.
    const deferred = new Map<number, () => void>()
    let nextHandle = 0
    function flushDeferred() {
      for (let round = 0; round < 2; round++) {
        act(() => {
          for (const [handle, callback] of [...deferred]) {
            deferred.delete(handle)
            callback()
          }
        })
      }
    }
    beforeEach(() => {
      const queue = (callback: () => void) => {
        deferred.set(++nextHandle, callback)
        return nextHandle
      }
      const cancel = (handle: number) => deferred.delete(handle)
      vi.stubGlobal("requestIdleCallback", queue)
      vi.stubGlobal("cancelIdleCallback", cancel)
      vi.stubGlobal("requestAnimationFrame", queue)
      vi.stubGlobal("cancelAnimationFrame", cancel)
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200)
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
        200
      )
    })
    afterEach(() => {
      deferred.clear()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    /** A viewport that scrolls sideways as far as `reach` (jsdom keeps no
     *  scroll offsets of its own). */
    function scrollable(viewport: HTMLElement, reach: number) {
      Object.defineProperty(viewport, "clientWidth", { value: 100 })
      Object.defineProperty(viewport, "scrollWidth", { value: 100 + reach })
      Object.defineProperty(viewport, "scrollLeft", {
        value: 0,
        writable: true,
      })
    }

    it("scrolls the two halves of side by side together", () => {
      localStorage.setItem("workspace:diff-view-mode", "split")
      renderFiles()
      const panel = openPanel("Edited")
      flushDeferred()
      const [left, right] = [
        ...panel.querySelector(".grid-cols-2")!.children,
      ].map(
        (half) =>
          half.querySelector("[data-overlayscrollbars-viewport]") as HTMLElement
      )
      expect(left).toBeTruthy()
      expect(right).toBeTruthy()
      scrollable(left!, 300)
      scrollable(right!, 60)

      left!.scrollLeft = 40
      fireEvent.scroll(left!)
      expect(right!.scrollLeft).toBe(40)

      // As far as the shorter half goes, and no further — nor does its stop
      // pull back the half being scrolled.
      left!.scrollLeft = 200
      fireEvent.scroll(left!)
      expect(right!.scrollLeft).toBe(60)
      fireEvent.scroll(right!)
      expect(left!.scrollLeft).toBe(200)

      right!.scrollLeft = 10
      fireEvent.scroll(right!)
      expect(left!.scrollLeft).toBe(10)
    })
  })

  it.each([
    ["in the middle", "@@ -12,0 +13,2 @@"],
    ["at the top, with no context", "@@ -0,0 +1,2 @@"],
  ])(
    "offers side by side for lines inserted into a file %s, which has a before",
    (_, hunk) => {
      const INSERT: MessageTurn = {
        id: "turn-insert",
        role: "assistant",
        timestamp: "2026-10-22T09:00:00Z",
        blocks: [
          toolUse(
            "p1",
            "apply_patch",
            `--- a/web/app/layout.tsx\n+++ b/web/app/layout.tsx\n${hunk}\n+<a>Settings</a>\n+<a>Help</a>`
          ),
          toolResult("p1", "Success."),
          { type: "text", text: "Done." },
        ],
      }
      renderTurn(
        <CurrentRound parts={partsOf(INSERT)} durationMs={1000} completed />
      )
      const panel = openPanel("Edited")
      expect(
        within(panel).getByRole("button", {
          name: "Switch to side-by-side view",
        })
      ).toBeTruthy()
    }
  )

  it("offers no side by side for a new file, which has no before", () => {
    renderFiles()
    const panel = openPanel("Created")
    expect(within(panel).getByTitle(PAGE).textContent).toBe(PAGE)
    expect(
      within(panel).queryByRole("button", {
        name: "Switch to side-by-side view",
      })
    ).toBeNull()
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
