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
  fixtureLines,
  toolResult,
  toolUse,
} from "@/lib/activity/__fixtures__/mockup-turn"
import type { ToolApprovalMap } from "@/lib/activity/approval"
import type { ContentBlock, MessageTurn } from "@/lib/types"
import { CompletedTurnContent } from "../completed-turn-content"
import { ActivityLiveProvider } from "./activity-live-context"
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

function Round({
  parts,
  completed = true,
}: {
  parts: AdaptedContentPart[]
  completed?: boolean
}) {
  const [open, setOpen] = useState(true)
  return (
    <CompletedTurnContent
      parts={parts}
      durationMs={60000}
      completed={completed}
      currentRound
      roundOpen={open}
      onRoundOpenChange={setOpen}
    />
  )
}

function renderUi(
  ui: ReactElement,
  awaitingToolCallId: string | null = null,
  approvals: ToolApprovalMap = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StaticConnectionStoreProvider store={STORE}>
        <StaticDelegationProvider value={DELEGATION}>
          <StaticWorkspaceActionsProvider value={WORKSPACE}>
            <ActivityLiveProvider value={{ awaitingToolCallId, approvals }}>
              {ui}
            </ActivityLiveProvider>
          </StaticWorkspaceActionsProvider>
        </StaticDelegationProvider>
      </StaticConnectionStoreProvider>
    </NextIntlClientProvider>
  )
}

function turn(blocks: ContentBlock[], id = "t"): MessageTurn {
  return {
    id,
    role: "assistant",
    timestamp: "2026-10-22T10:00:00Z",
    blocks: [...blocks, { type: "text", text: "Done." }],
  }
}

function parts(t: MessageTurn, live = false, inProgress?: string[]) {
  return adaptMessageTurn(
    t,
    MOCKUP_ADAPTER_TEXT,
    live,
    inProgress ? new Set(inProgress) : undefined
  ).content
}

function rowOf(text: string | RegExp): HTMLElement {
  const row = screen.getAllByText(text)[0]!.closest("li")
  if (!row) throw new Error(`no row for ${String(text)}`)
  return row as HTMLElement
}

