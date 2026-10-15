import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  AgentDelegationDefaults,
  AgentOptionsSnapshot,
  AgentType,
  SessionConfigSelectGroupInfo,
  SessionConfigSelectOptionInfo,
} from "@/lib/types"

const describeAgentOptions = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api", () => ({ describeAgentOptions }))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: [], fresh: true, refresh: () => {} }),
}))

import { DelegationAgentDefaultsPanel } from "./delegation-agent-defaults"
import enMessages from "@/i18n/messages/en.json"

type Defaults = Partial<Record<AgentType, AgentDelegationDefaults>>

/** A probe answer whose effort default is named after `tag`, so the
 *  "Agent default: …" hint on screen says which answer is showing. */
function answer(tag: string): AgentOptionsSnapshot {
  return {
    modes: null,
    config_options: [
      {
        id: "effort",
        name: "Effort",
        description: null,
        category: "thought_level",
        kind: {
          type: "select",
          current_value: `${tag}-effort`,
          options: [
            {
              value: `${tag}-effort`,
              name: `${tag} effort`,
              description: null,
            },
          ],
          groups: [],
        },
      },
    ],
    available_commands: [],
  }
}

function panel(value: Defaults, onChange: (next: Defaults) => void = () => {}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DelegationAgentDefaultsPanel value={value} onChange={onChange} />
    </NextIntlClientProvider>
  )
}

const choice = (value: string, name: string) => ({
  value,
  name,
  description: null,
})

/** A probe answer holding one select option. */
function selectAnswer(
  id: string,
  category: string,
  currentValue: string,
  options: SessionConfigSelectOptionInfo[],
  groups: SessionConfigSelectGroupInfo[] = []
): AgentOptionsSnapshot {
  return {
    modes: null,
    config_options: [
      {
        id,
        name: id,
        description: null,
        category,
        kind: { type: "select", current_value: currentValue, options, groups },
      },
    ],
    available_commands: [],
  }
}

