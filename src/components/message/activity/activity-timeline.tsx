"use client"

import { memo, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { hasVisibleAnswer } from "@/lib/activity/build-activity"
import type {
  ActivityItem,
  ActivityModel,
  ActivityStep,
} from "@/lib/activity/types"
import { ActivityRenderProvider, useActivityRender } from "./activity-context"
import { GOAL_ICON, IMAGE_ICON, toolIcon } from "./step-visuals"
import { AskQuestionResultCard } from "../ask-question-result-card"
import { CODEG_MCP_TOOL_ICONS, CodegMcpToolCard } from "../codeg-mcp-tool-card"
import { GoalRunPart, GoalToolCallPart } from "../goal-tool-call"
import { isCodegMcpWorkbenchTool } from "@/lib/codeg-mcp-tool"
import { AgentRow } from "./rows/agent-row"
import { BackgroundTaskRows } from "./rows/background-task-rows"
import { CommandGroupRow, CommandRow } from "./rows/command-rows"
import {
  DelegationCancelRow,
  DelegationPollsRow,
  DelegationRow,
} from "./rows/delegation-rows"
import { FeedbackRow, PlanModeRow } from "./rows/interaction-rows"
import { PlanRow } from "./rows/plan-row"
import { EditRow } from "./rows/edit-row"
import { ExploreChildRow, ExploreGroupRow } from "./rows/explore-rows"
import { GenericRow, ToolResultRow } from "./rows/generic-row"
import { HostedRow, NoteRow } from "./rows/hosted-row"
import { McpRow } from "./rows/mcp-row"
import { ThoughtRow } from "./rows/thought-row"
import { WorkingSpinner } from "./rail-icon"
import { useEndMarkLine } from "./use-end-mark-line"
import { useLiveToolStep } from "./use-live-step"
import { useRailGrowth } from "./use-rail-growth"

/**
 * The activity timeline: a reply's process as one row per step on a left
 * rail. Grouping, status and summary all come from the activity model
 * (`buildActivity`); this only draws it.
 */
/** Past this many rows a reply opens with its head and tail only. */
const LONG_TIMELINE_ROWS = 150
const LONG_TIMELINE_HEAD = 20
const LONG_TIMELINE_TAIL = 50
/** Rows each "show more" reveals. */
const LONG_TIMELINE_STEP = 200
/** Where a long reply's hidden middle sits among its rows (and its key). */
const FOLD = "fold"
/** The turning mark at the foot of a live reply's rail (its key). */
const WORKING = "working"

export const ActivityTimeline = memo(function ActivityTimeline({
  model,
  isStreaming,
  renderPart,
  pinnedOnly = false,
  working = false,
  headed = false,
}: {
  model: ActivityModel
  isStreaming: boolean
  renderPart: (part: AdaptedContentPart, key: string) => ReactNode
  pinnedOnly?: boolean
  /** The reply ends on this list while its agent is at work: the rail runs
   *  on past the last row to a turning mark. */
  working?: boolean
  /** The list hangs under the turn's header capsule: its first step sits as
   *  far below it as a step below the one before, and the rail runs up to
   *  it (globals.css). */
  headed?: boolean
}) {
  const t = useTranslations("Folder.chat.activity")
  const context = useMemo(
    () => ({
      renderPart,
      isStreaming,
      recoveredKeys: model.summary.recoveredKeys,
      pinnedOnly,
      renderNested: (nested: ActivityModel, nestedStreaming: boolean) => (
        <ActivityTimeline
          model={nested}
          isStreaming={nestedStreaming}
          renderPart={renderPart}
        />
      ),
    }),
    [renderPart, isStreaming, model.summary.recoveredKeys, pinnedOnly]
  )
  // A giant reply (an agent loop of hundreds of calls) opens with its first
  // and last rows; the middle is revealed a chunk at a time. Message-level
  // virtualization keeps working: this only bounds one row's own DOM.
  const [revealed, setRevealed] = useState(0)
  const items = model.items
  // Done, it ends on its end mark, level with its last row's last line — once
  // there is a list to end (none is drawn without rows).
  const reached = !pinnedOnly && !isStreaming
  const listRef = useRef<HTMLOListElement>(null)
  useEndMarkLine(listRef, reached && items.length > 0)
  // Still going, its rail grows down to each step that joins it.
  useRailGrowth(listRef, !pinnedOnly && isStreaming && items.length > 0)
  const long = items.length > LONG_TIMELINE_ROWS && !pinnedOnly
  // While it streams, its rows slide into the fold one at a time as new ones
  // arrive: cutting the tail to size the moment it crossed the threshold would
  // unmount dozens of rows at once, mid-stream. Settled, it opens trimmed.
  const tailSize = isStreaming
    ? LONG_TIMELINE_ROWS - LONG_TIMELINE_HEAD
    : LONG_TIMELINE_TAIL
  const hidden = long
    ? Math.max(0, items.length - LONG_TIMELINE_HEAD - tailSize - revealed)
    : 0
  if (items.length === 0) return null
  const headSize = LONG_TIMELINE_HEAD + revealed
  // A group the reply has moved past — a row follows it, or the answer under
  // the rows does — takes no more members.
  const lastKey = items[items.length - 1]!.key
  const answerFollows = hasVisibleAnswer(model.answer)
  // One list of children, the fold among them: a row that moves between the
  // head, the fold and the tail keeps its key's place, never remounting.
  const rows = items.flatMap<ActivityItem | typeof FOLD>((item, index) => {
    if (hidden === 0 || index < headSize) return [item]
    if (index === headSize) return [FOLD]
    return index >= items.length - tailSize ? [item] : []
  })
  return (
    <ActivityRenderProvider value={context}>
      <ol
        ref={listRef}
        role="list"
        className="activity-timeline empty:hidden"
        // Its end mark, once its steps are done — the reply's, or a
        // sub-agent's (globals.css); the rows still running under a folded
        // reply are no list of steps to end.
        data-end={pinnedOnly ? undefined : reached ? "reached" : "pending"}
        data-headed={headed ? "" : undefined}
      >
        {rows.map((item) =>
          item === FOLD ? (
            <li key={FOLD} className="activity-item" data-marker="dot">
              <span className="absolute start-[0.4375rem] top-[0.6875rem] flex size-1.5 items-center justify-center">
                <span className="size-1.5 rounded-full bg-muted-foreground/50" />
              </span>
              <button
                type="button"
                className="min-h-7 rounded-sm py-0.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  setRevealed((count) => count + LONG_TIMELINE_STEP)
                }
              >
                {t("row.showMoreSteps", { count: hidden })}
              </button>
            </li>
          ) : (
            <ActivityItemView
              key={item.key}
              item={item}
              followed={
                item.type === "group" && (item.key !== lastKey || answerFollows)
              }
            />
          )
        )}
        {/* Last, so the rows that join go in above it: the last row's segment
            runs on to it like to a row's ring. */}
        {working && isStreaming && !pinnedOnly ? (
          <li
            key={WORKING}
            aria-hidden="true"
            className="activity-item h-6"
            data-marker="working"
          >
            <WorkingSpinner />
          </li>
        ) : null}
      </ol>
    </ActivityRenderProvider>
  )
})