beforeEach(() => {
  resetDisclosureStore()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("delegation row", () => {
  it("draws the hand-over and the wait for its result as rows of their own", () => {
    renderUi(<Round parts={parts(MOCKUP_ASSISTANT_TURN)} />)
    const row = rowOf("Codex")
    expect(within(row).getByText("#14be49e7")).toBeTruthy()
    expect(row.textContent).toContain("done · 1m 34s")
    expect(
      within(row).getByText(
        "Snapshot updated. 48/48 passing, no regressions in audit artifacts."
      )
    ).toBeTruthy()
    expect(
      within(row).getByRole("button", { name: /Open conversation/ })
    ).toBeTruthy()
    // The agent's check on the task, right after it.
    const wait = rowOf("Waiting for task #14be49e7 result")
    expect(row.nextElementSibling).toBe(wait)
    expect(wait.textContent).toContain("done · 1m 34s")
  })

  it("marks a check whose panel is open, so the rail can run beside it", () => {
    renderUi(<Round parts={parts(MOCKUP_ASSISTANT_TURN)} />)
    const wait = rowOf("Waiting for task #14be49e7 result")
    expect(wait).not.toHaveAttribute("data-body")
    fireEvent.click(within(wait).getAllByRole("button")[0]!)
    expect(wait).toHaveAttribute("data-body")
  })

  it("says the task on its title line, not on a line of its own", () => {
    renderUi(<Round parts={parts(MOCKUP_ASSISTANT_TURN)} />)
    const row = rowOf("Codex")
    const header = row.querySelector(":scope > div, :scope > button")!
    expect(
      within(header as HTMLElement).getByText(/^Update the stale snapshot/)
    ).toHaveClass("truncate")
  })

  it("counts the steps it took and draws one segment per step", () => {
    renderUi(<Round parts={parts(MOCKUP_ASSISTANT_TURN)} />)
    const row = rowOf("Codex")
    expect(within(row).getByText("· 5 steps")).toBeTruthy()
    expect(
      within(row).getByRole("img", { name: "5 steps, 1 failed" })
    ).toBeTruthy()
  })
})

describe("a folded turn", () => {
  const delegated = (id: string, taskId: string, status: string) => [
    toolUse(
      id,
      "mcp__codeg-mcp__delegate_to_agent",
      { agent_type: "codex", task: `Task ${taskId}` },
      { "codeg.delegation": { status, task_id: taskId } }
    ),
    toolResult(id, JSON.stringify({ task_id: taskId, status: "started" })),
  ]
  const checked = (id: string, report: Record<string, unknown>) => [
    toolUse(id, "mcp__codeg-mcp__get_delegation_status", {
      task_ids: [report.task_id],
    }),
    toolResult(id, JSON.stringify(report)),
  ]

  it("keeps the check whose sub-agent waits on the user under its header", () => {
    renderUi(
      <Round
        parts={parts(
          turn([
            ...delegated("d1", "aaaa1111", "running"),
            ...checked("p1", {
              task_id: "aaaa1111",
              status: "running",
              blocked_on: { kind: "permission" },
            }),
            ...delegated("d2", "bbbb2222", "completed"),
            ...checked("p2", {
              task_id: "bbbb2222",
              status: "completed",
              text: "Done.",
            }),
          ])
        )}
      />
    )
    expect(screen.getAllByText(/^Waiting for task/)).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: "Activity" }))
    expect(screen.getByText("#aaaa1111")).toBeTruthy()
    expect(
      rowOf("Waiting for task #aaaa1111 result").getAttribute("data-status")
    ).toBe("awaiting")
    expect(screen.queryByText("#bbbb2222")).toBeNull()
    expect(screen.queryByText("Waiting for task #bbbb2222 result")).toBeNull()
    // What stays in view is no list of the turn's steps: it has no end mark.
    const lists = document.querySelectorAll(".activity-timeline")
    expect(lists).toHaveLength(1)
    expect(lists[0]).not.toHaveAttribute("data-end")
  })
})

describe("background task row", () => {
  it("names the task after the command that started it", () => {
    renderUi(<Round parts={parts(MOCKUP_ASSISTANT_TURN)} />)
    const row = rowOf("Task finished")
    expect(within(row).getByText("#beecec7d")).toBeTruthy()
    expect(
      within(row).getByText("Regenerate audit report · report.md written")
    ).toBeTruthy()
    expect(within(row).getByText("done")).toBeTruthy()
  })
})

describe("plan, plan-mode and feedback rows", () => {
  const WORKFLOW = turn([
    toolUse("p1", "TodoWrite", {
      todos: [
        { content: "Reproduce", status: "completed" },
        { content: "Fix the filter", status: "in_progress" },
        { content: "Regenerate", status: "pending" },
      ],
    }),
    toolResult("p1", "Todos have been modified successfully."),
    toolUse("p2", "mcp__codeg-mcp__check_user_feedback", {}),
    toolResult(
      "p2",
      '{"count":1,"feedback":[{"created_at":"2026-10-22T09:41:12Z","text":"Keep CSV working"}]}'
    ),
    toolUse("p3", "ExitPlanMode", { plan: "# Keep CSV working\n\n1. Map it" }),
    toolResult("p3", "User has approved your plan."),
  ])

  it("summarizes the plan by its current item", () => {
    renderUi(<Round parts={parts(WORKFLOW)} />)
    const row = rowOf("Updated plan")
    expect(within(row).getByText("Fix the filter")).toBeTruthy()
    expect(within(row).getByText("1/3")).toBeTruthy()
  })

  it("opens the user's feedback notes by default", () => {
    renderUi(<Round parts={parts(WORKFLOW)} />)
    const row = rowOf("1 feedback note")
    expect(within(row).getAllByText("Keep CSV working").length).toBe(2)
  })

  it("opens a submitted plan to the plan itself", () => {
    renderUi(<Round parts={parts(WORKFLOW)} />)
    const row = rowOf("Plan submitted")
    expect(within(row).getByText("Map it")).toBeTruthy()
  })
})

