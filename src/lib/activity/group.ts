/**
 * Fold a turn's steps into the rows the timeline draws.
 *
 * - Consecutive exploration calls (read / search / glob / list / fetch / web
 *   search / memory) become one "Explored" row; consecutive commands one "Ran N
 *   commands" row. A run needs two members — a lone call stays a plain row.
 * - A finished thought written between two exploration calls joins their row,
 *   in place, instead of splitting the run in two (codex's activity grouping).
 *   A thought before the first call stays its own row — "thought, then did" —
 *   and one still being written never joins anything.
 * - Everything else ends a run: prose, edits, MCP and other tools, sub-agents,
 *   plans, questions. A failed call does NOT end one; it stays inside, and the
 *   group shows the failure.
 * - A group's key is its first member's, so a run that grows keeps its key
 *   (and with it the reader's open/closed choice).
 */

import { combineStatuses } from "./status"
import {
  COMMAND_KINDS,
  EXPLORE_KINDS,
  type ActivityItem,
  type ActivityStep,
  type GroupKind,
} from "./types"

function familyOf(step: ActivityStep): GroupKind | null {
  if (step.type !== "tool") return null
  if (EXPLORE_KINDS.has(step.tool.kind)) return "explore"
  if (COMMAND_KINDS.has(step.tool.kind)) return "command"
  return null
}

interface Run {
  kind: GroupKind
  members: ActivityStep[]
  /** Finished thoughts seen since the run's last call: absorbed if another
   *  call of the run follows, released as their own rows otherwise. */
  pending: ActivityStep[]
}

export function groupActivitySteps(steps: ActivityStep[]): ActivityItem[] {
  const items: ActivityItem[] = []
  let run: Run | null = null

  const emit = (step: ActivityStep) => {
    items.push({ type: "step", key: step.key, step })
  }

  const flush = () => {
    if (!run) return
    const calls = run.members.filter((m) => m.type === "tool")
    if (calls.length >= 2) {
      items.push({
        type: "group",
        key: run.members[0]!.key,
        kind: run.kind,
        steps: run.members,
        status: combineStatuses(
          calls.map((m) => (m.type === "tool" ? m.tool.status : "succeeded"))
        ),
      })
    } else {
      for (const member of run.members) emit(member)
    }
    for (const thought of run.pending) emit(thought)
    run = null
  }

  for (const step of steps) {
    const family = familyOf(step)
    if (family) {
      if (run && run.kind === family) {
        if (run.pending.length > 0) {
          if (family === "explore") {
            run.members.push(...run.pending)
            run.pending = []
          } else {
            flush()
            run = { kind: family, members: [], pending: [] }
          }
        }
        run.members.push(step)
        continue
      }
      flush()
      run = { kind: family, members: [step], pending: [] }
      continue
    }
    if (run?.kind === "explore" && step.type === "thought" && !step.streaming) {
      run.pending.push(step)
      continue
    }
    flush()
    emit(step)
  }
  flush()
  return items
}
