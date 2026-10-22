"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import type { PlanEntryInfo } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleDotIcon,
  Loader2Icon,
} from "lucide-react"

// ── Shared status/priority label + style helpers ──────────────────────
// Single source of truth for plan entry labels/colors, shared by the timeline's
// plan row and <AgentPlanOverlay> (floating chip) so the two surfaces never
// drift.

export type StatusKey =
  | "status.completed"
  | "status.inProgress"
  | "status.pending"
  | "status.unknown"

export function getStatusKey(status: string): StatusKey {
  switch (status) {
    case "completed":
      return "status.completed"
    case "in_progress":
      return "status.inProgress"
    case "pending":
      return "status.pending"
    default:
      return "status.unknown"
  }
}

export type PriorityKey =
  | "priority.high"
  | "priority.medium"
  | "priority.low"
  | "priority.unknown"

export function getPriorityKey(priority: string): PriorityKey {
  switch (priority) {
    case "high":
      return "priority.high"
    case "medium":
      return "priority.medium"
    case "low":
      return "priority.low"
    default:
      return "priority.unknown"
  }
}

export function getPriorityClassName(priority: string): string {
  switch (priority) {
    case "high":
      return "text-tone-danger bg-tone-danger/10 border-tone-danger/20"
    case "medium":
      return "text-tone-warning bg-tone-warning/10 border-tone-warning/20"
    case "low":
      return "text-muted-foreground bg-muted border-border"
    default:
      return "text-muted-foreground"
  }
}

function StatusIcon({
  status,
  isStreaming,
}: {
  status: string
  isStreaming: boolean
}) {
  if (status === "completed") {
    return <CheckCircle2Icon className="size-3.5 shrink-0 text-tone-success" />
  }
  if (status === "in_progress") {
    return isStreaming ? (
      <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground/70" />
    ) : (
      <CircleDotIcon className="size-3.5 shrink-0 text-foreground/70" />
    )
  }
  return (
    <CircleDashedIcon className="size-3.5 shrink-0 text-muted-foreground" />
  )
}

/**
 * The plan entry rows (checklist body), shared by every plan surface so they
 * render identically.
 */
export const PlanEntriesList = memo(function PlanEntriesList({
  entries,
  isStreaming = false,
}: {
  entries: PlanEntryInfo[]
  isStreaming?: boolean
}) {
  const t = useTranslations("Folder.chat.agentPlanOverlay")

  if (entries.length === 0) return null

  return (
    <div className="space-y-1">
      {entries.map((entry, index) => (
        <div
          key={`${entry.content}-${index}`}
          className="flex items-start gap-2 px-1 py-1 text-sm"
        >
          <span className="mt-0.5">
            <StatusIcon status={entry.status} isStreaming={isStreaming} />
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 leading-5 break-words [overflow-wrap:anywhere]",
              entry.status === "completed"
                ? "text-muted-foreground line-through"
                : "text-foreground"
            )}
          >
            {entry.content}
          </span>
          <Badge
            variant="outline"
            className={cn(
              "h-5 shrink-0 text-3xs uppercase",
              getPriorityClassName(entry.priority)
            )}
          >
            {t(getPriorityKey(entry.priority))}
          </Badge>
        </div>
      ))}
    </div>
  )
})
