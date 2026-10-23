"use client"

import { useId, useRef, type ReactNode } from "react"
import { ChevronRightIcon } from "lucide-react"

import type { ToolApproval } from "@/lib/activity/approval"
import type { StepStatus } from "@/lib/activity/types"
import { cn } from "@/lib/utils"
import { ApprovalChip, showsApproval } from "./approval-chip"
import { useEndMarkLine } from "./use-end-mark-line"

const MARKER_POSITION = {
  main: {
    ring: "start-0.5 top-1 size-5",
    dot: "start-[0.5625rem] top-[0.6875rem] size-1.5",
  },
  child: {
    ring: "start-0 top-1.5 size-4",
    dot: "start-[0.3125rem] top-[0.6875rem] size-1.5",
  },
} as const

/**
 * One row of the activity timeline: a marker on the rail, a one-line header
 * (label on the start side, a figure on the end side), and an optional detail
 * panel the header toggles.
 *
 * The header never moves when the row opens or closes — the panel only grows
 * below it — and the disclosure chevron always takes its space (it only
 * becomes visible on hover / focus), so nothing shifts when it appears.
 *
 * `variant="child"` is a row inside an expanded group: smaller marker and
 * type, its own dashed sub-rail (see `.activity-child` in globals.css), and
 * the same spacing as the rows around the group.
 */
export function ActivityRow({
  stepKey,
  status,
  marker,
  markerKind = "ring",
  variant = "main",
  children,
  trailing,
  approval,
  expandable = false,
  expanded = false,
  onExpandedChange,
  detail,
  addon,
  title,
  className,
  headerClassName,
}: {
  stepKey: string
  status?: StepStatus
  marker: ReactNode
  markerKind?: "ring" | "dot"
  variant?: "main" | "child"
  /** The header's label. Single line unless the row lets it wrap. */
  children: ReactNode
  /** The right-hand figure: `84 lines`, `+3 −1`, `exit 1`. */
  trailing?: ReactNode
  /** How the call's permission request was answered: a chip ahead of the
   *  figure. */
  approval?: ToolApproval | null
  expandable?: boolean
  expanded?: boolean
  onExpandedChange?: (open: boolean) => void
  /** The panel under the header; only called (and mounted) while open. */
  detail?: () => ReactNode
  /** Always shown under the header, open or not (a folded group's live
   *  member, a live output tail). */
  addon?: ReactNode
  /** Full text of anything the header truncates. */
  title?: string
  className?: string
  headerClassName?: string
}) {
  const detailId = useId()
  const open = expandable && expanded
  const chip = showsApproval(approval, status) ? (
    <ApprovalChip approval={approval} />
  ) : null

  const header = (
    <>
      <span className="flex min-w-0 flex-1 items-start gap-1">
        <span className="min-w-0">{children}</span>
        {expandable ? <RowChevron open={open} /> : null}
      </span>
      {trailing || chip ? (
        <RowFigure>
          {chip}
          {trailing}
        </RowFigure>
      ) : null}
    </>
  )

  // The line height goes after the font size: tailwind-merge drops a
  // `leading-*` that a later `text-*` follows, and the rail's markers and the
  // chevron are placed for a 1.5rem line.
  const headerClass = cn(
    "group/row flex w-full min-w-0 items-start py-0.5 text-start",
    variant === "main" ? "text-sm leading-6" : "text-[0.8125rem] leading-6",
    headerClassName
  )

  return (
    <li
      className={cn(
        variant === "main" ? "activity-item" : "activity-child",
        className
      )}
      data-marker={markerKind}
      data-status={status}
      data-step-key={stepKey}
      // As the last row it runs the rail beside its open panel, down to the
      // end mark (globals.css).
      data-body={open && detail ? "" : undefined}
    >
      <span
        className={cn(
          "absolute flex items-center justify-center",
          MARKER_POSITION[variant][markerKind]
        )}
      >
        {marker}
      </span>
      {expandable ? (
        <button
          type="button"
          className={cn(
            headerClass,
            "cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
          aria-expanded={open}
          aria-controls={open ? detailId : undefined}
          title={title}
          onClick={() => onExpandedChange?.(!open)}
        >
          {header}
        </button>
      ) : (
        <div className={headerClass} title={title}>
          {header}
        </div>
      )}
      {addon}
      {open && detail ? (
        <div id={detailId} className="activity-detail mt-1 mb-1.5">
          {detail()}
        </div>
      ) : null}
    </li>
  )
}

/**
 * The disclosure chevron after a row's label. It always takes its space and
 * only shows on hover / focus — or while the row is open — so nothing shifts
 * when it appears. Focus is the row's own, or a control's inside it. `always`
 * keeps it in view folded too (the activity header's).
 */
export function RowChevron({
  open,
  always = false,
}: {
  open: boolean
  always?: boolean
}) {
  return (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(
        "mt-[0.3125rem] size-3.5 shrink-0 text-muted-foreground transition-[opacity,rotate] rtl:-scale-x-100",
        always
          ? "opacity-100"
          : "opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 group-has-[:focus-visible]/row:opacity-100",
        // Mirrored under RTL, so it turns the other way to point down.
        open && "rotate-90 opacity-100 rtl:-rotate-90"
      )}
    />
  )
}

/**
 * An open group's members, on their own dashed rail. `end` says whether the
 * group is done (`reached`: the members end on their mark, level with the
 * last member's last line) or still going; a folded group's live member
 * under its header has neither.
 */
export function ActivityMembers({
  end,
  children,
}: {
  end?: "pending" | "reached"
  children: ReactNode
}) {
  const listRef = useRef<HTMLUListElement>(null)
  useEndMarkLine(listRef, end === "reached")
  return (
    <ul ref={listRef} role="list" className="activity-children" data-end={end}>
      {children}
    </ul>
  )
}

/** A row header's end column: its figure, status word, time. */
export function RowFigure({ children }: { children: ReactNode }) {
  return (
    <span className="activity-mono ms-auto flex shrink-0 items-center gap-3 ps-3 text-xs leading-6 text-muted-foreground">
      {children}
    </span>
  )
}
