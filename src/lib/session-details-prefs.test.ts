import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  loadSessionDetailsSectionOpen,
  loadSubAgentScope,
  useSessionDetailsSectionOpen,
  useSubAgentScope,
} from "./session-details-prefs"

const SCOPE_KEY = "workspace:session-details:sub-agent-scope"
const sectionKey = (section: string) =>
  `workspace:session-details:open:${section}`

/** What another window's write looks like from here. */
function storedElsewhere(key: string, value: string, eventValue = value) {
  localStorage.setItem(key, value)
  window.dispatchEvent(
    new StorageEvent("storage", { key, newValue: eventValue })
  )
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("session details prefs", () => {
  it("opens every section and lists the current message's sub-agents by default", () => {
    expect(loadSessionDetailsSectionOpen("plan")).toBe(true)
    expect(loadSessionDetailsSectionOpen("subAgents")).toBe(true)
    expect(loadSessionDetailsSectionOpen("messageNav")).toBe(true)
    expect(loadSubAgentScope()).toBe("reply")
  })

  it("stores a change, and every mounted reader follows it", () => {
    const first = renderHook(() => useSessionDetailsSectionOpen("plan"))
    const second = renderHook(() => useSessionDetailsSectionOpen("plan"))
    const other = renderHook(() => useSessionDetailsSectionOpen("subAgents"))
    act(() => first.result.current[1](false))
    expect(first.result.current[0]).toBe(false)
    expect(second.result.current[0]).toBe(false)
    expect(other.result.current[0]).toBe(true)
    expect(localStorage.getItem(sectionKey("plan"))).toBe("closed")
  })

  // A queued `storage` event can carry a value older than what is stored by
  // the time it arrives: the store, not the event, is the truth.
  it("follows another window's change as stored, not as the event says", () => {
    const { result } = renderHook(() => useSubAgentScope())
    act(() => storedElsewhere(SCOPE_KEY, "conversation", "reply"))
    expect(result.current[0]).toBe("conversation")
  })

  it("keeps a change the storage refused for this window, until another window writes", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError")
      })
    const { result } = renderHook(() =>
      useSessionDetailsSectionOpen("messageNav")
    )
    act(() => result.current[1](false))
    expect(result.current[0]).toBe(false)
    expect(localStorage.getItem(sectionKey("messageNav"))).toBeNull()

    setItem.mockRestore()
    act(() => storedElsewhere(sectionKey("messageNav"), "open"))
    expect(result.current[0]).toBe(true)
  })

  // Another window's write can land after a panel's first read and before it
  // subscribes — its event then reaches no one.
  it("picks up a change stored between its first read and its subscription", () => {
    let written = false
    const { result } = renderHook(() => {
      const [scope] = useSubAgentScope()
      if (!written) {
        written = true
        localStorage.setItem(SCOPE_KEY, "conversation")
      }
      return scope
    })
    expect(result.current).toBe("conversation")
  })

  it("hears another window while no panel is mounted", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError")
      })
    const first = renderHook(() => useSessionDetailsSectionOpen("plan"))
    act(() => first.result.current[1](false))
    first.unmount()
    setItem.mockRestore()

    storedElsewhere(sectionKey("plan"), "open")
    const next = renderHook(() => useSessionDetailsSectionOpen("plan"))
    expect(next.result.current[0]).toBe(true)
  })

  it("reads an unreadable storage as the defaults", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    const { result } = renderHook(() => useSubAgentScope())
    expect(result.current[0]).toBe("reply")
    expect(loadSessionDetailsSectionOpen("plan")).toBe(true)
  })
})
