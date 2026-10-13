"use client"

import { useEffect, useRef } from "react"

// Marker key written into `history.state` for entries this hook pushes, so a
// pop can tell "our layer's entry was popped" from any other history move.
// A per-push unique id (not a boolean) lets stacked layers decide independently
// which one the back actually consumed: only layers whose id is no longer the
// current entry's marker consider themselves popped.
const MARKER = "codegBackDismissId"

let nextId = 1

function currentMarker(): number | null {
  const state = window.history.state
  if (state && typeof state === "object" && MARKER in state) {
    const value = (state as Record<string, unknown>)[MARKER]
    if (typeof value === "number") return value
  }
  return null
}

/**
 * Makes a state-toggled overlay (a panel swap, a drawer) consume one browser
 * back gesture instead of letting that back fall through the real navigation
 * and unload the page — the mobile-web/PWA case, where back is the habitual
 * "close what's on top" gesture and an empty history exits the app outright.
 *
 * While `active` is true the hook keeps one extra history entry pushed (URL
 * unchanged, only `history.state` carries the marker). A back that pops OUR
 * entry calls `onDismiss`. Closing by any other path (close button, programmatic
 * dismiss) does NOT remove the entry — the next back is then absorbed by the
 * marker check with no visible effect. That absorbed extra back is the accepted
 * cost; the alternative (`history.back()` on un-activation) races a
 * same-commit re-push in React's StrictMode dev double-mount and can mis-close
 * the freshly opened layer.
 *
 * `onDismiss` is read through a ref, so callers can pass an inline callback.
 */
export function useHistoryBackDismiss(
  active: boolean,
  onDismiss: () => void
): void {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  // Id of the entry this layer currently owns (0 = none). Persists across the
  // StrictMode remount, so the second mount sees its own marker still on top
  // and reuses the entry instead of pushing a second one.
  const entryIdRef = useRef(0)

  useEffect(() => {
    if (!active) return
    if (entryIdRef.current === 0 || currentMarker() !== entryIdRef.current) {
      const id = nextId++
      const prev = window.history.state
      window.history.pushState(
        { ...(prev && typeof prev === "object" ? prev : {}), [MARKER]: id },
        ""
      )
      entryIdRef.current = id
    }
    const handlePopState = () => {
      // Ignore pops while holding no entry: a back that closed a layer stacked
      // ABOVE this one already reset ours, and must not re-fire onDismiss for
      // later pops of unrelated history.
      if (entryIdRef.current === 0) return
      // The back landed on an entry that is not ours → ours was the one popped.
      if (currentMarker() !== entryIdRef.current) {
        entryIdRef.current = 0
        onDismissRef.current()
      }
    }
    window.addEventListener("popstate", handlePopState)
    return () => {
      window.removeEventListener("popstate", handlePopState)
    }
  }, [active])
}
