"use client"

/**
 * Per-agent defaults editor for delegation. Lives inside the
 * "Multi-Agent Collaboration" settings card under the "Agent defaults" tab.
 *
 * Isolation guarantees (critical — see the v2 plan):
 *   1. Options come from a LIVE probe (`describeAgentOptions`), not from the
 *      chat-side `selectorsCache`. What the user sees here is what codeg-mcp
 *      will actually receive when it spawns a subagent.
 *   2. Saving a value here does NOT call `acpSetConfigOption` or write to
 *      `selector-prefs-storage.ts` localStorage. The chat input's own
 *      selectors are untouched. Persistence happens through the parent's
 *      `setDelegationSettings` save action only.
 *   3. The 30s in-memory snapshot cache lives in module scope here; it does
 *      NOT bleed into the chat context.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  type AgentDelegationDefaults,
  type AgentOptionsSnapshot,
  type AgentType,
} from "@/lib/types"
import { getAgentLabel, isCustomAgentType } from "@/lib/custom-agents"
import { describeAgentOptions } from "@/lib/api"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { toErrorMessage } from "@/lib/app-error"
import { OverrideOptionsEditor } from "./agent-options-editor"

// Tab-switch debounce. Without this, rapid clicks across the agent
// buttons would each kick off a real probe (which on the backend now
// serializes per agent_type, but every queued probe still spawns the
// CLI). 250ms is below the threshold of feeling laggy while comfortably
// absorbing a mid-click reconsideration.
const TAB_SWITCH_DEBOUNCE_MS = 250

const BUILTIN_AGENT_TYPES: AgentType[] = [
  "claude_code",
  "codex",
  "open_code",
  "gemini",
  "open_claw",
  "cline",
  "hermes",
  "code_buddy",
  "kimi_code",
  "pi",
  "grok",
  "cursor",
  "deepseek",
  "qoder",
  "antigravity",
]

interface CachedSnapshot {
  snapshot: AgentOptionsSnapshot
  ts: number
}
const SNAPSHOT_TTL_MS = 30_000
// Keyed by (agent, model): an agent that derives one option's choices from
// another's value (opencode lists `effort` per model) answers differently per
// model, so a cached snapshot for one model must not serve another.
const snapshotCache = new Map<string, CachedSnapshot>()

function snapshotKey(agent: AgentType, model: string | null): string {
  return JSON.stringify([agent, model])
}

function readCache(
  agent: AgentType,
  model: string | null
): AgentOptionsSnapshot | null {
  const key = snapshotKey(agent, model)
  const entry = snapshotCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > SNAPSHOT_TTL_MS) {
    snapshotCache.delete(key)
    return null
  }
  return entry.snapshot
}

function writeCache(
  agent: AgentType,
  model: string | null,
  snapshot: AgentOptionsSnapshot
): void {
  snapshotCache.set(snapshotKey(agent, model), { snapshot, ts: Date.now() })
}

export interface DelegationAgentDefaultsPanelProps {
  value: Partial<Record<AgentType, AgentDelegationDefaults>>
  onChange: (next: Partial<Record<AgentType, AgentDelegationDefaults>>) => void
  disabled?: boolean
}

export function DelegationAgentDefaultsPanel({
  value,
  onChange,
  disabled,
}: DelegationAgentDefaultsPanelProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent")
  // Custom ACP agents are delegation targets too (codeg-mcp advertises them
  // in `delegate_to_agent`'s enum), so they get a defaults tab after the
  // built-ins. The list mirrors what the agent registry currently holds.
  const { agents } = useAcpAgents()
  const agentTypes = useMemo<AgentType[]>(
    () => [
      ...BUILTIN_AGENT_TYPES,
      ...agents.map((a) => a.agent_type).filter(isCustomAgentType),
    ],
    [agents]
  )
  const [selectedAgent, setSelectedAgent] = useState<AgentType>("claude_code")
  // Snapshot and what it was probed FOR (agent + model), in ONE state value:
  // the tab switch and the model change are debounced, so for that whole window
  // the selection is already the new one while the snapshot on screen is still
  // the previous one's. Its rows are then shown as loading rather than
  // offered — a value picked off them would land in the new selection — and
  // the agent's vocabulary keys on the producer, not the selection.
  const [loaded, setLoaded] = useState<{
    agent: AgentType
    model: string | null
    snapshot: AgentOptionsSnapshot
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reqIdRef = useRef(0)

  const loadSnapshot = useCallback(
    async (agent: AgentType, model: string | null, force: boolean) => {
      // Bump FIRST so a cache hit also invalidates a probe still in flight for
      // the previous (agent, model) — otherwise that probe's late answer would
      // replace the snapshot just shown for the current one.
      const reqId = ++reqIdRef.current
      if (!force) {
        const cached = readCache(agent, model)
        if (cached) {
          setLoaded({ agent, model, snapshot: cached })
          setError(null)
          setLoading(false)
          return
        }
      }
      setLoading(true)
      setError(null)
      setLoaded(null)
      try {
        const fresh = await describeAgentOptions(
          agent,
          null,
          model ? { model } : null
        )
        if (reqIdRef.current !== reqId) return
        writeCache(agent, model, fresh)
        setLoaded({ agent, model, snapshot: fresh })
      } catch (err: unknown) {
        if (reqIdRef.current !== reqId) return
        setError(toErrorMessage(err))
      } finally {
        if (reqIdRef.current === reqId) setLoading(false)
      }
    },
    []
  )

  // The model currently selected for this agent (its saved override). The
  // probe applies it so option lists an agent derives per model — opencode's
  // `effort` — answer for THAT model instead of the agent's own default.
  const probeModel = value[selectedAgent]?.config_values?.model ?? null

  useEffect(() => {
    // Debounce so rapid tab clicks / model changes (each would fire a real
    // probe — even with backend serialization, each one still spawns the
    // CLI) collapse into a single load. Cancelling on cleanup means the
    // *last* (agent, model) the user lands on wins, not the first.
    const handle = window.setTimeout(() => {
      void loadSnapshot(selectedAgent, probeModel, false)
    }, TAB_SWITCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [selectedAgent, probeModel, loadSnapshot])

  const updateAgentDefaults = useCallback(
    (agent: AgentType, next: AgentDelegationDefaults | null) => {
      const updated: Partial<Record<AgentType, AgentDelegationDefaults>> = {
        ...value,
      }
      if (
        next === null ||
        ((!next.mode_id || next.mode_id.length === 0) &&
          Object.keys(next.config_values).length === 0)
      ) {
        delete updated[agent]
      } else {
        updated[agent] = next
      }
      onChange(updated)
    },
    [value, onChange]
  )

  const current = value[selectedAgent] ?? null
  const currentModeId = current?.mode_id ?? null
  const currentConfigValues = current?.config_values ?? {}
  // The snapshot on screen answers the CURRENT selection — see `loaded`.
  const loadedIsCurrent =
    loaded !== null &&
    loaded.agent === selectedAgent &&
    loaded.model === probeModel
  // The probe asked for the selected model and the agent did not switch to
  // it, so the options shown are its OTHER model's. They stay editable — any
  // of them may be left on Default — but the user is told.
  const modelNotSwitched =
    loadedIsCurrent &&
    (loaded?.snapshot.unapplied_config_ids?.includes("model") ?? false)

  const setMode = (modeId: string | null) => {
    const next: AgentDelegationDefaults = {
      mode_id: modeId ?? undefined,
      config_values: { ...currentConfigValues },
    }
    updateAgentDefaults(selectedAgent, next)
  }

  const setConfigValue = (optionId: string, valueId: string | null) => {
    const nextConfig = { ...currentConfigValues }
    if (valueId === null) {
      delete nextConfig[optionId]
    } else {
      nextConfig[optionId] = valueId
    }
    const next: AgentDelegationDefaults = {
      mode_id: currentModeId ?? undefined,
      config_values: nextConfig,
    }
    updateAgentDefaults(selectedAgent, next)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground leading-5">
        {t("agentDefaultsDescription")}
      </p>

      <div
        role="tablist"
        aria-label={t("tabAgentDefaults")}
        className="flex flex-wrap gap-1 rounded-2xl bg-muted p-1"
      >
        {agentTypes.map((agent) => (
          <button
            key={agent}
            type="button"
            role="tab"
            aria-selected={selectedAgent === agent}
            disabled={disabled}
            onClick={() => setSelectedAgent(agent)}
            className={
              "rounded-xl px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 " +
              (selectedAgent === agent
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {getAgentLabel(agent)}
          </button>
        ))}
      </div>

      <div className="min-h-[7.5rem] rounded-lg border bg-card/50 p-3">
        {(loading || (!error && !loadedIsCurrent)) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {t("probing")}
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-destructive">
              {t("probeFailed", { detail: error })}
            </p>
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void loadSnapshot(selectedAgent, probeModel, true)
                }
              >
                {t("retry")}
              </Button>
            </div>
          </div>
        )}

        {!loading && !error && loadedIsCurrent && loaded && (
          <div className="space-y-4">
            {modelNotSwitched && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {t("modelNotSwitched")}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void loadSnapshot(selectedAgent, probeModel, true)
                  }
                >
                  {t("retry")}
                </Button>
              </div>
            )}
            <OverrideOptionsEditor
              agentType={loaded.agent}
              snapshot={loaded.snapshot}
              modeId={currentModeId}
              configValues={currentConfigValues}
              onModeChange={setMode}
              onConfigChange={setConfigValue}
              disabled={disabled}
            />
          </div>
        )}
      </div>
    </div>
  )
}
