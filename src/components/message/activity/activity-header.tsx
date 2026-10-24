"use client"

import { memo, useMemo, type MouseEvent } from "react"
import { useTranslations } from "next-intl"

import type { ActivitySummary } from "@/lib/activity/types"
import { cn } from "@/lib/utils"
import { RowChevron } from "./activity-row"

/** Categories the header names, most telling first; at most three are shown
 *  (the full breakdown is in the tooltip) so the line never reads like a
 *  debug dump. */
const CATEGORY_ORDER = [
  "commands",
  "editedFiles",
  "agents",
  "mcp",
  "web",
  "readFiles",
  "searches",
] as const

const CATEGORY_KEY = {
  commands: "header.commands",
  editedFiles: "header.edits",
  agents: "header.agents",
  mcp: "header.mcp",
  web: "header.web",
  readFiles: "header.reads",
  searches: "header.searches",
} as const

/**
 * The turn's activity header: a capsule only as wide as what it says —
 * `Activity 14 steps · 3m 34s · 1 failed, recovered ›`. The count comes
 * first, the time right after it, then how the turn ended; the breakdown by
 * kind (`6 commands · 1 edit · …`) is the tooltip's, not the line's, so the
 * capsule stays short however much a turn did. While the turn runs it reads
 * `Working 6 steps` with a shimmer; a reply with no steps keeps a `Reply 3s`
 * header so the slot never blinks in and out as a turn settles.
 *
 * An unrecovered failure is red and, when `onJumpToFailure` is given, a button
 * that opens the turn at that step.
 */
export const ActivityHeader = memo(function ActivityHeader({
  summary,
  completed,
  hasSteps,
  elapsed,
  toggle,
  onJumpToFailure,
}: {
  summary: ActivitySummary | null
  completed: boolean
  hasSteps: boolean
  elapsed: string | null
  /** Folding the turn away, when it can fold. */
  toggle?: { open: boolean; onToggle: () => void; controls?: string }
  onJumpToFailure?: () => void
}) {
  const t = useTranslations("Folder.chat.activity")
  const separator = t("header.separator")

  // The line carries the step count only — the breakdown by kind is what the
  // tooltip is for. `full` keeps it for that tooltip, most telling first.
  const { pieces, full } = useMemo(() => {
    if (!summary) return { pieces: [] as string[], full: [] as string[] }
    const categories = CATEGORY_ORDER.filter(
      (key) => summary.counts[key] > 0
    ).map((key) => t(CATEGORY_KEY[key], { count: summary.counts[key] }))
    const lead =
      summary.steps > 0 ? [t("header.steps", { count: summary.steps })] : []
    return { pieces: lead, full: [...lead, ...categories] }
  }, [summary, t])

  const label = !completed
    ? t("header.working")
    : hasSteps
      ? t("header.label")
      : t("header.reply")

  const failureClause =
    summary && summary.failed > 0
      ? summary.unrecovered > 0
        ? {
            text: t("header.failed", { count: summary.unrecovered }),
            danger: true,
          }
        : {
            text: t("header.failedRecovered", { count: summary.failed }),
            danger: false,
          }
      : null
  const interruptedClause =
    summary && summary.interrupted > 0
      ? t("header.interrupted", { count: summary.interrupted })
      : null

  const tooltip = full.join(separator)
  // The label takes the same size as the figures beside it; only its weight
  // sets it apart.
  const labelClass = cn(
    "shrink-0 text-xs font-semibold",
    completed ? "text-foreground" : "activity-shimmer"
  )

  // The whole header folds and unfolds the reply; its label is the control
  // for the keyboard and screen readers. A press on a button inside (that
  // label, the failure link) is the button's own, and one that ends a text
  // selection is not a toggle.
  const onHeaderClick = toggle
    ? (event: MouseEvent<HTMLDivElement>) => {
        if ((event.target as Element | null)?.closest("button")) return
        if (window.getSelection()?.toString()) return
        toggle.onToggle()
      }
    : undefined

  return (
    <div
      // `ws-msg-chip`: over a workspace background image the capsule turns
      // translucent like the reply's other small surfaces, with its own ring.
      className={cn(
        "ws-msg-chip inline-flex w-fit max-w-full min-w-0 items-center gap-2 rounded-full bg-muted/60 py-1 pe-3 ps-3.5 text-xs leading-6 transition-colors",
        toggle && "group/row cursor-pointer hover:bg-muted"
      )}
      onClick={onHeaderClick}
    >
      <span className="flex min-w-0 items-center gap-2">
        {toggle ? (
          <button
            type="button"
            className={cn(
              labelClass,
              "cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
            aria-expanded={toggle.open}
            aria-controls={toggle.controls}
            onClick={toggle.onToggle}
          >
            {label}
          </button>
        ) : (
          <span className={labelClass}>{label}</span>
        )}
        {/* A reply with no steps still keeps its time (`Reply 3s`), so the
            slot never blinks in and out as a turn settles. */}
        {pieces.length > 0 ||
        failureClause ||
        interruptedClause ||
        (elapsed && completed) ? (
          <span
            className="activity-mono min-w-0 truncate text-xs text-muted-foreground"
            title={tooltip || undefined}
          >
            {pieces.join(separator)}
            {elapsed && completed ? (
              <>
                {pieces.length > 0 ? separator : null}
                {elapsed}
              </>
            ) : null}
            {failureClause ? (
              <>
                {pieces.length > 0 || (elapsed && completed) ? separator : null}
                {failureClause.danger && onJumpToFailure ? (
                  <button
                    type="button"
                    className="rounded-sm text-tone-danger underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={t("header.jumpToFailure")}
                    onClick={onJumpToFailure}
                  >
                    {failureClause.text}
                  </button>
                ) : (
                  <span
                    className={
                      failureClause.danger ? "text-tone-danger" : undefined
                    }
                  >
                    {failureClause.text}
                  </span>
                )}
              </>
            ) : null}
            {interruptedClause ? (
              <>
                {pieces.length > 0 || (elapsed && completed) || failureClause
                  ? separator
                  : null}
                {interruptedClause}
              </>
            ) : null}
          </span>
        ) : null}
      </span>
      {/* The chevron ends the capsule, centred on it (the row's own is
            placed for a 1.5rem line by margin, which the flex centres here). */}
      {toggle ? (
        <RowChevron open={toggle.open} always className="mb-0 mt-0" />
      ) : null}
    </div>
  )
})
