/**
 * `buildActivity`: a reply's adapted parts → the activity timeline's view
 * model (steps, grouped rows, trailing answer, header summary).
 *
 * Runs after the adapter and the cross-turn merge, so every lane those
 * produce — delegation polls, background-task polls, goal runs, plans — is
 * already settled and this only reshapes it: the generic `tool-group` wrapper
 * is opened back up into single calls (grouping is redone here, by kind), the
 * specialized lanes stay whole.
 */

import {
  splitTrailingAnswerParts,
  type AdaptedContentPart,
  type AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import { buildBackgroundTaskRows } from "@/lib/background-task"
import { describeToolCall } from "./describe-tool-call"
import { groupActivitySteps } from "./group"
import { combineStatuses, toolCallStatus, type StepStatus } from "./status"
import { summarizeActivity } from "./summarize"
import { thoughtTitle } from "./thought"
import type { ActivityModel, ActivityStep } from "./types"

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
    if (part.type === "tool-group" && part.items[0]) {
      return part.items[0].toolCallId
    }
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
      case "tool-group":
        for (const item of part.items) steps.push(toolStep(item))
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
        })
        return
      case "goal-run":
        steps.push({
          type: "goal",
          key: `goal:${part.start.toolCallId}`,
          part,
          model: buildActivityUncached(part.items, part.isRunning),
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
  isStreaming: boolean
): ActivityModel {
  const { body, trailing } = splitTrailingAnswerParts(parts)
  const steps = collectSteps(body, isStreaming)
  return {
    steps,
    items: groupActivitySteps(steps.filter((s) => !isBlankInterruption(s))),
    answer: trailing,
    summary: summarizeActivity(steps),
  }
}

const cache = new WeakMap<
  AdaptedContentPart[],
  { streaming?: ActivityModel; settled?: ActivityModel }
>()

/**
 * Build the activity model for one reply. Cached per `parts` array: a settled
 * reply's array is pinned by the per-turn adapter cache and the merged-run
 * cache, so scrolling and re-rendering never rebuild it.
 */
export function buildActivity(
  parts: AdaptedContentPart[],
  opts: { isStreaming: boolean }
): ActivityModel {
  let entry = cache.get(parts)
  if (!entry) {
    entry = {}
    cache.set(parts, entry)
  }
  const slot = opts.isStreaming ? "streaming" : "settled"
  const cached = entry[slot]
  if (cached) return cached
  const model = buildActivityUncached(parts, opts.isStreaming)
  entry[slot] = model
  return model
}