/** Rows that can outlive their turn — kept in view when the turn folds (each
 *  says itself whether it is still live). */
function canOutliveTurn(item: ActivityItem): boolean {
  if (item.type !== "step") return false
  const { step } = item
  if (step.type === "background-tasks" || step.type === "delegation-polls") {
    return true
  }
  return (
    step.type === "tool" &&
    (step.tool.kind === "delegation" ||
      step.tool.kind === "delegation-status" ||
      step.tool.kind === "agent")
  )
}

const ActivityItemView = memo(function ActivityItemView({
  item,
  followed,
}: {
  item: ActivityItem
  /** A group with something after it in the reply (see `CommandGroupRow`). */
  followed: boolean
}) {
  const { pinnedOnly } = useActivityRender()
  if (pinnedOnly && !canOutliveTurn(item)) return null
  if (item.type === "group") {
    return item.kind === "explore" ? (
      <ExploreGroupRow
        groupKey={item.key}
        steps={item.steps}
        status={item.status}
      />
    ) : (
      <CommandGroupRow
        groupKey={item.key}
        steps={item.steps}
        status={item.status}
        followed={followed}
      />
    )
  }
  return <StepView step={item.step} />
})

function StepView({ step }: { step: ActivityStep }) {
  const t = useTranslations("Folder.chat.activity")
  const { renderPart, renderNested } = useActivityRender()
  switch (step.type) {
    case "thought":
      return <ThoughtRow step={step} />
    case "note":
      return (
        <NoteRow stepKey={step.key}>{renderPart(step.part, step.key)}</NoteRow>
      )
    case "tool-result":
      return <ToolResultRow step={step} />
    case "tool":
      return <ToolStepView step={step} />
    case "plan":
      return <PlanRow step={step} />
    case "image":
      return (
        <HostedRow
          stepKey={step.key}
          icon={IMAGE_ICON}
          status={
            step.part.status === "failed"
              ? "failed"
              : step.part.image
                ? "succeeded"
                : "running"
          }
          kindLabel={t("kind.image")}
        >
          {renderPart(step.part, step.key)}
        </HostedRow>
      )
    case "delegation-polls":
      return <DelegationPollsRow step={step} />
    case "background-tasks":
      return <BackgroundTaskRows step={step} />
    case "goal":
      return (
        <HostedRow
          stepKey={step.key}
          icon={GOAL_ICON}
          status={step.part.isRunning ? "running" : "succeeded"}
          kindLabel={t("kind.goal")}
          inset={false}
        >
          <GoalRunPart
            part={step.part}
            renderBody={() => renderNested(step.model, step.part.isRunning)}
          />
        </HostedRow>
      )
  }
}

