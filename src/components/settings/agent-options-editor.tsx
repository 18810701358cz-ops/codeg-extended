"use client"

/**
 * The rows that edit an agent's probed options (`describeAgentOptions`), in the
 * two ways settings need them:
 *
 *   * `override` — the delegation "Agent defaults" tab. Every row may stay on
 *     "Default (X)", which stores nothing and leaves the agent's own value.
 *   * `required` — the assistant editor. Every row must be picked explicitly:
 *     no default item, nothing preselected, a placeholder until chosen.
 *
 * Both share the row model ({@link buildOptionRows}), the grouped model list
 * (`modelListGroups`), the agent's localised vocabulary and the row layout, so
 * the two surfaces cannot drift apart in what they offer.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useAgentVocabulary } from "@/hooks/use-agent-vocabulary"
import {
  deriveModelGroups,
  modelListGroups,
  type ModelOptionGroup,
} from "@/lib/model-config-groups"
import type {
  AgentOptionsSnapshot,
  AgentType,
  SessionConfigKindInfo,
  SessionConfigOptionInfo,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** Row id of the standalone mode row (never a real config option id). */
export const MODE_ROW_ID = "__codeg_mode__"

// The top "Default" item of an override row. Picking it clears the override.
// Must not collide with any real option id an agent could emit.
const DEFAULT_SENTINEL = "__codeg_default__"

type SelectOption = SessionConfigOptionInfo & {
  kind: Extract<SessionConfigKindInfo, { type: "select" }>
}
type BooleanOption = SessionConfigOptionInfo & {
  kind: Extract<SessionConfigKindInfo, { type: "boolean" }>
}

export type OptionRow =
  | {
      kind: "mode"
      id: typeof MODE_ROW_ID
      modes: Array<{ id: string; name: string; description?: string | null }>
      /** The agent's own current mode. */
      currentId: string
    }
  | {
      kind: "select"
      id: string
      option: SelectOption
      groups: ModelOptionGroup[]
      /** Advertised with no values at all: shown, but nothing can be picked
       *  (and nothing is required or stored for it). */
      empty: boolean
    }
  | {
      kind: "boolean"
      id: string
      option: BooleanOption
    }

type Vocabulary = ReturnType<typeof useAgentVocabulary>

/**
 * The rows a snapshot is edited through, in display order. The standalone mode
 * row only appears when the agent advertises modes and NO config options —
 * the chat composer's rule (`message-input.tsx`): agents that have both expose
 * the mode as one of the config options, and a second "Mode" row would
 * duplicate it.
 */
export function buildOptionRows(
  snapshot: AgentOptionsSnapshot,
  vocabulary: Vocabulary
): OptionRow[] {
  const modes = snapshot.modes?.available_modes ?? []
  const hasOptions = snapshot.config_options.length > 0
  const rows: OptionRow[] = []
  if (modes.length > 0 && !hasOptions && snapshot.modes) {
    rows.push({
      kind: "mode",
      id: MODE_ROW_ID,
      modes: vocabulary.modes(modes),
      currentId: snapshot.modes.current_mode_id,
    })
  }
  for (const raw of snapshot.config_options) {
    const option = vocabulary.configOption(raw)
    if (option.kind.type === "boolean") {
      rows.push({
        kind: "boolean",
        id: option.id,
        option: option as BooleanOption,
      })
      continue
    }
    const groups = modelListGroups(option)
    rows.push({
      kind: "select",
      id: option.id,
      option: option as SelectOption,
      groups,
      empty: groups.every((g) => g.options.length === 0),
    })
  }
  return rows
}

/** {@link buildOptionRows} for a component, localised for `agentType`. */
export function useOptionRows(
  agentType: AgentType,
  snapshot: AgentOptionsSnapshot
): OptionRow[] {
  const vocabulary = useAgentVocabulary(agentType)
  return useMemo(
    () => buildOptionRows(snapshot, vocabulary),
    [snapshot, vocabulary]
  )
}

/** The name a row's value is shown with: the rendered (group-stripped) name a
 *  select row's list shows, a mode's name, a switch's on/off label. `null`
 *  when the row offers no such value. */
export function optionValueLabel(
  row: OptionRow,
  value: string,
  booleanLabels: { on: string; off: string }
): string | null {
  switch (row.kind) {
    case "mode":
      return row.modes.find((m) => m.id === value)?.name ?? null
    case "boolean":
      if (value === "true") return booleanLabels.on
      if (value === "false") return booleanLabels.off
      return null
    case "select":
      for (const group of row.groups) {
        const hit = group.options.find((o) => o.value === value)
        if (hit) return hit.name
      }
      return null
  }
}

/** Whether `value` is one the row currently offers. */
export function rowOffers(row: OptionRow, value: string): boolean {
  switch (row.kind) {
    case "mode":
      return row.modes.some((m) => m.id === value)
    case "boolean":
      return value === "true" || value === "false"
    case "select":
      return row.groups.some((g) => g.options.some((o) => o.value === value))
  }
}

