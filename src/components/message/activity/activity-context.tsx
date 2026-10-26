"use client"

import { createContext, useContext, type ReactNode } from "react"

import type { ActivityModel } from "@/lib/activity/types"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"

/**
 * What the timeline's rows need from the surface that renders them.
 *
 * `renderPart` draws a part outside the rows' own drawing — prose, plans and
 * images in place, and the dedicated cards the timeline hosts inside a row. It
 * is injected rather than imported because that renderer is the one that
 * mounts the timeline; importing it here would close an import cycle.
 */
export interface ActivityRenderContextValue {
  renderPart: (part: AdaptedContentPart, key: string) => ReactNode
  /** The reply is still being written. */
  isStreaming: boolean
  /** Failed steps a later step redid successfully (see `summarizeActivity`). */
  recoveredKeys: ReadonlySet<string>
  /** Draw a nested timeline (a sub-agent's own steps) with the same wiring. */
  renderNested: (model: ActivityModel, isStreaming: boolean) => ReactNode
  /** Only rows still running are drawn — the folded turn's long-lived rows
   *  (delegations, sub-agents, background tasks that outlive the turn). */
  pinnedOnly: boolean
}

const ActivityRenderContext = createContext<ActivityRenderContextValue | null>(
  null
)

export const ActivityRenderProvider = ActivityRenderContext.Provider

export function useActivityRender(): ActivityRenderContextValue {
  const value = useContext(ActivityRenderContext)
  if (!value) {
    throw new Error("Activity rows must be rendered inside ActivityTimeline")
  }
  return value
}
