"use client"

import { memo, useMemo, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type {
  ActivityItem,
  ActivityModel,
  ActivityStep,
} from "@/lib/activity/types"
import { ActivityRenderProvider, useActivityRender } from "./activity-context"
import {
  BACKGROUND_TASK_ICON,
  DELEGATION_ICON,
  GOAL_ICON,
  IMAGE_ICON,
  PLAN_ICON,
  toolIcon,
} from "./step-visuals"
import { CommandGroupRow, CommandRow } from "./rows/command-rows"
import { EditRow } from "./rows/edit-row"
import { ExploreChildRow, ExploreGroupRow } from "./rows/explore-rows"
import { GenericRow, ToolResultRow } from "./rows/generic-row"
import { HostedRow, NoteRow } from "./rows/hosted-row"
import { McpRow } from "./rows/mcp-row"
import { ThoughtRow } from "./rows/thought-row"

/**
 * The activity timeline: a reply's process as one row per step on a left
 * rail. Grouping, status and summary all come from the activity model
 * (`buildActivity`); this only draws it.
 */
export const ActivityTimeline = memo(function ActivityTimeline({
  model,
  isStreaming,
  renderPart,
}: {
  model: ActivityModel
  isStreaming: boolean
  renderPart: (part: AdaptedContentPart, key: string) => ReactNode
}) {
  const context = useMemo(
    () => ({
      renderPart,
      isStreaming,
      recoveredKeys: model.summary.recoveredKeys,
    }),
    [renderPart, isStreaming, model.summary.recoveredKeys]
  )
  if (model.items.length === 0) return null
  return (
    <ActivityRenderProvider value={context}>
      <ol role="list" className="activity-timeline">
        {model.items.map((item) => (
          <ActivityItemView key={item.key} item={item} />
        ))}
      </ol>
    </ActivityRenderProvider>
  )
})

const ActivityItemView = memo(function ActivityItemView({
  item,
}: {
  item: ActivityItem
}) {
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
      />
    )
  }
  return <StepView step={item.step} />
})

function StepView({ step }: { step: ActivityStep }) {
  const t = useTranslations("Folder.chat.activity")
  const { renderPart } = useActivityRender()
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
      switch (step.tool.kind) {
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
        default:
          return (
            <HostedRow
              stepKey={step.key}
              icon={toolIcon(step.tool)}
              status={step.tool.status}
              kindLabel={t(hostedKindKey(step.tool.kind))}
            >
              {renderPart(step.part, step.key)}
            </HostedRow>
          )
      }
    case "plan":
      return (
        <HostedRow
          stepKey={step.key}
          icon={PLAN_ICON}
          status={step.part.isStreaming ? "running" : "succeeded"}
          kindLabel={t("kind.plan")}
        >
          {renderPart(step.part, step.key)}
        </HostedRow>
      )
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
      return (
        <HostedRow
          stepKey={step.key}
          icon={DELEGATION_ICON}
          status={step.status}
          kindLabel={t("kind.delegation")}
        >
          {renderPart(
            { type: "delegation-status-group", polls: step.polls },
            step.key
          )}
        </HostedRow>
      )
    case "background-tasks":
      return (
        <HostedRow
          stepKey={step.key}
          icon={BACKGROUND_TASK_ICON}
          status={step.status}
          kindLabel={t("kind.background")}
        >
          {renderPart(
            { type: "background-task-group", polls: step.polls },
            step.key
          )}
        </HostedRow>
      )
    case "goal":
      return (
        <HostedRow
          stepKey={step.key}
          icon={GOAL_ICON}
          status={step.part.isRunning ? "running" : "succeeded"}
          kindLabel={t("kind.goal")}
        >
          {renderPart(step.part, step.key)}
        </HostedRow>
      )
  }
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