type ToolStep = Extract<ActivityStep, { type: "tool" }>

function ToolStepView({ step: given }: { step: ToolStep }) {
  const t = useTranslations("Folder.chat.activity")
  const { renderPart } = useActivityRender()
  // A pending approval's call waits on the user, an answered one carries the
  // answer — whatever the transcript says.
  const step = useLiveToolStep(given)
  const { tool, part } = step
  switch (tool.kind) {
    case "read":
    case "search":
    case "glob":
    case "list":
    case "fetch":
    case "web-search":
    case "memory":
      return <ExploreChildRow step={step} standalone />
    case "command":
    case "script":
    case "shell-session":
      return <CommandRow step={step} />
    case "edit":
      return <EditRow step={step} />
    case "mcp":
      return <McpRow step={step} />
    case "generic":
    case "skill":
    case "todo":
    case "completion":
      return <GenericRow step={step} />
    case "agent":
      return <AgentRow step={step} />
    case "delegation":
      return <DelegationRow step={step} />
    case "delegation-status":
      return (
        <DelegationPollsRow
          step={{
            type: "delegation-polls",
            key: step.key,
            polls: [part],
            status: tool.status,
          }}
        />
      )
    case "delegation-cancel":
      return <DelegationCancelRow part={part} stepKey={step.key} />
    case "plan-mode":
      return <PlanModeRow step={step} />
    case "feedback":
      return <FeedbackRow step={step} />
    case "question":
      return (
        <HostedRow
          stepKey={step.key}
          icon={toolIcon(tool)}
          status={tool.status}
          kindLabel={t("kind.question")}
          inset={false}
        >
          <AskQuestionResultCard
            input={part.input ?? null}
            output={part.output ?? null}
            errorText={part.errorText ?? null}
            state={part.state}
          />
        </HostedRow>
      )
    case "workbench": {
      const name = tool.toolName.toLowerCase()
      if (isCodegMcpWorkbenchTool(name)) {
        return (
          <HostedRow
            stepKey={step.key}
            icon={CODEG_MCP_TOOL_ICONS[name]}
            status={tool.status}
            kindLabel={t("kind.other")}
            inset={false}
          >
            <CodegMcpToolCard
              layout="timeline"
              tool={name}
              input={part.input ?? null}
              output={part.output ?? null}
              errorText={part.errorText ?? null}
              state={part.state}
            />
          </HostedRow>
        )
      }
      break
    }
    case "goal":
      return (
        <HostedRow
          stepKey={step.key}
          icon={GOAL_ICON}
          status={tool.status}
          kindLabel={t("kind.goal")}
          inset={false}
        >
          <GoalToolCallPart part={{ ...part, toolName: tool.toolName }} />
        </HostedRow>
      )
  }
  return (
    <HostedRow
      stepKey={step.key}
      icon={toolIcon(tool)}
      status={tool.status}
      kindLabel={t(hostedKindKey(tool.kind))}
    >
      {renderPart(part, step.key)}
    </HostedRow>
  )
}

function hostedKindKey(kind: string) {
  switch (kind) {
    case "agent":
    case "collab-agent":
      return "kind.agent" as const
    case "delegation":
    case "delegation-status":
    case "delegation-cancel":
    case "delegation-resume":
      return "kind.delegation" as const
    case "question":
      return "kind.question" as const
    case "plan-mode":
      return "kind.plan" as const
    case "goal":
      return "kind.goal" as const
    default:
      return "kind.other" as const
  }
}