/** Past the panel's 250ms debounce, settling the probe's promise chain. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
}

// The panel's snapshot cache lives in module scope for 30s, so every test
// probes ids no other test uses.
const unique = () => Math.random().toString(36).slice(2)

describe("DelegationAgentDefaultsPanel probes", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    describeAgentOptions.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** opencode lists `effort` per model: the options shown beside a saved model
   *  have to be that model's, so changing it re-probes with it applied. */
  it("probes with the saved model and re-probes when it changes", async () => {
    describeAgentOptions.mockImplementation(
      (_agent: AgentType, _dir: string | null, cfg: { model: string } | null) =>
        Promise.resolve(answer(cfg?.model ?? "no-model"))
    )
    const first = `model-a-${unique()}`
    const second = `model-b-${unique()}`
    const saved = (model: string): Defaults => ({
      claude_code: { config_values: { model } },
    })

    const { rerender } = render(panel(saved(first)))
    await settle()
    expect(describeAgentOptions).toHaveBeenLastCalledWith("claude_code", null, {
      model: first,
    })
    expect(
      screen.getByText(`Agent default: ${first} effort`)
    ).toBeInTheDocument()

    rerender(panel(saved(second)))
    await settle()
    expect(describeAgentOptions).toHaveBeenCalledTimes(2)
    expect(describeAgentOptions).toHaveBeenLastCalledWith("claude_code", null, {
      model: second,
    })
    expect(
      screen.getByText(`Agent default: ${second} effort`)
    ).toBeInTheDocument()

    // Back to a model probed moments ago: served from the cache, no new probe.
    rerender(panel(saved(first)))
    await settle()
    expect(describeAgentOptions).toHaveBeenCalledTimes(2)
    expect(
      screen.getByText(`Agent default: ${first} effort`)
    ).toBeInTheDocument()
  })

  /** A tab served from the cache must not be overwritten by the answer of a
   *  probe the user already left — that answer is another agent's options. */
  it("drops a probe answer that lands after a cache hit replaced it", async () => {
    const claudeModel = `claude-${unique()}`
    let answerCodex: (snapshot: AgentOptionsSnapshot) => void = () => {}
    describeAgentOptions.mockImplementation((agent: AgentType) =>
      agent === "codex"
        ? new Promise<AgentOptionsSnapshot>((resolve) => {
            answerCodex = resolve
          })
        : Promise.resolve(answer(claudeModel))
    )

    render(panel({ claude_code: { config_values: { model: claudeModel } } }))
    await settle()
    expect(
      screen.getByText(`Agent default: ${claudeModel} effort`)
    ).toBeInTheDocument()

    // Codex's probe is still running when the user goes back to Claude Code,
    // whose snapshot is cached.
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }))
    await settle()
    expect(describeAgentOptions).toHaveBeenLastCalledWith("codex", null, null)
    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }))
    await settle()
    expect(
      screen.getByText(`Agent default: ${claudeModel} effort`)
    ).toBeInTheDocument()

    await act(async () => {
      answerCodex(answer("codex"))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(
      screen.getByText(`Agent default: ${claudeModel} effort`)
    ).toBeInTheDocument()
    expect(screen.queryByText("Agent default: codex effort")).toBeNull()
  })

  /** Values carrying a `provider/` prefix must read like the composer's
   *  picker: the provider becomes the group header and the rows keep the bare
   *  model name — two providers offering the SAME model id are otherwise
   *  indistinguishable in a flat list. */
  it("groups a prefixed model option by provider and strips the prefix", async () => {
    // Real timers: this test opens the Radix Select with userEvent.
    vi.useRealTimers()
    const tag = unique()
    const chanA = `Channel A ${tag}`
    const chanB = `Channel B ${tag}`
    describeAgentOptions.mockResolvedValue({
      modes: null,
      config_options: [
        {
          id: "model",
          name: "Model",
          description: null,
          category: "model",
          kind: {
            type: "select",
            current_value: `${chanA}/glm-5`,
            options: [
              {
                value: `${chanA}/glm-5`,
                name: `${chanA}/glm-5`,
                description: null,
              },
              {
                value: `${chanA}/glm-6`,
                name: `${chanA}/glm-6`,
                description: null,
              },
              {
                value: `${chanB}/glm-5`,
                name: `${chanB}/glm-5`,
                description: null,
              },
            ],
            groups: [],
          },
        },
      ],
      available_commands: [],
    } satisfies AgentOptionsSnapshot)

    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      panel(
        { claude_code: { config_values: { model: `${chanA}/glm-5` } } },
        onChange
      )
    )

    // The hint keeps the full channel-qualified default (the header can't
    // carry the channel there)…
    await screen.findByText(`Agent default: ${chanA}/glm-5`)
    // …the trigger shows the selected row as the list does…
    expect(screen.getByRole("combobox")).toHaveTextContent(/^glm-5$/)

    // …and the picker groups by channel and strips the prefix from rows.
    await user.click(screen.getByRole("combobox"))
    const list = await screen.findByRole("listbox")
    expect(within(list).getByText(chanA)).toBeInTheDocument()
    expect(within(list).getByText(chanB)).toBeInTheDocument()
    expect(within(list).getAllByText("glm-5")).toHaveLength(2)
    expect(within(list).getByText("glm-6")).toBeInTheDocument()
    expect(within(list).queryByText(`${chanA}/glm-5`)).toBeNull()

    // Picking Channel B's row saves its full id, not the stripped label.
    await user.click(
      within(within(list).getByRole("group", { name: chanB })).getByRole(
        "option",
        { name: "glm-5" }
      )
    )
    expect(onChange).toHaveBeenLastCalledWith({
      claude_code: { config_values: { model: `${chanB}/glm-5` } },
    })
  })

  /** Two providers can both name a row just `glm-5` under `provider/glm-5`
   *  ids. The headers tell the rows apart in the list, but the hint has no
   *  header beside it, so it has to name the provider itself. */
  it("names the provider in the hint when the default's own name is shared", async () => {
    const tag = unique()
    const chanA = `chan-a-${tag}`
    const chanB = `chan-b-${tag}`
    const rows = [
      choice(`${chanA}/glm-5`, "glm-5"),
      choice(`${chanA}/glm-6`, "glm-6"),
      choice(`${chanB}/glm-5`, "glm-5"),
    ]
    // The probe applies the saved model, so it answers with that as current.
    describeAgentOptions.mockImplementation(
      (_agent: AgentType, _dir: string | null, cfg: { model: string } | null) =>
        Promise.resolve(selectAnswer("model", "model", cfg!.model, rows))
    )
    const saved = (model: string): Defaults => ({
      claude_code: { config_values: { model } },
    })

    const { rerender } = render(panel(saved(`${chanB}/glm-5`)))
    await settle()
    expect(
      screen.getByText(`Agent default: ${chanB}/glm-5`)
    ).toBeInTheDocument()

    // A name no other row uses needs no provider.
    rerender(panel(saved(`${chanA}/glm-6`)))
    await settle()
    expect(screen.getByText("Agent default: glm-6")).toBeInTheDocument()
  })

  /** The grouping is the model picker's: any other option keeps a flat list
   *  even when its values contain a slash, and server-provided groups still
   *  render under their own headers. */
  it("leaves non-model and server-grouped options as the agent sent them", async () => {
    vi.useRealTimers()
    const tag = unique()
    const user = userEvent.setup()
    // Distinct saved models keep each probe out of the module-level cache.
    const saved = (model: string): Defaults => ({
      claude_code: { config_values: { model } },
    })

    describeAgentOptions.mockResolvedValueOnce(
      selectAnswer("effort", "thought_level", `low/${tag}`, [
        choice(`low/${tag}`, `low/${tag}`),
        choice(`high/${tag}`, `high/${tag}`),
      ])
    )
    const { unmount } = render(panel(saved(`effort-probe-${tag}`)))
    await screen.findByText(`Agent default: low/${tag}`)
    await user.click(screen.getByRole("combobox"))
    let list = await screen.findByRole("listbox")
    expect(within(list).queryAllByRole("group")).toHaveLength(0)
    expect(within(list).getByText(`high/${tag}`)).toBeInTheDocument()
    unmount()

    const featured = [choice(`fast-${tag}`, "Fast")]
    const others = [choice(`a/slow-${tag}`, "a/Slow")]
    describeAgentOptions.mockResolvedValueOnce(
      selectAnswer(
        "model",
        "model",
        `fast-${tag}`,
        [...featured, ...others],
        [
          { group: "featured", name: `Featured ${tag}`, options: featured },
          { group: "others", name: `Others ${tag}`, options: others },
        ]
      )
    )
    render(panel(saved(`fast-${tag}`)))
    await screen.findByText("Agent default: Fast")
    await user.click(screen.getByRole("combobox"))
    list = await screen.findByRole("listbox")
    expect(
      within(
        within(list).getByRole("group", { name: `Others ${tag}` })
      ).getByRole("option", { name: "a/Slow" })
    ).toBeInTheDocument()
    expect(
      within(list).getByRole("group", { name: `Featured ${tag}` })
    ).toBeInTheDocument()
  })
})
