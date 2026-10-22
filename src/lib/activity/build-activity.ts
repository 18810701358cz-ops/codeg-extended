/**
 * `buildActivity`: a reply's adapted parts → the activity timeline's view
 * model (steps, grouped rows, trailing answer, header summary).
 *
 * Runs after the adapter and the cross-turn merge, so every lane those
 * produce — delegation polls, background-task polls, goal runs, plans — is
 * already settled and this only reshapes it: plain tool calls are grouped
 * here, by kind; the specialized lanes stay whole.
 */

import {
  splitTrailingAnswerParts,
  type AdaptedContentPart,
  type AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import { buildBackgroundTaskRows } from "@/lib/background-task"
import { delegateCallTaskId } from "@/lib/delegation-card"
import { buildDelegationTaskRows } from "@/lib/delegation-status"
import { describeToolCall } from "./describe-tool-call"
import { groupActivitySteps } from "./group"
import { combineStatuses, toolCallStatus, type StepStatus } from "./status"
import { summarizeActivity } from "./summarize"
import { thoughtTitle } from "./thought"
import type { ActivityModel, ActivityStep, BackgroundLaunch } from "./types"

function toolStep(part: AdaptedToolCallPart): ActivityStep {
  return {
    type: "tool",
    key: `tool:${part.toolCallId}`,
    part,
    tool: describeToolCall(part),
  }
}

function backgroundStatus(polls: AdaptedToolCallPart[]): StepStatus {
  const rows = buildBackgroundTaskRows(polls)
  if (rows.some((row) => row.badge === "running")) return "running"
  if (rows.some((row) => row.badge === "failed")) return "failed"
  if (rows.length > 0 && rows.every((row) => row.badge === "stopped")) {
    return "cancelled"
  }
  return "succeeded"
}

/**
 * A call that was interrupted before it carried anything — no arguments, no
 * output beyond the interruption marker. It says nothing a row could show, so
 * it is left out of the timeline (the header still counts it as interrupted).
 */
function isBlankInterruption(step: ActivityStep): boolean {
  if (step.type !== "tool" || step.tool.status !== "cancelled") return false
  const input = step.part.input?.trim()
  return !input || input === "{}" || input === "[]" || input === "null"
}

/** djb2 — only has to tell replies apart, not resist collisions on purpose. */
function hashText(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * A stable name for the reply, prefixed onto the keys of steps that have no id
 * of their own (thoughts, notes, plans), so a remembered open/closed choice
 * stays with the right row across replies and through the live → history
 * hand-over. The opening prose or thought names it when the reply starts with
 * one (its first characters stop changing almost at once while it streams, and
 * reload with the same text); otherwise the first tool call id does (ids
 * persist across that hand-over).
 */
function replyAnchor(parts: AdaptedContentPart[]): string {
  const first = parts[0]
  if (first?.type === "text" || first?.type === "reasoning") {
    const text = first.type === "text" ? first.text : first.content
    if (text.trim().length >= ANCHOR_TEXT_LENGTH) {
      return `h${hashText(text.slice(0, ANCHOR_TEXT_LENGTH))}`
    }
  }
  for (const part of parts) {
    if (part.type === "tool-call") return part.toolCallId
    if (
      (part.type === "delegation-status-group" ||
        part.type === "background-task-group") &&
      part.polls[0]
    ) {
      return part.polls[0].toolCallId
    }
    if (part.type === "goal-run") return part.start.toolCallId
  }
  return first ? `h${hashText(JSON.stringify(first).slice(0, 200))}` : "empty"
}

const ANCHOR_TEXT_LENGTH = 32

/** Background launches among the steps so far, by task id. */
function launchesBefore(
  steps: ActivityStep[]
): Record<string, BackgroundLaunch> {
  const launches: Record<string, BackgroundLaunch> = {}
  for (const step of steps) {
    if (step.type !== "tool") continue
    const taskId = step.tool.background?.taskId
    if (!taskId || !step.tool.command) continue
    launches[taskId] = {
      stepKey: step.key,
      command: step.tool.command.display,
      description: step.tool.command.description,
    }
  }
  return launches
}

/**
 * A delegation's status checks are rows of their own — the agent waiting on
 * the task, right after handing it over or after other work — yet the newest
 * of them says how the delegation stands: hand the delegation step the polls
 * about its task, so its step bar and result read that report.
 */
function linkLaterDelegationPolls(steps: ActivityStep[]): ActivityStep[] {
  const tasksOf = new Map<AdaptedToolCallPart[], Set<string | null>>()
  const tasksIn = (polls: AdaptedToolCallPart[]): Set<string | null> => {
    const cached = tasksOf.get(polls)
    if (cached) return cached
    const tasks = new Set(buildDelegationTaskRows(polls).map((r) => r.taskId))
    tasksOf.set(polls, tasks)
    return tasks
  }
  return steps.map((step, index) => {
    if (step.type !== "tool" || step.tool.kind !== "delegation") return step
    const taskId = delegateCallTaskId(step.part)
    if (taskId === null) return step
    const later: AdaptedToolCallPart[] = []
    for (const next of steps.slice(index + 1)) {
      if (next.type === "delegation-polls" && tasksIn(next.polls).has(taskId)) {
        later.push(...next.polls)
      }
    }
    return later.length > 0 ? { ...step, laterPolls: later } : step
  })
}

function collectSteps(
  parts: AdaptedContentPart[],
  isStreaming: boolean
): ActivityStep[] {
  const steps: ActivityStep[] = []
  const anchor = replyAnchor(parts)
  parts.forEach((part, index) => {
    switch (part.type) {
      case "text":
        if (part.text.trim().length > 0) {
          steps.push({ type: "note", key: `note:${anchor}:${index}`, part })
        }
        return
      case "proposed-plan":
      case "turn-error":
        steps.push({ type: "note", key: `note:${anchor}:${index}`, part })
        return
      case "reasoning": {
        const streaming = isStreaming && part.isStreaming
        if (!streaming && part.content.trim().length === 0) return
        steps.push({
          type: "thought",
          key: `thought:${anchor}:${index}`,
          part,
          title: thoughtTitle(part.content, streaming),
          streaming,
        })
        return
      }
      case "tool-call":
        steps.push(toolStep(part))
        return
      case "tool-result":
        steps.push({
          type: "tool-result",
          key: `result:${part.toolCallId}:${index}`,
          part,
        })
        return
      case "delegation-status-group":
        if (part.polls.length === 0) return
        steps.push({
          type: "delegation-polls",
          key: `dpoll:${part.polls[0]!.toolCallId}`,
          polls: part.polls,
          status: combineStatuses(part.polls.map((p) => toolCallStatus(p))),
        })
        return
      case "background-task-group":
        if (part.polls.length === 0) return
        steps.push({
          type: "background-tasks",
          key: `bg:${part.polls[0]!.toolCallId}`,
          polls: part.polls,
          status: backgroundStatus(part.polls),
          launches: launchesBefore(steps),
        })
        return
      case "goal-run":
        steps.push({
          type: "goal",
          key: `goal:${part.start.toolCallId}`,
          part,
          // The goal row has no answer slot: whatever prose the run holds
          // (the answer streaming inside a live run, notes before its closing
          // update_goal) stays a step, or it would never be drawn.
          model: buildActivityUncached(part.items, part.isRunning, false),
        })
        return
      case "plan":
        steps.push({ type: "plan", key: `plan:${anchor}:${index}`, part })
        return
      case "generated-image":
        steps.push({ type: "image", key: `image:${anchor}:${index}`, part })
        return
    }
  })
  return steps
}

function buildActivityUncached(
  parts: AdaptedContentPart[],
  isStreaming: boolean,
  splitAnswer = true
): ActivityModel {
  const { body, trailing } = splitAnswer
    ? splitTrailingAnswerParts(parts)
    : { body: parts, trailing: [] }
  const steps = linkLaterDelegationPolls(collectSteps(body, isStreaming))
  return {
    steps,
    items: groupActivitySteps(steps.filter((s) => !isBlankInterruption(s))),
    answer: trailing,
    summary: summarizeActivity(steps),
  }
}

const cache = new WeakMap<
  AdaptedContentPart[],
  Partial<
    Record<
      "streaming" | "settled" | "streaming:all" | "settled:all",
      ActivityModel
    >
  >
>()

/**
 * Build the activity model for one reply. Cached per `parts` array: a settled
 * reply's array is pinned by the per-turn adapter cache and the merged-run
 * cache, so scrolling and re-rendering never rebuild it.
 */
export function buildActivity(
  parts: AdaptedContentPart[],
  opts: {
    isStreaming: boolean
    /** Keep closing prose as steps instead of splitting it off as the
     *  answer — for a sub-agent's own timeline, which has no answer slot. */
    keepAnswer?: boolean
  }
): ActivityModel {
  let entry = cache.get(parts)
  if (!entry) {
    entry = {}
    cache.set(parts, entry)
  }
  const slot =
    `${opts.isStreaming ? "streaming" : "settled"}${opts.keepAnswer ? ":all" : ""}` as const
  const cached = entry[slot]
  if (cached) return cached
  const model = buildActivityUncached(parts, opts.isStreaming, !opts.keepAnswer)
  entry[slot] = model
  return model
}
