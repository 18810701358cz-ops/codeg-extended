import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useHistoryBackDismiss } from "./use-history-back-dismiss"

function markerOf(state: unknown): unknown {
  return (state as Record<string, unknown> | null)?.["codegBackDismissId"]
}

describe("useHistoryBackDismiss", () => {
  let pushSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    pushSpy = vi.spyOn(window.history, "pushState")
  })
  afterEach(() => {
    pushSpy.mockRestore()
  })

  it("pushes one history entry while active and dismisses on back", async () => {
    const onDismiss = vi.fn()
    renderHook(() => useHistoryBackDismiss(true, onDismiss))
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(markerOf(window.history.state)).toBeTypeOf("number")

    window.history.back()
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1))
  })

  it("re-activating while still holding its entry does not push twice", async () => {
    const onDismiss = vi.fn()
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useHistoryBackDismiss(active, onDismiss),
      { initialProps: { active: true } }
    )
    expect(pushSpy).toHaveBeenCalledTimes(1)
    // Simulates React's StrictMode double-mount (cleanup + setup, same refs):
    // the marker is still the current entry's, so the entry is reused.
    rerender({ active: false })
    rerender({ active: true })
    expect(pushSpy).toHaveBeenCalledTimes(1)

    // Leave no residue behind for later cases in this file.
    window.history.back()
    await waitFor(() => expect(markerOf(window.history.state)).toBeUndefined())
  })

  it("a non-back close leaves the entry and absorbs the next back silently", async () => {
    const onDismiss = vi.fn()
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useHistoryBackDismiss(active, onDismiss),
      { initialProps: { active: true } }
    )
    rerender({ active: false })

    // The back consumes the leftover entry with no visible effect: no dismiss.
    window.history.back()
    await waitFor(() => expect(markerOf(window.history.state)).toBeUndefined())
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it("stacked layers: back closes only the topmost one", async () => {
    const dismissA = vi.fn()
    const dismissB = vi.fn()
    renderHook(() => useHistoryBackDismiss(true, dismissA))
    renderHook(() => useHistoryBackDismiss(true, dismissB))
    expect(pushSpy).toHaveBeenCalledTimes(2)
    const markerA = markerOf(window.history.state)
    expect(markerA).not.toBeUndefined()

    window.history.back()
    await waitFor(() => expect(dismissB).toHaveBeenCalledTimes(1))
    expect(dismissA).not.toHaveBeenCalled()

    window.history.back()
    await waitFor(() => expect(dismissA).toHaveBeenCalledTimes(1))
  })
})
