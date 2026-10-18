import { type ReactElement } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DelegationStatusGroupCard } from "./delegation-status-group-card"
import enMessages from "@/i18n/messages/en.json"
import type { DelegationBinding } from "@/contexts/delegation-context"
import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"

// A `get_delegation_status` row whose sub-agent is parked on the user must let
// the user answer right there (#973): the card used to badge "awaiting
// approval" and offer nothing to approve with — the prompt only lived in the
// sub-agent's own session drawer, opened from a different card.

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div data-testid="markdown-response">{children}</div>
  ),
}))

// The live binding lookup. A real `DelegationProvider` is mounted once in the
// workspace layout; here the map is the whole provider.
const bindings = new Map<string, DelegationBinding>()
const delegation = {
  findByParentToolUseId: () => undefined,
  findByChildConversationId: () => undefined,
  findByTaskId: (taskId: string) => bindings.get(taskId),
}
vi.mock("@/contexts/delegation-context", async () => {
  const actual = await vi.importActual<
    typeof import("@/contexts/delegation-context")
  >("@/contexts/delegation-context")
  return {
    ...actual,
    useDelegation: () => delegation,
    useOptionalDelegation: () => delegation,
  }
})

// The connections store: child connection states by id, plus a notifier so a
// test can play a STATE update from the reducer (the prompt being answered).
const connections = new Map<string, unknown>()
let storeCallbacks: Array<() => void> = []
function notifyStore() {
  for (const cb of storeCallbacks) cb()
}
const store = {
  subscribeKey: (_key: string, cb: () => void) => {
    storeCallbacks.push(cb)
    return () => {
      storeCallbacks = storeCallbacks.filter((c) => c !== cb)
    }
  },
  getConnection: (key: string) => connections.get(key),
  getConnectPending: () => undefined,
  getConnectError: () => undefined,
  getActiveKey: () => null,
  subscribeActiveKey: () => () => {},
}
const respondPermission = vi.fn()
const answerQuestion = vi.fn()
const answerPlanApproval = vi.fn()
vi.mock("@/contexts/acp-connections-context", async () => {
  const actual = await vi.importActual<
    typeof import("@/contexts/acp-connections-context")
  >("@/contexts/acp-connections-context")
  return {
    ...actual,
    useConnectionStore: () => store,
    useOptionalConnectionStore: () => store,
    useAcpActions: () => ({
      respondPermission,
      answerQuestion,
      answerPlanApproval,
    }),
  }
})

// The three prompt cards have their own dependency graphs and suites; stub
// each to a button that answers through the handler it was given.
vi.mock("@/components/chat/permission-dialog", () => ({
  PermissionDialog: ({
    permission,
    onRespond,
  }: {
    permission: { request_id: string } | null
    onRespond: (requestId: string, optionId: string) => void
  }) =>
    permission ? (
      <button
        data-testid="permission-dialog"
        onClick={() => onRespond(permission.request_id, "approve")}
      >
        permission {permission.request_id}
      </button>
    ) : null,
}))
vi.mock("@/components/chat/ask-question-card", () => ({
  AskQuestionCard: ({
    question,
    onAnswer,
  }: {
    question: { question_id: string }
    onAnswer: (questionId: string, answer: unknown) => void
  }) => (
    <button
      data-testid="ask-question-card"
      onClick={() => onAnswer(question.question_id, { answers: [] })}
    >
      question {question.question_id}
    </button>
  ),
}))
vi.mock("@/components/chat/plan-approval-card", () => ({
  PlanApprovalCard: ({
    approval,
    onAnswer,
  }: {
    approval: { approval_id: string }
    onAnswer: (approvalId: string, answer: unknown) => void
  }) => (
    <button
      data-testid="plan-approval-card"
      onClick={() => onAnswer(approval.approval_id, { decision: "approve" })}
    >
      plan {approval.approval_id}
    </button>
  ),
}))

const TASK = "7bd4d6ff-0000-4000-8000-000000000001"
const CHILD = "child-conn-1"

