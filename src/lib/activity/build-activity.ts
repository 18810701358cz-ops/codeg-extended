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

function collectSteps(
  parts: AdaptedContentPart[],
  isStreaming: boolean
): ActivityStep[] {
  const steps: ActivityStep[] = []
  parts.forEach((part, index) => {
    switch (part.type) {
      case "text":
        if (part.text.trim().length > 0) {
          steps.push({ type: "note", key: `note:${index}`, part })
        }
        return
      case "proposed-plan":
      case "turn-error":
        steps.push({ type: "note", key: `note:${index}`, part })
        return
      case "reasoning": {
        const streaming = isStreaming && part.isStreaming
        if (!streaming && part.content.trim().length === 0) return
        steps.push({
          type: "thought",
          key: `thought:${index}`,
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
        steps.push({ type: "plan", key: `plan:${index}`, part })
        return
      case "generated-image":
        steps.push({ type: "image", key: `image:${index}`, part })
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
