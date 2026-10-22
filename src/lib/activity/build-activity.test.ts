import { describe, expect, it } from "vitest"

import {
  adaptMessageTurn,
  type AdaptedContentPart,
} from "@/lib/adapters/ai-elements-adapter"
import {
  MOCKUP_ADAPTER_TEXT,
  MOCKUP_ASSISTANT_TURN,
  MOCKUP_LIVE_TURN,
} from "./__fixtures__/mockup-turn"
import { buildActivity } from "./build-activity"
import type { ActivityItem } from "./types"

function rows(items: ActivityItem[]): string[] {
  return items.map((item) => {
    if (item.type === "group") {
      return `${item.kind}(${item.steps
        .map((s) => (s.type === "tool" ? s.part.toolCallId : s.key))
        .join(",")})`
    }
    const step = item.step
    switch (step.type) {
      case "tool":
        return `${step.tool.kind}:${step.part.toolCallId}`
      case "thought":
        return `thought:${step.title}`
      default:
        return step.type
    }
  })
}

describe("buildActivity on the reference turn", () => {
  const parts = adaptMessageTurn(
    MOCKUP_ASSISTANT_TURN,
    MOCKUP_ADAPTER_TEXT
  ).content
  const model = buildActivity(parts, { isStreaming: false })

  it("draws one row per step, with exploration and commands folded", () => {
    expect(rows(model.items)).toEqual([
      "thought:Summarizing log status",
      "explore(t1,t2,t3,t4)",
      "command(t5,t6)",
      "mcp:t7",
      "thought:Planning the fix",
      "edit:t8",
      "command:t9",
      "note",
      "delegation:t10",
      "command(t12,t13)",
      "background-tasks",
      "command:t15",
    ])
  })

  it("folds the delegation's own status poll into its row", () => {
    const delegation = model.steps.find(
      (s) => s.type === "tool" && s.part.toolCallId === "t10"
    )
    expect(
      delegation?.type === "tool"
        ? delegation.polls?.map((p) => p.toolCallId)
        : null
    ).toEqual(["t11"])
  })

  it("keeps the closing prose as the answer", () => {
    expect(model.answer).toHaveLength(1)
    expect(model.answer[0]).toMatchObject({ type: "text" })
  })

  it("summarizes the turn", () => {
    expect(model.summary).toMatchObject({
      steps: 14,
      counts: {
        commands: 6,
        editedFiles: 1,
        agents: 1,
        mcp: 1,
        web: 0,
        readFiles: 3,
        searches: 1,
      },
      failed: 1,
      unrecovered: 0,
      interrupted: 0,
      running: false,
      firstUnrecoveredKey: null,
    })
    expect([...model.summary.recoveredKeys]).toEqual(["tool:t9"])
  })

  it("describes the rows the way the mockup shows them", () => {
    const steps = new Map(
      model.steps.flatMap((s) =>
        s.type === "tool" ? [[s.part.toolCallId, s.tool] as const] : []
      )
    )
    expect(steps.get("t1")?.metric).toEqual({ kind: "lines", count: 84 })
    expect(steps.get("t4")?.metric).toEqual({
      kind: "matches",
      count: 4,
      files: 3,
    })
    expect(steps.get("t6")?.command?.heredoc?.bodyLines).toBe(5)
    expect(steps.get("t7")?.detail).toBe(
      "HVAC-212 · Inactive bindings leak into report"
    )
    expect(steps.get("t8")?.files?.[0]).toMatchObject({
      additions: 3,
      deletions: 1,
      lineRange: { start: 44, end: 46 },
    })
    expect(steps.get("t9")?.exit).toEqual({ code: 1, signal: null })
    expect(steps.get("t13")?.background).toEqual({ taskId: "beecec7d" })
  })

  it("is cached per parts array and streaming state", () => {
    expect(buildActivity(parts, { isStreaming: false })).toBe(model)
    expect(buildActivity(parts, { isStreaming: true })).not.toBe(model)
  })
})

describe("buildActivity on a live turn", () => {
  it("reports the running command and keeps every call visible", () => {
    const parts = adaptMessageTurn(
      MOCKUP_LIVE_TURN,
      MOCKUP_ADAPTER_TEXT,
      true,
      new Set(["l3"])
    ).content
    const model = buildActivity(parts, { isStreaming: true })
    expect(rows(model.items)).toEqual([
      "thought:Checking the failing test",
      "explore(l1,l2)",
      "command:l3",
    ])
    expect(model.summary.running).toBe(true)
    const last = model.items[2]
    expect(
      last?.type === "step" && last.step.type === "tool"
        ? last.step.tool.status
        : null
    ).toBe("running")
  })

  it("titles a streaming thought by its newest heading", () => {
    const parts: AdaptedContentPart[] = [
      {
        type: "reasoning",
        content: "**First**\n\nbody\n\n**Second**\n\nmore",
        isStreaming: true,
      },
    ]
    const model = buildActivity(parts, { isStreaming: true })
    expect(rows(model.items)).toEqual(["thought:Second"])
    expect(model.summary.running).toBe(true)
  })
})

describe("buildActivity edge cases", () => {
  it("returns an empty timeline for a text-only reply", () => {
    const parts: AdaptedContentPart[] = [{ type: "text", text: "Hi" }]
    const model = buildActivity(parts, { isStreaming: false })
    expect(model.items).toEqual([])
    expect(model.answer).toEqual(parts)
    expect(model.summary.steps).toBe(0)
  })

  it("keeps prose written between steps as a note", () => {
    const parts: AdaptedContentPart[] = [
      { type: "text", text: "Looking around." },
      {
        type: "tool-call",
        toolCallId: "a",
        toolName: "Read",
        input: '{"file_path":"/r/a.ts"}',
        state: "output-available",
        output: "x",
      },
      { type: "text", text: "Done." },
    ]
    const model = buildActivity(parts, { isStreaming: false })
    expect(rows(model.items)).toEqual(["note", "read:a"])
    expect(model.answer).toEqual([parts[2]])
  })

  it("leaves out an interrupted call that carried nothing, but counts it", () => {
    const parts: AdaptedContentPart[] = [
      {
        type: "tool-call",
        toolCallId: "a",
        toolName: "Bash",
        input: "{}",
        state: "output-error",
        errorText: "[Request interrupted by user for tool use]",
      },
      {
        type: "tool-call",
        toolCallId: "b",
        toolName: "Bash",
        input: '{"command":"pnpm dev"}',
        state: "output-error",
        errorText: "[Request interrupted by user for tool use]",
      },
    ]
    const model = buildActivity(parts, { isStreaming: false })
    expect(rows(model.items)).toEqual(["command:b"])
    expect(model.summary.interrupted).toBe(2)
    expect(model.summary.failed).toBe(0)
  })
})