function bindingFor(
  taskId: string,
  childConnectionId: string,
  status: DelegationBinding["status"] = "running"
) {
  bindings.set(taskId, {
    parentConnectionId: "parent-conn",
    parentToolUseId: `delegate-${taskId}`,
    childConnectionId,
    childConversationId: 42,
    agentType: "codex",
    status,
    task: "run the migration",
    taskId,
    assistantId: null,
    assistantName: null,
  })
}

const PERMISSION = {
  request_id: "req-1",
  tool_call: { title: "Run bash", kind: "execute" },
  options: [{ option_id: "approve", name: "Allow", kind: "allow_once" }],
}

function childState(
  pending: {
    pendingPermission?: unknown
    pendingAskQuestion?: unknown
    pendingPlanApproval?: unknown
  } = {}
) {
  return {
    connectionId: CHILD,
    contextKey: CHILD,
    agentType: "codex",
    status: "prompting",
    isDelegationChild: true,
    pendingPermission: pending.pendingPermission ?? null,
    pendingAskQuestion: pending.pendingAskQuestion ?? null,
    pendingPlanApproval: pending.pendingPlanApproval ?? null,
  }
}

const BLOCKED_TEXT =
  "Running.\nAwaiting your decision: a tool permission\nThe sub-agent is " +
  "parked until a human answers in Codeg — it is not making progress. Tell " +
  "the user, then wait again."

/** A poll the backend answered "running, parked on the user" — the shape a
 *  host that keeps `structuredContent` persists. */
function blockedPoll(taskId: string, id = "poll-blocked"): AdaptedToolCallPart {
  const report = {
    task_id: taskId,
    status: "running",
    child_conversation_id: 42,
    agent_type: "codex",
    message: BLOCKED_TEXT,
    blocked_on: { kind: "permission", request_id: "req-1" },
  }
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: "get_delegation_status",
    input: JSON.stringify({ task_ids: [taskId] }),
    state: "output-available",
    output: JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ tasks: [report] }) }],
      isError: false,
      structuredContent: { tasks: [report] },
    }),
  }
}

function renderCard(polls: AdaptedToolCallPart[]) {
  const ui = (p: AdaptedToolCallPart[]): ReactElement => (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DelegationStatusGroupCard polls={p} />
    </NextIntlClientProvider>
  )
  const result = render(ui(polls))
  return {
    ...result,
    rerenderPolls: (p: AdaptedToolCallPart[]) => result.rerender(ui(p)),
  }
}