describe("agent row", () => {
  const AGENT = turn([
    toolUse("a1", "Agent", {
      description: "Find binding consumers",
      prompt: "Find every consumer of source_bindings.",
      subagent_type: "Explore",
    }),
    {
      type: "tool_result",
      tool_use_id: "a1",
      is_error: false,
      output_preview: "Only `report.py` assumes inactive bindings.",
      agent_stats: {
        agent_type: "Explore",
        status: "completed",
        total_duration_ms: 48000,
        tool_calls: [
          {
            tool_name: "Grep",
            input_preview: JSON.stringify({ pattern: "source_bindings" }),
            output_preview: "a.py:1:x",
            is_error: false,
          },
          {
            tool_name: "Read",
            input_preview: JSON.stringify({ file_path: "/r/report.py" }),
            output_preview: fixtureLines(3, "report.py"),
            is_error: false,
          },
        ],
      },
    },
  ])

  it("shows the prompt on its title line, the result's first line under it, and opens to its own steps", () => {
    renderUi(<Round parts={parts(AGENT)} />)
    const row = rowOf("Explore")
    const header = row.querySelector(":scope > button")!
    expect(within(row).getByText("Find binding consumers")).toBeTruthy()
    expect(
      within(row).getAllByText("Find every consumer of source_bindings.")
    ).toEqual([
      within(header as HTMLElement).getByText(
        "Find every consumer of source_bindings."
      ),
    ])
    expect(
      within(row).getByText("Only report.py assumes inactive bindings.")
    ).toBeTruthy()
    expect(within(row).getByText("48.0s")).toBeTruthy()
    expect(within(row).getByRole("img", { name: "2 steps" })).toBeTruthy()
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    expect(within(row).getByText("Explored")).toBeTruthy()
  })
})

describe("waiting on the user", () => {
  it("marks the call a pending approval is about", () => {
    const LIVE = turn([toolUse("c1", "Bash", { command: "rm -rf build" })])
    renderUi(
      <Round parts={parts(LIVE, true, ["c1"])} completed={false} />,
      "c1"
    )
    const row = rowOf("rm -rf build")
    expect(row.getAttribute("data-status")).toBe("awaiting")
    expect(within(row).getByText("needs you")).toBeTruthy()
    expect(
      within(row).getByRole("img", { name: "Command, waiting for you" })
    ).toBeTruthy()
  })
})

describe("jumping to a failure", () => {
  it("opens the turn's first unrecovered failure from the header", () => {
    const FAILING = turn([
      toolUse("r1", "Read", { file_path: "/r/a.ts" }),
      toolResult("r1", "a"),
      toolUse("r2", "Read", { file_path: "/r/b.ts" }),
      toolResult("r2", "Permission denied", true),
    ])
    renderUi(<Round parts={parts(FAILING)} />)
    // Folded, and the failed read sits inside the Explored group.
    fireEvent.click(screen.getByRole("button", { name: "Activity" }))
    expect(screen.queryByText("Permission denied")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "1 failed" }))
    expect(screen.getByText("Permission denied")).toBeTruthy()
  })
})

describe("long replies", () => {
  it("opens a giant reply with its head and tail and a way to see the rest", () => {
    const blocks: ContentBlock[] = []
    for (let i = 0; i < 200; i++) {
      blocks.push(
        toolUse(`e${i}`, "Edit", {
          file_path: `/r/f${i}.ts`,
          old_string: "a",
          new_string: "b",
        })
      )
      blocks.push(toolResult(`e${i}`, "ok"))
    }
    renderUi(<Round parts={parts(turn(blocks))} />)
    const more = screen.getByRole("button", { name: "Show 130 more steps" })
    expect(screen.getAllByText("Edited")).toHaveLength(70)
    fireEvent.click(more)
    expect(screen.getAllByText("Edited")).toHaveLength(200)
  })
})