/** The display name of a row itself ("Model", "Mode", …). */
export function rowName(row: OptionRow, modeLabel: string): string {
  return row.kind === "mode" ? modeLabel : row.option.name
}

/**
 * The agent's own default as the override row's hint names it. It keeps the
 * option's unstripped name, which already carries the provider when the agent
 * writes names as `Provider/model`. A bare name that another option also uses
 * (two providers both listing `glm-5` under `provider/glm-5` ids) is qualified
 * with the provider header its row is grouped under. A value the agent does
 * not list reads as itself.
 *
 * The backend ships the flat `options` for grouped selects too, so this lookup
 * covers both shapes.
 */
function agentDefaultHintLabel(
  option: SessionConfigOptionInfo,
  value: string
): string {
  if (option.kind.type !== "select") return value
  const options = option.kind.options
  const own = options.find((o) => o.value === value)
  if (!own) return value
  const sharedName = options.some(
    (o) => o.value !== value && o.name === own.name
  )
  if (!sharedName) return own.name
  for (const group of deriveModelGroups(option) ?? []) {
    const row = group.options.find((o) => o.value === value)
    if (!row) continue
    // A stripped row's own name already starts with its header.
    return group.name !== null && row.name === own.name
      ? `${group.name}/${own.name}`
      : own.name
  }
  return own.name
}

