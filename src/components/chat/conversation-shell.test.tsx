import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ComponentProps } from "react"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

// The shell's own children are not under test: stand each in with a marker.
vi.mock("@/components/chat/chat-input", () => ({
  ChatInput: () => <div data-testid="composer" />,
}))
vi.mock("@/components/chat/chat-width-handles", () => ({
  ChatWidthHandles: () => <div data-testid="width-handles" />,
}))
vi.mock("@/components/chat/composer-status-strips", () => ({
  ComposerStatusStrips: () => null,
}))
vi.mock("@/components/chat/async-task-strip", () => ({
  AsyncTaskStrip: () => null,
}))
vi.mock("@/components/chat/permission-dialog", () => ({
  PermissionDialog: () => null,
}))
vi.mock("@/components/chat/question-dialog", () => ({
  QuestionDialog: () => null,
}))
vi.mock("@/components/chat/ask-question-card", () => ({
  AskQuestionCard: () => null,
}))
vi.mock("@/components/chat/plan-approval-card", () => ({
  PlanApprovalCard: () => null,
}))

import { ConversationShell } from "./conversation-shell"

type ShellProps = ComponentProps<typeof ConversationShell>

function renderShell(extra: Partial<ShellProps> = {}) {
  const noop = () => {}
  const props = {
    status: null,
    promptCapabilities: {},
    claudeApiRetry: null,
    pendingPermission: null,
    pendingQuestion: null,
    pendingAskQuestion: null,
    pendingPlanApproval: null,
    onFocus: noop,
    onSend: noop,
    onCancel: noop,
    onRespondPermission: noop,
    onAnswerQuestion: noop,
    onAnswerAskQuestion: noop,
    onAnswerPlanApproval: noop,
    ...extra,
  } as unknown as ShellProps
  return render(
    <ConversationShell {...props}>
      <div data-testid="transcript" />
    </ConversationShell>
  )
}

/** The shell's root: the transcript's host is its child. */
const shellRoot = () =>
  screen.getByTestId("transcript").parentElement!.parentElement!

describe("ConversationShell chat-width handles", () => {
  it("has neither handles nor a gutter by default (canvas cards)", () => {
    renderShell()
    expect(screen.queryByTestId("width-handles")).toBeNull()
    expect(shellRoot().style.getPropertyValue("--chat-gutter")).toBe("")
  })

  it("adds the handles and the window-edge gutter when resizable", () => {
    renderShell({ resizableWidth: true })
    expect(screen.getByTestId("width-handles")).toBeInTheDocument()
    // Mounted beside the transcript, in a positioned host spanning it.
    const host = screen.getByTestId("transcript").parentElement!
    expect(host).toContainElement(screen.getByTestId("width-handles"))
    expect(host).toHaveClass("relative")
    expect(shellRoot().style.getPropertyValue("--chat-gutter")).toBe("12px")
  })
})

describe("who turns the handles on", () => {
  const read = (path: string) =>
    readFileSync(resolve(process.cwd(), path), "utf8")

  it("is the conversation tab, not the zoomable canvas card", () => {
    // Canvas cards render the shell under the board's scale transform, where
    // the handles' pointer maths would be off by the zoom factor.
    // Boolean shorthand only: `resizableWidth={false}` must not pass.
    expect(
      read("src/components/conversations/conversation-detail-panel.tsx")
    ).toMatch(/<ConversationShell\s+resizableWidth\s/)
    expect(
      read("src/components/canvas/canvas-conversation-surface.tsx")
    ).not.toContain("resizableWidth")
  })
})
