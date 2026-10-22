"use client"

import { createContext, useContext, type ReactNode } from "react"

import {
  EMPTY_TOOL_APPROVALS,
  type ToolApprovalMap,
} from "@/lib/activity/approval"

/**
 * Live state of the conversation a timeline belongs to that the transcript
 * itself does not carry: which tool call the agent is waiting on the user to
 * approve, and how the connection's permission requests were answered.
 * Provided by the conversation panel, which holds the connection; a timeline
 * rendered anywhere else (a read-only viewer, the gallery) simply has none.
 */
export interface ActivityLiveValue {
  /** The tool call a pending permission request is about. */
  awaitingToolCallId: string | null
  /** The connection's answered permission requests, by tool call id. */
  approvals: ToolApprovalMap
}

const NONE: ActivityLiveValue = {
  awaitingToolCallId: null,
  approvals: EMPTY_TOOL_APPROVALS,
}

const ActivityLiveContext = createContext<ActivityLiveValue>(NONE)

export function ActivityLiveProvider({
  value,
  children,
}: {
  value: ActivityLiveValue
  children: ReactNode
}) {
  return (
    <ActivityLiveContext.Provider value={value}>
      {children}
    </ActivityLiveContext.Provider>
  )
}

export function useActivityLive(): ActivityLiveValue {
  return useContext(ActivityLiveContext)
}