describe("running clock", () => {
  it("shows how long a command has run once it passes ten seconds", () => {
    vi.useFakeTimers()
    const LIVE = turn([toolUse("c1", "Bash", { command: "pnpm build" })])
    renderUi(<Round parts={parts(LIVE, true, ["c1"])} completed={false} />)
    const row = rowOf("pnpm build")
    expect(within(row).queryByText(/^0:/)).toBeNull()
    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(within(row).getByText("0:12")).toBeTruthy()
  })
})

describe("approval chips", () => {
  const record = (toolCallId: string, optionKind: string) => ({
    tool_call_id: toolCallId,
    option_kind: optionKind,
    option_name: "Allow",
    origin: "user",
    decided_at: "2026-10-22T09:41:12Z",
  })

  it("draws a reopened conversation's approval on the call's row", () => {
    const REOPENED = turn([
      toolUse(
        "c1",
        "Bash",
        { command: "git commit -am wip" },
        {
          "codeg.approval": {
            option_kind: "allow_always",
            option_name: "Yes, and don't ask again for git commands",
            origin: "chat_channel",
            decided_at: "2026-10-22T09:41:12Z",
          },
        }
      ),
      toolResult("c1", "[main 1a2b3c4] wip"),
    ])
    renderUi(<Round parts={parts(REOPENED)} />)
    const chip = within(rowOf("git commit -am wip")).getByText("always allowed")
    expect(chip.getAttribute("title")).toMatch(
      /^Yes, and don't ask again for git commands · via a chat channel · /
    )
  })

  it("draws the live connection's answer, which the history has yet to carry", () => {
    const LIVE = turn([
      toolUse("c1", "Bash", { command: "pnpm build" }),
      toolResult("c1", "built"),
    ])
    renderUi(<Round parts={parts(LIVE)} />, null, {
      c1: record("c1", "allow_once"),
    })
    expect(within(rowOf("pnpm build")).getByText("approved once")).toBeTruthy()
  })

  it("says a declined call was declined, once", () => {
    const DECLINED = turn([
      toolUse("c1", "Bash", { command: "rm -rf build" }),
      toolResult("c1", "Error: tool call was not run", true),
    ])
    renderUi(<Round parts={parts(DECLINED)} />, null, {
      c1: record("c1", "reject_once"),
    })
    const row = rowOf("rm -rf build")
    expect(row.getAttribute("data-status")).toBe("rejected")
    expect(within(row).getAllByText("declined")).toHaveLength(1)
  })

  it("marks an approved call inside an opened group", () => {
    const RUN = turn([
      toolUse("c1", "Bash", { command: "pnpm lint" }),
      toolResult("c1", "ok"),
      toolUse("c2", "Bash", { command: "pnpm test" }),
      toolResult("c2", "ok"),
    ])
    renderUi(<Round parts={parts(RUN)} />, null, {
      c2: record("c2", "allow_once"),
    })
    fireEvent.click(screen.getByRole("button", { name: /Ran 2 commands/ }))
    expect(within(rowOf("pnpm test")).getByText("approved once")).toBeTruthy()
    expect(within(rowOf("pnpm lint")).queryByText("approved once")).toBeNull()
  })
})

describe("a folded group waiting on the user", () => {
  it("shows the member that needs the user under its header", () => {
    const LIVE = turn([
      toolUse("c1", "Bash", { command: "pnpm lint" }),
      toolResult("c1", "ok"),
      toolUse("c2", "Bash", { command: "rm -rf build" }),
    ])
    renderUi(
      <Round parts={parts(LIVE, true, ["c2"])} completed={false} />,
      "c2"
    )
    const group = rowOf("Running 2 commands")
    expect(group.getAttribute("data-status")).toBe("awaiting")
    const member = rowOf("rm -rf build")
    expect(member.getAttribute("data-status")).toBe("awaiting")
    expect(within(member).getByText("needs you")).toBeTruthy()
    expect(screen.queryByText("pnpm lint")).toBeNull()
  })
})
