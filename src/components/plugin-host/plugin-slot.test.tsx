import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearAllSlots,
  registerSlotContribution,
} from "@/lib/plugin-host/slots"
import { PluginSlot } from "./plugin-slot"

describe("PluginSlot", () => {
  beforeEach(() => {
    clearAllSlots()
  })

  afterEach(() => {
    clearAllSlots()
  })

  it("returns null when no contributions exist for slot", () => {
    const { container } = render(<PluginSlot name="statusbar.left" />)
    expect(container.firstChild).toBeNull()
  })

  it("renders registered contributions and calls mount and cleanup", () => {
    const cleanupA = vi.fn()
    const mountA = vi.fn((el: HTMLElement) => {
      const span = document.createElement("span")
      span.textContent = "Widget A"
      el.appendChild(span)
      return cleanupA
    })

    const mountB = vi.fn((el: HTMLElement) => {
      const span = document.createElement("span")
      span.textContent = "Widget B"
      el.appendChild(span)
    })

    registerSlotContribution("plugin-1", "statusbar.left", {
      id: "widget-a",
      order: 1,
      mount: mountA,
    })

    registerSlotContribution("plugin-2", "statusbar.left", {
      id: "widget-b",
      order: 2,
      mount: mountB,
    })

    const { unmount } = render(
      <PluginSlot name="statusbar.left" className="test-slot-class" />
    )

    expect(mountA).toHaveBeenCalledTimes(1)
    expect(mountB).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Widget A")).toBeInTheDocument()
    expect(screen.getByText("Widget B")).toBeInTheDocument()

    unmount()
    expect(cleanupA).toHaveBeenCalledTimes(1)
  })

  it("catches crashing contribution with ErrorBoundary and keeps other contributions intact", () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {})

    registerSlotContribution("broken-plugin", "statusbar.right", {
      id: "crasher",
      order: 1,
      mount: () => {
        throw new Error("Crash during mount!")
      },
    })

    registerSlotContribution("healthy-plugin", "statusbar.right", {
      id: "healthy",
      order: 2,
      mount: (el) => {
        el.textContent = "Healthy Contribution"
      },
    })

    render(<PluginSlot name="statusbar.right" />)

    expect(screen.getByText("Healthy Contribution")).toBeInTheDocument()
    expect(consoleErrorSpy).toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })
})
