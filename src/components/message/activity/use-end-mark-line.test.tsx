import { useRef } from "react"
import { render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { lastLineOffset, useEndMarkLine } from "./use-end-mark-line"

// jsdom lays nothing out: each test places the boxes and the lines of text
// it reads, by element and by text.
const boxes = new Map<Element, { top: number; bottom: number }>()
const lines = new Map<string, { top: number; bottom: number }[]>()

function place(el: Element | null, top: number, bottom: number) {
  if (!el) throw new Error("nothing to place")
  boxes.set(el, { top, bottom })
}

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const box = boxes.get(this) ?? { top: 0, bottom: 0 }
      return { ...box, height: box.bottom - box.top } as DOMRect
    }
  )
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: function (this: Range) {
      const rects = (
        lines.get(this.startContainer.textContent ?? "") ?? []
      ).map((line) => ({ ...line, height: line.bottom - line.top }))
      return Object.assign(rects, { item: (i: number) => rects[i] ?? null })
    },
  })
})

afterEach(() => {
  boxes.clear()
  lines.clear()
  vi.restoreAllMocks()
  delete (Range.prototype as { getClientRects?: unknown }).getClientRects
})

/** A row as the timeline draws one: the rail marker, the header line, then
 *  the body. */
function row(body: string): HTMLElement {
  const li = document.createElement("li")
  li.setAttribute("data-body", "")
  li.innerHTML = `<span>●</span><button class="group/row">Ran pnpm test</button>${body}`
  document.body.append(li)
  return li
}

describe("lastLineOffset", () => {
  it("measures from the row's bottom to the centre of its body's last line", () => {
    const li = row(
      `<div><div class="box" style="overflow-y:hidden"><pre>48 passed</pre><div><span>12 lines</span><span>copy output</span></div></div></div>`
    )
    place(li, 0, 200)
    // The panel clips to its rounded corners; its footer is inside it.
    place(li.querySelector(".box"), 30, 200)
    lines.set("48 passed", [{ top: 100, bottom: 120 }])
    lines.set("12 lines", [{ top: 180, bottom: 196 }])
    lines.set("copy output", [{ top: 180, bottom: 196 }])
    expect(lastLineOffset(li)).toBe(12)
  })

  it("takes the last line of wrapped text", () => {
    const li = row(
      `<div><p>A paragraph that wraps onto a second line</p></div>`
    )
    place(li, 0, 100)
    lines.set("A paragraph that wraps onto a second line", [
      { top: 50, bottom: 74 },
      { top: 74, bottom: 98 },
    ])
    expect(lastLineOffset(li)).toBe(14)
  })

  it("reads neither the rail marker nor the header line", () => {
    const li = row(`<div><img alt="" /></div>`)
    place(li, 0, 100)
    lines.set("●", [{ top: 4, bottom: 24 }])
    lines.set("Ran pnpm test", [{ top: 2, bottom: 26 }])
    expect(lastLineOffset(li)).toBeNull()
  })

  it("passes over text that is hidden or only there for screen readers", () => {
    const li = row(`<div><p>Last line</p><span>opens in a new tab</span></div>`)
    place(li, 0, 100)
    lines.set("Last line", [{ top: 70, bottom: 94 }])
    lines.set("opens in a new tab", [{ top: 99, bottom: 100 }])
    expect(lastLineOffset(li)).toBe(18)
  })

  it("counts a line a scroll box cuts off as the line at the box's edge", () => {
    // A panel with no footer, scrolled to the top: its last line is far below
    // the box, wherever it is scrolled to.
    const li = row(
      `<div><div class="viewport" style="overflow-y:auto"><pre>line 1</pre><pre>line 40</pre></div></div>`
    )
    place(li, 0, 312)
    place(li.querySelector(".viewport"), 30, 300)
    lines.set("line 1", [{ top: 40, bottom: 60 }])
    lines.set("line 40", [{ top: 820, bottom: 840 }])
    expect(lastLineOffset(li)).toBe(22)
  })

  it("takes the tightest of the boxes that clip it", () => {
    const li = row(
      `<div class="box" style="overflow-y:hidden"><div class="viewport" style="overflow-y:auto"><pre>line 40</pre></div></div>`
    )
    place(li, 0, 330)
    place(li.querySelector(".box"), 20, 320)
    place(li.querySelector(".viewport"), 30, 300)
    lines.set("line 40", [{ top: 820, bottom: 840 }])
    expect(lastLineOffset(li)).toBe(40)
  })

  it("measures nothing where nothing is laid out", () => {
    const li = row(`<div><p>Last line</p></div>`)
    lines.set("Last line", [{ top: 70, bottom: 94 }])
    delete (Range.prototype as { getClientRects?: unknown }).getClientRects
    expect(lastLineOffset(li)).toBeNull()
  })
})

describe("useEndMarkLine", () => {
  function List({
    reached,
    rows = ["First row", "Last row"],
  }: {
    reached: boolean
    rows?: string[]
  }) {
    const listRef = useRef<HTMLOListElement>(null)
    useEndMarkLine(listRef, reached)
    return (
      <ol ref={listRef}>
        {rows.map((text) => (
          <li key={text} data-body="">
            <span>●</span>
            <p>{text}</p>
          </li>
        ))}
      </ol>
    )
  }

  /** Tells the observer the list changed size, as a browser does after it
   *  lays the list out anew. */
  let resized: () => void = () => {}

  beforeEach(() => {
    // A ResizeObserver reports each element as it starts observing it, the
    // way a browser does at its first layout.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          resized = () =>
            this.callback(
              [{ target } as ResizeObserverEntry],
              this as unknown as ResizeObserver
            )
          resized()
        }
        unobserve() {}
        disconnect() {}
      }
    )
    lines.set("Last row", [{ top: 70, bottom: 94 }])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("sets the last row's line once the list is done, and takes it back after", () => {
    const { container, rerender } = render(<List reached={false} />)
    const last = container.querySelector("li:last-child") as HTMLElement
    expect(last.style.getPropertyValue("--activity-end-line")).toBe("")
    place(last, 0, 100)
    rerender(<List reached />)
    expect(last.style.getPropertyValue("--activity-end-line")).toBe("18px")
    const first = container.querySelector("li:first-child") as HTMLElement
    expect(first.style.getPropertyValue("--activity-end-line")).toBe("")
    rerender(<List reached={false} />)
    expect(last.style.getPropertyValue("--activity-end-line")).toBe("")
  })

  it("moves to a row that comes after, taking it off the one before", () => {
    const { container, rerender } = render(<List reached />)
    const before = container.querySelector("li:last-child") as HTMLElement
    place(before, 0, 100)
    resized()
    expect(before.style.getPropertyValue("--activity-end-line")).toBe("18px")
    rerender(<List reached rows={["First row", "Last row", "New row"]} />)
    const after = container.querySelector("li:last-child") as HTMLElement
    place(after, 100, 160)
    lines.set("New row", [{ top: 130, bottom: 154 }])
    resized()
    expect(before.style.getPropertyValue("--activity-end-line")).toBe("")
    expect(after.style.getPropertyValue("--activity-end-line")).toBe("18px")
  })
})
