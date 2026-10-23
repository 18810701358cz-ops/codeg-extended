"use client"

import type { ComponentType, ReactNode, SVGProps } from "react"

import type { StepStatus } from "@/lib/activity/types"
import { cn } from "@/lib/utils"

export type ActivityIcon = ComponentType<SVGProps<SVGSVGElement>>

/**
 * Ring colour by status, quiet by default: a finished step is grey like the
 * rail, and only a failure (red) or something waiting on the user (amber)
 * takes a colour. A running step is told apart by SHAPE — a dashed ring that
 * turns — never by the primary colour, which on the red and rose presets is
 * the failure hue.
 */
const RING_CLASS: Record<StepStatus, string> = {
  succeeded: "border-activity-ring",
  pending: "border-dashed border-activity-ring",
  running: "border-dashed border-activity-ring",
  awaiting: "border-tone-warning",
  failed: "border-tone-danger",
  rejected: "border-tone-danger",
  cancelled: "border-dashed border-activity-ring",
}

const ICON_CLASS: Record<StepStatus, string> = {
  succeeded: "text-muted-foreground",
  pending: "text-muted-foreground",
  running: "text-foreground/80",
  awaiting: "text-tone-warning",
  failed: "text-tone-danger",
  rejected: "text-tone-danger",
  cancelled: "text-muted-foreground/70",
}

/**
 * The status ring at the head of a row. The ring and the glyph are separate
 * layers so a running ring can turn without turning the glyph. `size="sm"`
 * is for rows inside an expanded group.
 */
export function RailIcon({
  icon: Icon,
  glyph,
  status,
  label,
  size = "md",
  className,
}: {
  icon?: ActivityIcon
  /** Drawn in the ring instead of `icon` — an agent's own logo. */
  glyph?: ReactNode
  status: StepStatus
  /** What the ring says to a screen reader, e.g. "command failed, exit 1". */
  label: string
  size?: "md" | "sm"
  className?: string
}) {
  const live = status === "running" || status === "pending"
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        size === "md" ? "size-5" : "size-4",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-0 rounded-full border-[0.5px]",
          RING_CLASS[status],
          // `animate-spin` survives the "chat animations off" switch on
          // purpose (see globals.css): a turning ring is the one cue left
          // that a step is still running. Reduced motion stops it; the row
          // then says "running" in words instead.
          live &&
            "animate-spin [animation-duration:2.4s] motion-reduce:animate-none"
        )}
      />
      {glyph ??
        (Icon ? (
          <Icon
            aria-hidden="true"
            className={cn(
              size === "md" ? "size-3" : "size-2.5",
              ICON_CLASS[status]
            )}
          />
        ) : null)}
    </span>
  )
}

/**
 * The turning mark a live reply ends on while its agent is at work: at the
 * foot of the rail, which runs down to it, or under the reply when the rail is
 * not its last block: a ring like a step's, a quarter of it open. Placed for
 * a 1.5rem slot, its centre on the rail. Like a running ring it keeps turning
 * with chat animations off and stops under reduced motion; the header says
 * "Working" in words either way. One plain element: a turning element is
 * restyled every frame, its children with it, and an SVG's turn also lays
 * the page out every frame — for as long as the reply streams.
 */
export function WorkingSpinner() {
  return (
    <span
      aria-hidden="true"
      className="absolute start-1 top-1 size-4 animate-spin rounded-full border-[0.5px] border-activity-ring border-t-transparent motion-reduce:animate-none"
    />
  )
}

/** The turning mark on its own, under a live reply (see `WorkingSpinner`). */
export function WorkingMark() {
  return (
    <div aria-hidden="true" className="relative h-6" data-marker="working">
      <WorkingSpinner />
    </div>
  )
}

/** The small dot that marks prose between steps, and explore group members. */
export function RailDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full bg-muted-foreground/50",
        className
      )}
    />
  )
}
