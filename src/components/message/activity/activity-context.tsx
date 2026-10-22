"use client"

import { createContext, useContext, type ReactNode } from "react"

import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"

/**
 * What the timeline's rows need from the surface that renders them.
 *
 * `renderPart` draws a part the way the classic renderer does — prose, the
 * dedicated cards the timeline still hosts inside a row. It is injected rather
 * than imported because that renderer is the one that mounts the timeline;
 * importing it here would close an import cycle.
 */
export interface ActivityRenderContextValue {
  renderPart: (part: AdaptedContentPart, key: string) => ReactNode
  /** The reply is still being written. */
  isStreaming: boolean
  /** Failed steps a later step redid successfully (see `summarizeActivity`). */
  recoveredKeys: ReadonlySet<string>
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
