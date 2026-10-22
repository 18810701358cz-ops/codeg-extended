import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { PlanEntriesList } from "./plan-card"
import enMessages from "@/i18n/messages/en.json"
import type { PlanEntryInfo } from "@/lib/types"

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const sampleEntries: PlanEntryInfo[] = [
  { content: "First step", priority: "high", status: "completed" },
  { content: "Second step", priority: "medium", status: "in_progress" },
  { content: "Third step", priority: "low", status: "pending" },
]

describe("PlanEntriesList", () => {
  it("renders nothing when there are no entries", () => {
    const { container } = renderWithIntl(<PlanEntriesList entries={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("strikes through completed entries only", () => {
    renderWithIntl(<PlanEntriesList entries={sampleEntries} />)
    expect(screen.getByText("First step").className).toContain("line-through")
    expect(screen.getByText("Second step").className).not.toContain(
      "line-through"
    )
  })

  it("renders each entry's content and priority label", () => {
    renderWithIntl(<PlanEntriesList entries={sampleEntries} />)
    expect(screen.getByText("First step")).toBeInTheDocument()
    expect(screen.getByText("High")).toBeInTheDocument()
    expect(screen.getByText("Medium")).toBeInTheDocument()
    expect(screen.getByText("Low")).toBeInTheDocument()
  })
})