/** The items of a select row's list, grouped as the composer groups models. */
function SelectRowItems({
  groups,
  recommended,
  recommendedLabel,
}: {
  groups: ModelOptionGroup[]
  recommended?: string | null
  recommendedLabel?: string
}) {
  return (
    <>
      {groups.map((group) =>
        group.name === null ? (
          group.options.map((item) => (
            <SelectItem
              key={`${group.key}-${item.value}`}
              value={item.value}
              badge={item.value === recommended ? recommendedLabel : null}
            >
              {item.name}
            </SelectItem>
          ))
        ) : (
          <SelectGroup key={group.key}>
            <SelectLabel>{group.name}</SelectLabel>
            {group.options.map((item) => (
              <SelectItem
                key={`${group.key}-${item.value}`}
                value={item.value}
                badge={item.value === recommended ? recommendedLabel : null}
              >
                {item.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )
      )}
    </>
  )
}

function RowShell({
  label,
  hint,
  badges,
  children,
}: {
  label: string
  hint?: string | null
  badges?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="text-sm font-medium">{label}</label>
          {badges}
        </div>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </div>
  )
}

export interface OverrideOptionsEditorProps {
  agentType: AgentType
  snapshot: AgentOptionsSnapshot
  modeId: string | null
  configValues: Record<string, string>
  onModeChange: (modeId: string | null) => void
  onConfigChange: (optionId: string, valueId: string | null) => void
  disabled?: boolean
}

/**
 * The `override` variant: each row offers "Default (X)" first — the agent's
 * own value, stored as nothing — then every value the agent lists. A switch is
 * the same tri-state: Default, On, Off (an explicit Off is stored as
 * `"false"`, a real override).
 *
 * With no override the trigger shows the Default item, so "inheriting" reads
 * apart from "picked the agent's current default explicitly" — the latter
 * sticks to that literal value even if the agent later changes its own.
 */
export function OverrideOptionsEditor({
  agentType,
  snapshot,
  modeId,
  configValues,
  onModeChange,
  onConfigChange,
  disabled,
}: OverrideOptionsEditorProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent")
  const rows = useOptionRows(agentType, snapshot)
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{t("noConfigAvailable")}</p>
    )
  }
  const booleanLabels = { on: t("booleanOn"), off: t("booleanOff") }
  return (
    <div className="space-y-4">
      {rows.map((row) => {
        if (row.kind === "mode") {
          const defaultName =
            row.modes.find((m) => m.id === row.currentId)?.name ?? row.currentId
          return (
            <RowShell
              key={row.id}
              label={t("modeLabel")}
              hint={t("agentDefaultHint", { value: defaultName })}
            >
              <Select
                value={modeId ?? DEFAULT_SENTINEL}
                onValueChange={(v) =>
                  onModeChange(v === DEFAULT_SENTINEL ? null : v)
                }
                disabled={disabled}
              >
                <SelectTrigger size="sm" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_SENTINEL}>
                    {t("defaultOptionLabel", { value: defaultName })}
                  </SelectItem>
                  {row.modes.map((mode) => (
                    <SelectItem key={mode.id} value={mode.id}>
                      {mode.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </RowShell>
          )
        }
        if (row.kind === "boolean") {
          const current = row.option.kind.current_value
          const defaultName = current ? booleanLabels.on : booleanLabels.off
          return (
            <RowShell
              key={row.id}
              label={row.option.name}
              hint={t("agentDefaultHint", { value: defaultName })}
            >
              <Select
                value={configValues[row.id] ?? DEFAULT_SENTINEL}
                onValueChange={(v) =>
                  onConfigChange(row.id, v === DEFAULT_SENTINEL ? null : v)
                }
                disabled={disabled}
              >
                <SelectTrigger size="sm" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_SENTINEL}>
                    {t("defaultOptionLabel", { value: defaultName })}
                  </SelectItem>
                  <SelectItem value="true">{booleanLabels.on}</SelectItem>
                  <SelectItem value="false">{booleanLabels.off}</SelectItem>
                </SelectContent>
              </Select>
            </RowShell>
          )
        }
        const agentDefault = row.option.kind.current_value
        // The hint names the agent's default with the provider in it — no
        // group header stands beside the hint to supply it. The Default item
        // and the trigger resolve against the RENDERED rows (`modelListGroups`
        // groups `provider/model` ids under their provider and strips the
        // prefix: two providers can offer the same model id), so a selected
        // model shows its prefix-stripped name exactly as the composer does.
        const defaultHint = agentDefaultHintLabel(row.option, agentDefault)
        const defaultRendered =
          row.groups
            .flatMap((group) => group.options)
            .find((o) => o.value === agentDefault)?.name ?? defaultHint
        return (
          <RowShell
            key={row.id}
            label={row.option.name}
            hint={t("agentDefaultHint", { value: defaultHint })}
          >
            <Select
              value={configValues[row.id] ?? DEFAULT_SENTINEL}
              onValueChange={(v) =>
                onConfigChange(row.id, v === DEFAULT_SENTINEL ? null : v)
              }
              disabled={disabled}
            >
              <SelectTrigger size="sm" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_SENTINEL}>
                  {t("defaultOptionLabel", { value: defaultRendered })}
                </SelectItem>
                <SelectRowItems groups={row.groups} />
              </SelectContent>
            </Select>
          </RowShell>
        )
      })}
    </div>
  )
}

/** How a required row's saved value relates to what the agent offers now. */
export type RequiredRowMark =
  /** Saved before, no longer offered: shown as "unavailable (was X)". */
  | { kind: "unavailable"; savedLabel: string }
  /** Appeared since the selection was saved. */
  | { kind: "new" }

export interface RequiredOptionRowProps {
  row: OptionRow
  /** The picked value, or `null` for none yet. */
  value: string | null
  onChange: (value: string) => void
  disabled?: boolean
  /** Flagged by a save attempt with this row still unpicked. */
  invalid?: boolean
  mark?: RequiredRowMark | null
  /** Focus target for "jump to the first missing row". */
  triggerRef?: (el: HTMLButtonElement | null) => void
}

/**
 * One row of the `required` variant: no default item and nothing preselected
 * (neither the agent's current value nor its recommendation — the agent's
 * recommended value only gets a "Recommended" chip). Until a value is picked
 * the trigger shows a placeholder and the row carries a "Required" mark.
 */
export function RequiredOptionRow({
  row,
  value,
  onChange,
  disabled,
  invalid,
  mark,
  triggerRef,
}: RequiredOptionRowProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent")
  const ta = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const booleanLabels = { on: t("booleanOn"), off: t("booleanOff") }
  const label = rowName(row, t("modeLabel"))
  const description =
    row.kind === "mode"
      ? row.modes.find((m) => m.id === value)?.description
      : row.option.description
  const unpicked = value === null
  const empty = row.kind === "select" && row.empty

  const badges = (
    <>
      {mark?.kind === "new" ? (
        <Badge variant="secondary" className="text-[0.625rem]">
          {ta("optionNew")}
        </Badge>
      ) : null}
      {mark?.kind === "unavailable" ? (
        <Badge
          variant="outline"
          className="border-amber-500/40 text-[0.625rem] text-amber-700 dark:text-amber-400"
        >
          {ta("optionUnavailable", { value: mark.savedLabel })}
        </Badge>
      ) : null}
      {unpicked && !empty && !mark ? (
        <span
          className={cn(
            "text-[0.625rem]",
            invalid ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {ta("required")}
        </span>
      ) : null}
    </>
  )

  return (
    <RowShell label={label} hint={description} badges={badges}>
      <Select
        value={value ?? ""}
        onValueChange={onChange}
        disabled={disabled || empty}
      >
        <SelectTrigger
          ref={triggerRef}
          size="sm"
          className={row.kind === "select" ? "w-56" : "w-44"}
          aria-label={label}
          aria-invalid={invalid ? true : undefined}
        >
          <SelectValue
            placeholder={
              empty ? ta("noValuesOffered") : ta("selectPlaceholder")
            }
          />
        </SelectTrigger>
        <SelectContent>
          {row.kind === "mode"
            ? row.modes.map((mode) => (
                <SelectItem
                  key={mode.id}
                  value={mode.id}
                  description={mode.description}
                >
                  {mode.name}
                </SelectItem>
              ))
            : null}
          {row.kind === "boolean" ? (
            <>
              <SelectItem value="true">{booleanLabels.on}</SelectItem>
              <SelectItem value="false">{booleanLabels.off}</SelectItem>
            </>
          ) : null}
          {row.kind === "select" ? (
            <SelectRowItems
              groups={row.groups}
              recommended={row.option.recommended_value}
              recommendedLabel={ta("recommended")}
            />
          ) : null}
        </SelectContent>
      </Select>
    </RowShell>
  )
}
