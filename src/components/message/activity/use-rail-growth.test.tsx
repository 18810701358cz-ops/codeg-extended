import { act, render } from "@testing-library/react"
import { useRef } from "react"
import { describe, expect, it } from "vitest"

import { useRailGrowth } from "./use-rail-growth"

function List({
  rows,
  live,
  foot = false,
  end,
  body,
}: {
  rows: string[]
  live: boolean
  /** A last child the rows go in above, like a live reply's turning mark. */
  foot?: boolean
  /** A group's `data-end`: whether it is done. */
  end?: "pending" | "reached"
  /** The row with a body beside its line (an open panel). */
  body?: string
}) {
  const ref = useRef<HTMLUListElement>(null)
  useRailGrowth(ref, live)
  return (
    <ul ref={ref} data-end={end}>
      {rows.map((row) => (
        <li
          key={row}
          data-row={row}
          data-body={row === body ? "" : undefined}
        />
      ))}
      {foot ? <li key="foot" data-row="foot" /> : null}
    </ul>
  )
}

/** Each row's marks, after the observer has reported the commit. */
async function marks(container: HTMLElement) {
  await act(async () => {})
  return Object.fromEntries(
    [...container.querySelectorAll("li")].map((li) => [
      li.dataset.row,
      [
        li.hasAttribute("data-rail-enter") && "enter",
        li.hasAttribute("data-rail-extend") && "extend",
      ]
        .filter(Boolean)
        .join(" "),
    ])
  )
}

describe("useRailGrowth", () => {
  it("marks the rows that join a live list, and the row they follow", async () => {
    const view = render(<List rows={["a", "b"]} live />)
    view.rerender(<List rows={["a", "b", "c", "d"]} live />)

    expect(await marks(view.container)).toEqual({
      a: "",
      b: "extend",
      c: "enter extend",
      d: "enter",
    })
  })

  it("draws one join down through its rows in turn", async () => {
    // jsdom runs no CSS: each row stands in for the growth its marks start,
    // on itself, and for an animation of something inside it.
    const delays = new Map<string, number>()
    const proto = Element.prototype as { getAnimations?: unknown }
    proto.getAnimations = function (this: Element) {
      const row = (this as HTMLElement).dataset.row ?? "?"
      const effect = (target: Element) => ({
        target,
        getTiming: () => ({ delay: 0 }),
        updateTiming: ({ delay }: { delay: number }) => delays.set(row, delay),
      })
      return [
        { animationName: "activity-rail-grow", effect: effect(this) },
        { animationName: "activity-shimmer", effect: effect(this) },
        { animationName: "activity-rail-grow", effect: effect(document.body) },
      ]
    }
    try {
      const view = render(<List rows={["a"]} live />)
      view.rerender(<List rows={["a", "b", "c"]} live />)
      await marks(view.container)
    } finally {
      delete proto.getAnimations
    }

    expect(Object.fromEntries(delays)).toEqual({ b: 100, c: 200 })
  })

  it("draws a reveal of many rows at once as it stands", async () => {
    const many = Array.from({ length: 8 }, (_, i) => `r${i}`)
    const view = render(<List rows={["a"]} live />)
    view.rerender(<List rows={["a", ...many]} live />)

    expect(
      Object.values(await marks(view.container)).every((m) => m === "")
    ).toBe(true)
  })

  it("runs a done group's rail on from its end mark", async () => {
    const view = render(<List rows={["a", "b"]} live end="reached" />)
    view.rerender(<List rows={["a", "b", "c"]} live end="pending" />)
    await act(async () => {})

    const b = view.container.querySelector('[data-row="b"]')!
    expect(b.getAttribute("data-rail-extend")).toBe("reached")

    // Live all along, the group's last member ran to its own line.
    view.rerender(<List rows={["a", "b", "c", "d"]} live end="pending" />)
    await act(async () => {})
    const c = view.container.querySelector('[data-row="c"]')!
    expect(c.getAttribute("data-rail-extend")).toBe("")
  })

  it("notes a body beside the row a join extends, and keeps it while the body goes", async () => {
    const view = render(<List rows={["a", "b"]} live body="b" />)
    // A row joins as b's panel starts to close (a group sliding shut).
    view.rerender(<List rows={["a", "b", "c"]} live body="b" />)
    await act(async () => {})
    const b = view.container.querySelector('[data-row="b"]')!
    expect(b).toHaveAttribute("data-rail-extend", "")
    expect(b).toHaveAttribute("data-rail-body", "")

    // The panel gone, its segment keeps growing as it started.
    view.rerender(<List rows={["a", "b", "c"]} live />)
    await act(async () => {})
    expect(b).toHaveAttribute("data-rail-body", "")

    b.dispatchEvent(
      Object.assign(new Event("animationend", { bubbles: true }), {
        animationName: "activity-rail-extend",
      })
    )
    expect(b).not.toHaveAttribute("data-rail-extend")
    expect(b).not.toHaveAttribute("data-rail-body")
    // A row without a body gets no such note.
    view.rerender(<List rows={["a", "b", "c", "d"]} live />)
    await act(async () => {})
    const c = view.container.querySelector('[data-row="c"]')!
    expect(c).toHaveAttribute("data-rail-extend", "")
    expect(c).not.toHaveAttribute("data-rail-body")
  })

  it("leaves the row before alone when rows join above the foot", async () => {
    const view = render(<List rows={["a"]} live foot />)
    view.rerender(<List rows={["a", "b"]} live foot />)

    expect(await marks(view.container)).toEqual({
      a: "",
      b: "enter",
      foot: "",
    })
  })

  it("draws a list that mounts live as it stands", async () => {
    const view = render(<List rows={["a", "b", "c"]} live foot />)

    expect(await marks(view.container)).toEqual({
      a: "",
      b: "",
      c: "",
      foot: "",
    })
  })

  it("marks nothing in a settled list", async () => {
    const view = render(<List rows={["a"]} live={false} />)
    view.rerender(<List rows={["a", "b"]} live={false} />)

    expect(await marks(view.container)).toEqual({ a: "", b: "" })
  })

  it("lets a row that joined extend once its growth has run", async () => {
    const view = render(<List rows={["a"]} live />)
    view.rerender(<List rows={["a", "b"]} live />)
    expect(await marks(view.container)).toEqual({ a: "extend", b: "enter" })

    // Its growth done, the row that joined is the last one the next follows.
    const row = (name: string) =>
      view.container.querySelector(`[data-row="${name}"]`)!
    const grown = (name: string, animationName: string) =>
      row(name).dispatchEvent(
        Object.assign(new Event("animationend", { bubbles: true }), {
          animationName,
        })
      )
    grown("a", "activity-rail-grow")
    grown("b", "activity-rail-grow")
    view.rerender(<List rows={["a", "b", "c"]} live />)
    expect(await marks(view.container)).toEqual({
      a: "",
      b: "extend",
      c: "enter",
    })

    // An animation of the row's own content leaves its marks.
    grown("c", "activity-shimmer")
    expect(await marks(view.container)).toEqual({
      a: "",
      b: "extend",
      c: "enter",
    })
  })

  it("clears its marks when the list settles", async () => {
    const view = render(<List rows={["a"]} live />)
    view.rerender(<List rows={["a", "b"]} live />)
    expect(await marks(view.container)).toEqual({ a: "extend", b: "enter" })

    view.rerender(<List rows={["a", "b"]} live={false} />)
    expect(await marks(view.container)).toEqual({ a: "", b: "" })
  })
})
