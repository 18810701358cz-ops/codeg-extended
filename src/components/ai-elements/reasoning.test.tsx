import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("streamdown", () => ({
  Streamdown: ({
    children,
    mode,
    parseIncompleteMarkdown,
  }: {
    children: ReactNode
    mode?: string
    parseIncompleteMarkdown?: boolean
  }) => (
    <div
      data-testid="streamdown-root"
      data-mode={mode}
      data-parse-incomplete={String(parseIncompleteMarkdown)}
    >
      {children}
    </div>
  ),
  defaultRemarkPlugins: {},
  defaultRehypePlugins: {},
}))

vi.mock("@streamdown/cjk", () => ({ cjk: {} }))
vi.mock("@streamdown/math", () => ({ createMathPlugin: () => ({}) }))
vi.mock("@streamdown/mermaid", () => ({ mermaid: {} }))
vi.mock("@streamdown/code", () => ({
  code: { highlight: vi.fn(), supportsLanguage: vi.fn(() => true) },
}))

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import { ReasoningMarkdown } from "./reasoning"

function tree(isStreaming: boolean) {
  return (
    <ReasoningMarkdown isStreaming={isStreaming}>
      {"see `tools/dsv4-c1/*` please."}
    </ReasoningMarkdown>
  )
}

describe("ReasoningMarkdown", () => {
  // A reader who opens a thought mid-turn keeps it mounted across every delta,
  // so its body is still on the streaming hot path: pinning it static would
  // re-parse the whole block on every delta instead of only its tail.
  it("keeps the live block in streaming mode", () => {
    render(tree(true))

    const root = screen.getByTestId("streamdown-root")
    expect(root).toHaveAttribute("data-mode", "streaming")
    expect(root).toHaveAttribute("data-parse-incomplete", "true")
  })

  it("drops to static once thinking has settled, so remend cannot append leftover * / _", () => {
    render(tree(false))

    const root = screen.getByTestId("streamdown-root")
    expect(root).toHaveAttribute("data-mode", "static")
    expect(root).toHaveAttribute("data-parse-incomplete", "false")
  })

  // The transition is the case that matters: the text does not change on the
  // last delta, only whether it is still streaming.
  it("repaints when thinking ends even though its text did not change", () => {
    const { rerender } = render(tree(true))
    expect(screen.getByTestId("streamdown-root")).toHaveAttribute(
      "data-mode",
      "streaming"
    )

    rerender(tree(false))

    const root = screen.getByTestId("streamdown-root")
    expect(root).toHaveAttribute("data-mode", "static")
    expect(root).toHaveAttribute("data-parse-incomplete", "false")
  })
})
