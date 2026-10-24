import { act, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DetailBox, DetailScroll } from "./detail-box"

// The real OverlayScrollbars: its setup is deferred into an idle callback and
// then an animation frame, queued here and flushed by the test; it measures
// only an element with a size, and jsdom lays nothing out.
const deferred = new Map<number, () => void>()
let nextHandle = 0
function flushDeferred() {
  for (let round = 0; round < 2; round++) {
    act(() => {
      for (const [handle, callback] of [...deferred]) {
        deferred.delete(handle)
        callback()
      }
    })
  }
}

beforeEach(() => {
  const queue = (callback: () => void) => {
    deferred.set(++nextHandle, callback)
    return nextHandle
  }
  const cancel = (handle: number) => deferred.delete(handle)
  vi.stubGlobal("requestIdleCallback", queue)
  vi.stubGlobal("cancelIdleCallback", cancel)
  vi.stubGlobal("requestAnimationFrame", queue)
  vi.stubGlobal("cancelAnimationFrame", cancel)
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200)
})

afterEach(() => {
  deferred.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The viewports under `root`, outermost first. */
const viewportsIn = (root: ParentNode) =>
  [
    ...root.querySelectorAll("[data-overlayscrollbars-viewport]"),
  ] as HTMLElement[]

/** A viewport `height` tall over `content` of content (jsdom keeps no scroll
 *  offsets of its own). */
function sized(viewport: HTMLElement, height: number, content: number) {
  Object.defineProperty(viewport, "clientHeight", { value: height })
  Object.defineProperty(viewport, "scrollHeight", { value: content })
  Object.defineProperty(viewport, "scrollTop", { value: 0, writable: true })
}

describe("DetailBox", () => {
  it("keeps a box anchored at its end on its last line until the reader scrolls up", () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, index) => <p key={index}>{index}</p>)
    const { container, rerender } = render(
      <DetailBox anchor="end">{lines(1)}</DetailBox>
    )
    flushDeferred()
    const [viewport] = viewportsIn(container)
    sized(viewport!, 100, 500)
    rerender(<DetailBox anchor="end">{lines(2)}</DetailBox>)
    expect(viewport!.scrollTop).toBe(500)

    // Scrolled up, it stays where the reader left it as more arrives.
    viewport!.scrollTop = 120
    fireEvent.scroll(viewport!)
    rerender(<DetailBox anchor="end">{lines(3)}</DetailBox>)
    expect(viewport!.scrollTop).toBe(120)
  })

  it("leaves a box anchored at its start where it opened", () => {
    const { container, rerender } = render(<DetailBox>one</DetailBox>)
    flushDeferred()
    const [viewport] = viewportsIn(container)
    sized(viewport!, 100, 500)
    rerender(<DetailBox>two</DetailBox>)
    expect(viewport!.scrollTop).toBe(0)
  })

  it("follows its end and re-marks its edges when it or its content changes size", () => {
    // Content can grow with no render of the box (an image, a font): the
    // box observes its viewport and what is in it.
    const observers: {
      notify: () => void
      targets: Element[]
      disconnected: boolean
    }[] = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        entry: (typeof observers)[number]
        constructor(notify: () => void) {
          this.entry = { notify, targets: [], disconnected: false }
          observers.push(this.entry)
        }
        observe(target: Element) {
          this.entry.targets.push(target)
        }
        unobserve() {}
        disconnect() {
          this.entry.disconnected = true
        }
      }
    )
    const { container, unmount } = render(
      <DetailBox anchor="end">
        <p>one</p>
      </DetailBox>
    )
    flushDeferred()
    const [viewport] = viewportsIn(container)
    const own = observers.find((observer) =>
      observer.targets.includes(viewport!)
    )!
    expect(own.targets).toEqual([viewport, viewport!.firstElementChild])

    sized(viewport!, 100, 500)
    own.notify()
    expect(viewport!.scrollTop).toBe(500)
    expect(viewport!.dataset.overflow).toBe("start")

    unmount()
    expect(own.disconnected).toBe(true)
  })

  it("marks which edge of its body has more beyond it, for the fade", () => {
    const { container } = render(<DetailBox>one</DetailBox>)
    flushDeferred()
    const [viewport] = viewportsIn(container)
    expect(viewport).toHaveClass("activity-detail-viewport")
    sized(viewport!, 100, 500)
    fireEvent.scroll(viewport!)
    expect(viewport!.dataset.overflow).toBe("end")
    viewport!.scrollTop = 200
    fireEvent.scroll(viewport!)
    expect(viewport!.dataset.overflow).toBe("both")
    viewport!.scrollTop = 400
    fireEvent.scroll(viewport!)
    expect(viewport!.dataset.overflow).toBe("start")
  })
})

describe("DetailScroll", () => {
  it("fades its own body and hands its viewport and scrolls on", () => {
    const onViewportRef = vi.fn()
    const onScroll = vi.fn()
    const { container } = render(
      <DetailBox unbounded>
        <DetailScroll onViewportRef={onViewportRef} onScroll={onScroll}>
          one
        </DetailScroll>
      </DetailBox>
    )
    flushDeferred()
    const [box, own] = viewportsIn(container)
    expect(own).toBeTruthy()
    expect(onViewportRef).toHaveBeenLastCalledWith(own)
    // Capped, and scrolling both ways: the box around it does neither.
    expect(own!.parentElement!.className.split(/\s+/)).toContain("max-h-72")
    expect(box!.parentElement!.className.split(/\s+/)).not.toContain("max-h-72")
    expect(own).toHaveClass("activity-detail-viewport")
    sized(own!, 100, 300)
    fireEvent.scroll(own!)
    expect(onScroll).toHaveBeenCalled()
    expect(own!.dataset.overflow).toBe("end")
  })

  it("keeps to an end anchor as the box's body does", () => {
    // The output under a script: on its last line until the reader scrolls
    // up, while the box around it does not scroll at all.
    const body = (count: number) => (
      <DetailBox unbounded>
        <DetailScroll anchor="end">
          {Array.from({ length: count }, (_, index) => (
            <p key={index}>{index}</p>
          ))}
        </DetailScroll>
      </DetailBox>
    )
    const { container, rerender } = render(body(1))
    flushDeferred()
    const [, own] = viewportsIn(container)
    sized(own!, 100, 500)
    rerender(body(2))
    expect(own!.scrollTop).toBe(500)

    own!.scrollTop = 120
    fireEvent.scroll(own!)
    rerender(body(3))
    expect(own!.scrollTop).toBe(120)
  })
})
