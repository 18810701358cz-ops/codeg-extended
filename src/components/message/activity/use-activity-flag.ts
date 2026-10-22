"use client"

import { useSyncExternalStore } from "react"

/**
 * Internal switch between the activity timeline and the legacy tool cards,
 * read from `localStorage["codeg.dev.activityTimeline"]` ("1" on, "0" off).
 *
 * Deliberately not a user setting: it exists only while both renderers ship,
 * so the new one can be compared against the old in a real workspace, and
 * goes away with the legacy path.
 */
export const ACTIVITY_TIMELINE_STORAGE_KEY = "codeg.dev.activityTimeline"

const DEFAULT_ENABLED = false

let cached: boolean | null = null
const listeners = new Set<() => void>()

function readStored(): boolean {
  try {
    const value = window.localStorage.getItem(ACTIVITY_TIMELINE_STORAGE_KEY)
    if (value === "1") return true
    if (value === "0") return false
  } catch {
    // Storage unavailable (private mode, sandboxed frame): use the default.
  }
  return DEFAULT_ENABLED
}

function snapshot(): boolean {
  if (typeof window === "undefined") return DEFAULT_ENABLED
  if (cached === null) cached = readStored()
  return cached
}

function notify() {
  for (const listener of listeners) listener()
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== ACTIVITY_TIMELINE_STORAGE_KEY) return
  cached = readStored()
  notify()
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener("storage", onStorage)
  }
}

export function useActivityTimelineEnabled(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_ENABLED)
}

/**
 * Turn the timeline on or off for this window and remember it (`null` forgets
 * the choice and returns to the default). For the gallery page and tests.
 */
export function setActivityTimelineEnabled(value: boolean | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(ACTIVITY_TIMELINE_STORAGE_KEY)
    } else {
      window.localStorage.setItem(
        ACTIVITY_TIMELINE_STORAGE_KEY,
        value ? "1" : "0"
      )
    }
  } catch {
    // Storage unavailable: the in-memory value below still applies.
  }
  cached = value ?? DEFAULT_ENABLED
  notify()
}