describe("DelegationStatusGroupCard — answering a parked sub-agent (#973)", () => {
  beforeEach(() => {
    bindings.clear()
    connections.clear()
    storeCallbacks = []
    respondPermission.mockReset()
    answerQuestion.mockReset()
    answerPlanApproval.mockReset()
  })

  it("shows the sub-agent's permission prompt in the row, open without a click, and answers through the child", () => {
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderCard([blockedPoll(TASK)])

    expect(screen.getByText("awaiting approval")).toBeInTheDocument()
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument()
    const prompt = screen.getByTestId("permission-dialog")
    fireEvent.click(prompt)
    expect(respondPermission).toHaveBeenCalledWith(CHILD, "req-1", "approve")
  })

  it("finds the sub-agent on a content-only host, which keeps the report as text", () => {
    // Claude Code keeps only `content[*].text` — no `structuredContent` — so
    // the `{tasks:[…]}` report survives as JSON text.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    const report = {
      task_id: TASK,
      status: "running",
      message: BLOCKED_TEXT,
      blocked_on: { kind: "permission", request_id: "req-1" },
    }
    renderCard([
      {
        type: "tool-call",
        toolCallId: "poll-content-only",
        toolName: "get_delegation_status",
        input: JSON.stringify({ task_ids: [TASK] }),
        state: "output-available",
        output: JSON.stringify({
          content: [
            { type: "text", text: JSON.stringify({ tasks: [report] }) },
          ],
          isError: false,
        }),
      },
    ])

    fireEvent.click(screen.getByTestId("permission-dialog"))
    expect(respondPermission).toHaveBeenCalledWith(CHILD, "req-1", "approve")
  })

  it("finds the sub-agent from a historical poll that is bare text", () => {
    // Older transcripts keep just the backend's blocked note, and the task id
    // is the call's own argument.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderCard([
      {
        type: "tool-call",
        toolCallId: "poll-text",
        toolName: "get_delegation_status",
        input: JSON.stringify({ task_ids: [TASK] }),
        state: "output-available",
        output: BLOCKED_TEXT,
      },
    ])

    fireEvent.click(screen.getByTestId("permission-dialog"))
    expect(respondPermission).toHaveBeenCalledWith(CHILD, "req-1", "approve")
  })

  it("carries a question or a plan approval the same way", () => {
    bindingFor(TASK, CHILD)
    connections.set(
      CHILD,
      childState({
        pendingAskQuestion: {
          question_id: "q-1",
          questions: [
            {
              id: "q",
              question: "Which DB?",
              header: "DB",
              multi_select: false,
              options: [],
            },
          ],
          created_at: "2026-10-18T00:00:00Z",
        },
        pendingPlanApproval: {
          approval_id: "plan-1",
          tool_call_id: "tc-1",
          plan_markdown: "1. migrate",
          created_at: "2026-10-18T00:00:00Z",
        },
      })
    )
    renderCard([blockedPoll(TASK)])

    expect(screen.getByText("awaiting approval")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("ask-question-card"))
    expect(answerQuestion).toHaveBeenCalledWith(CHILD, "q-1", { answers: [] })
    fireEvent.click(screen.getByTestId("plan-approval-card"))
    expect(answerPlanApproval).toHaveBeenCalledWith(CHILD, "plan-1", {
      decision: "approve",
    })
  })

  it("never reaches a sub-agent the backend did not vouch for", () => {
    // The model polled an id that is another conversation's — a binding for it
    // exists in this workspace and is parked — but the backend answered
    // `unknown`. Nothing of that sub-agent may surface here.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    const unknown = {
      task_id: TASK,
      status: "unknown",
      message:
        "Unknown task id — it never existed, isn't owned by this session.",
    }
    renderCard([
      {
        type: "tool-call",
        toolCallId: "poll-foreign",
        toolName: "get_delegation_status",
        input: JSON.stringify({ task_ids: [TASK] }),
        state: "output-available",
        output: JSON.stringify({
          content: [{ type: "text", text: unknown.message }],
          isError: false,
          structuredContent: { tasks: [unknown] },
        }),
      },
    ])

    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
    expect(screen.queryByText("awaiting approval")).not.toBeInTheDocument()
  })

  it("does not trust an id the backend has not answered for yet", () => {
    // First poll, still in flight: the id is only the model's argument so far.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderCard([
      {
        type: "tool-call",
        toolCallId: "poll-inflight",
        toolName: "get_delegation_status",
        input: JSON.stringify({ task_ids: [TASK] }),
        state: "input-available",
        output: null,
      },
    ])

    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
    expect(screen.queryByText("awaiting approval")).not.toBeInTheDocument()
  })

  it("keeps the prompt while the agent is already waiting again on the same task", () => {
    // The re-poll is in flight (it would spin), but the sub-agent is still
    // parked: the row says so, and the prompt stays.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    const { container } = renderCard([
      blockedPoll(TASK),
      {
        type: "tool-call",
        toolCallId: "poll-again",
        toolName: "get_delegation_status",
        input: JSON.stringify({ task_ids: [TASK] }),
        state: "input-available",
        output: null,
      },
    ])

    expect(screen.getByText("awaiting approval")).toBeInTheDocument()
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument()
    expect(screen.getByTestId("permission-dialog")).toBeInTheDocument()
  })

  it("drops the prompt and the stale 'awaiting approval' once it is answered", () => {
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderCard([blockedPoll(TASK)])
    expect(screen.getByTestId("permission-dialog")).toBeInTheDocument()

    // Answered (here, or in the sub-agent's own drawer): the store clears it.
    act(() => {
      connections.set(CHILD, childState())
      notifyStore()
    })

    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
    expect(screen.queryByText("awaiting approval")).not.toBeInTheDocument()
    expect(screen.getByText("checked")).toBeInTheDocument()
    // It opened only for the decision, so it closes with it.
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument()
  })

  it("keeps the poll's word when this window holds no live sub-agent", () => {
    // Running, but its connection is not attached here (not yet, or no
    // longer): nothing live contradicts the poll.
    bindingFor(TASK, CHILD)
    renderCard([blockedPoll(TASK)])

    expect(screen.getByText("awaiting approval")).toBeInTheDocument()
    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
  })

  it("stops claiming 'awaiting approval' once the delegation has ended", () => {
    // Answered, then the sub-agent finished and was released before the agent
    // polled again: the poll's "waiting" is history, and so is anything its
    // connection still holds in the moment before it goes.
    bindingFor(TASK, CHILD, "ok")
    const { unmount } = renderCard([blockedPoll(TASK)])
    expect(screen.queryByText("awaiting approval")).not.toBeInTheDocument()
    expect(screen.getByText("checked")).toBeInTheDocument()
    unmount()

    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderCard([blockedPoll(TASK)])
    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
    expect(screen.getByText("checked")).toBeInTheDocument()
  })

  it("stays closed while the decisions it was closed on are still pending", () => {
    bindingFor(TASK, CHILD)
    const plan = {
      approval_id: "plan-1",
      tool_call_id: "tc-1",
      plan_markdown: "1. migrate",
      created_at: "2026-10-18T00:00:00Z",
    }
    connections.set(
      CHILD,
      childState({ pendingPermission: PERMISSION, pendingPlanApproval: plan })
    )
    renderCard([blockedPoll(TASK)])
    fireEvent.click(screen.getByRole("button", { expanded: true }))

    // One of the two is answered elsewhere; the other was already in view
    // when the user closed the row.
    act(() => {
      connections.set(CHILD, childState({ pendingPlanApproval: plan }))
      notifyStore()
    })
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument()
    expect(screen.queryByTestId("plan-approval-card")).not.toBeInTheDocument()

    // A decision the user has not seen yet opens it again.
    act(() => {
      connections.set(
        CHILD,
        childState({
          pendingPlanApproval: plan,
          pendingPermission: { ...PERMISSION, request_id: "req-3" },
        })
      )
      notifyStore()
    })
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument()
    expect(screen.getByTestId("permission-dialog")).toBeInTheDocument()
  })

  it("stays closed once the user closes it, and opens again for the next decision", () => {
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderCard([blockedPoll(TASK)])

    fireEvent.click(screen.getByRole("button", { expanded: true }))
    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
    expect(screen.getByText("awaiting approval")).toBeInTheDocument()

    act(() => {
      connections.set(
        CHILD,
        childState({
          pendingPermission: { ...PERMISSION, request_id: "req-2" },
        })
      )
      notifyStore()
    })
    fireEvent.click(screen.getByTestId("permission-dialog"))
    expect(respondPermission).toHaveBeenCalledWith(CHILD, "req-2", "approve")
  })

  it("leaves a finished wait alone", () => {
    // The task's latest poll is its result. A sub-agent bound to the same id
    // (a later resume) is that run's business, not this row's.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    const done = {
      task_id: TASK,
      status: "completed",
      text: "Migrated.",
    }
    renderCard([
      blockedPoll(TASK),
      {
        type: "tool-call",
        toolCallId: "poll-done",
        toolName: "get_delegation_status",
        input: JSON.stringify({ task_ids: [TASK] }),
        state: "output-available",
        output: JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ tasks: [done] }) }],
          isError: false,
          structuredContent: { tasks: [done] },
        }),
      },
    ])

    expect(screen.getByText("done")).toBeInTheDocument()
    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
  })
})
