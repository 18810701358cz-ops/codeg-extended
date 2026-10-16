"use client"

/**
 * Create or edit an assistant: avatar and name, description, the agent and
 * EVERY option it advertises (each one required, nothing preselected), the
 * standing instructions, and whether it is enabled.
 *
 * The options come from a live probe of the agent (`useAgentOptions`). Agents
 * that list one option's values per model (opencode's `effort`) make the order
 * matter: the model is picked first, the agent is re-probed FOR it, and only
 * when that snapshot has landed — and the probe confirms the agent really
 * switched (`unapplied_config_ids` without `model`) — are the other rows
 * offered. Picking them off any other snapshot would save values that do not
 * hold for the saved model.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, Loader2 } from "lucide-react"

import { useAgentOptions } from "@/components/automations/use-agent-options"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { useAgentVocabulary } from "@/hooks/use-agent-vocabulary"
import { defaultAvatarFor } from "@/lib/assistant-avatar"
import {
  extractAppCommandError,
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import { getAgentLabel } from "@/lib/custom-agents"
import { isModelConfigOption } from "@/lib/model-config-groups"
import type {
  AgentOptionsSnapshot,
  AgentType,
  AssistantAgentConfig,
  AssistantAvatar,
  AssistantInfo,
} from "@/lib/types"
import { useAssistantsStore } from "@/stores/assistants-store"
import {
  buildOptionRows,
  RequiredOptionRow,
  type OptionRow,
} from "./agent-options-editor"
import {
  buildAgentConfig,
  effectivePick,
  missingRows,
  rowMark,
  sameAgentSelection,
  selectionFromOptions,
  EMPTY_SELECTION,
  type AssistantSelection,
} from "./assistant-agent-config"
import { AssistantAvatarPicker } from "./assistant-avatar-picker"

/** Field limits, mirrored from the backend (`assistant_service`). */
export const NAME_MAX = 40
export const DESCRIPTION_MAX = 200
export const INSTRUCTIONS_MAX = 20_000

const charCount = (text: string) => Array.from(text).length

/** Whether a row is the model selector (the row everything else hangs off). */
function isModelRow(row: OptionRow): boolean {
  return row.kind === "select" && isModelConfigOption(row.option)
}

/**
 * Where the options part of the editor stands. Everything but `ready` means
 * the selection cannot be completed (and so not saved) yet.
 */
type OptionsGate =
  | { kind: "no-agent" }
  /** The saved agent is disabled or not installed: show the saved names. */
  | { kind: "unavailable-agent" }
  | { kind: "loading"; modelRow: OptionRow | null }
  | { kind: "error"; message: string; modelRow: OptionRow | null }
  /** The agent has a model selector and no model the agent offers is picked. */
  | { kind: "pick-model"; modelRow: OptionRow }
  /** A model is picked; waiting for the snapshot probed for it. */
  | { kind: "confirming"; modelRow: OptionRow }
  /** The probe for the picked model came back holding another model. */
  | { kind: "not-switched"; modelRow: OptionRow }
  | { kind: "ready"; rows: OptionRow[] }

export interface AssistantEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `null` creates a new assistant. */
  assistant: AssistantInfo | null
  /** Called with the saved row. */
  onSaved?: (assistant: AssistantInfo) => void
}

export function AssistantEditorDialog({
  open,
  onOpenChange,
  assistant,
  onSaved,
}: AssistantEditorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[40rem]">
        {open ? (
          <AssistantEditorBody
            assistant={assistant}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function AssistantEditorBody({
  assistant,
  onClose,
  onSaved,
}: {
  assistant: AssistantInfo | null
  onClose: () => void
  onSaved?: (assistant: AssistantInfo) => void
}) {
  const t = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  const { agents } = useAcpAgents()
  const create = useAssistantsStore((s) => s.create)
  const update = useAssistantsStore((s) => s.update)
  const editing = assistant !== null

  const [name, setName] = useState(assistant?.name ?? "")
  const [description, setDescription] = useState(assistant?.description ?? "")
  const [avatar, setAvatar] = useState<AssistantAvatar>(
    assistant?.avatar ?? defaultAvatarFor("")
  )
  // A new assistant's monogram follows its name until the user picks one.
  const [avatarTouched, setAvatarTouched] = useState(editing)
  const [instructions, setInstructions] = useState(
    assistant?.instructions ?? ""
  )
  const [enabled, setEnabled] = useState(assistant?.enabled ?? true)
  const [agentType, setAgentType] = useState<AgentType | null>(
    assistant?.agent_type ?? null
  )
  const [selection, setSelection] = useState<AssistantSelection>(
    assistant ? selectionFromOptions(assistant.agent_options) : EMPTY_SELECTION
  )
  /** The user changed the agent or any option. */
  const [agentTouched, setAgentTouched] = useState(false)
  /** Display names of the picks made in this editor, by row id — what an
   *  "unavailable (was X)" mark names after a model switch withdrew one. */
  const [pickedLabels, setPickedLabels] = useState<Record<string, string>>({})
  const [invalidIds, setInvalidIds] = useState<ReadonlySet<string>>(new Set())
  const [nameError, setNameError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const submittingRef = useRef(false)
  const triggerRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const nameRef = useRef<HTMLInputElement | null>(null)
  // A refused save that points at the name focuses it once the form is
  // enabled again — a disabled input cannot take focus.
  const focusNameAfterSaveRef = useRef(false)
  useEffect(() => {
    if (saving || !focusNameAfterSaveRef.current) return
    focusNameAfterSaveRef.current = false
    nameRef.current?.focus()
  }, [saving])

  const agentInfo = agents.find((a) => a.agent_type === agentType) ?? null
  // The saved agent can no longer run here: keep it, show what was saved.
  const agentUnavailable =
    editing &&
    !agentTouched &&
    agentType === assistant.agent_type &&
    agents.length > 0 &&
    !(agentInfo?.enabled && agentInfo.available)

  const pickedModel = selection.configValues.model ?? null
  const probeConfig = useMemo(
    () => (pickedModel ? { model: pickedModel } : null),
    [pickedModel]
  )
  const probe = useAgentOptions(
    agentType ?? "claude_code",
    null,
    agentType !== null && !agentUnavailable,
    probeConfig
  )
  const vocabulary = useAgentVocabulary(agentType)

  // The latest model row seen for this agent. Which models an agent offers
  // does not depend on the model picked, so while the agent is re-probed for a
  // newly picked model the row stays usable — `useAgentOptions` clears its
  // snapshot at the start of every probe, hence the copy.
  const [modelRowCache, setModelRowCache] = useState<{
    agent: AgentType
    row: OptionRow
  } | null>(null)
  const agentSnapshot: AgentOptionsSnapshot | null =
    probe.snapshot && probe.snapshotAgentType === agentType
      ? probe.snapshot
      : null
  const agentSnapshotRows = useMemo(
    () => (agentSnapshot ? buildOptionRows(agentSnapshot, vocabulary) : null),
    [agentSnapshot, vocabulary]
  )
  const freshModelRow = agentSnapshotRows?.find(isModelRow) ?? null
  useEffect(() => {
    if (freshModelRow && agentType) {
      setModelRowCache({ agent: agentType, row: freshModelRow })
    }
  }, [freshModelRow, agentType])
  const modelRow =
    freshModelRow ??
    (modelRowCache && modelRowCache.agent === agentType
      ? modelRowCache.row
      : null)

  // Rows of the snapshot probed for EXACTLY the current (agent, model).
  const currentRows = probe.current ? agentSnapshotRows : null
  const currentSnapshot = probe.current ? agentSnapshot : null

  // A snapshot without `unapplied_config_ids` can only come from a backend
  // that predates the field — say one left in the 30s cache across a server
  // upgrade — so it confirms nothing. Probe again once, bypassing the cache;
  // the latch is keyed by (agent, model) and outlives the snapshot being
  // cleared by that very probe, so this never loops.
  const [reprobed, setReprobed] = useState<ReadonlySet<string>>(new Set())
  const confirmKey =
    agentType && pickedModel ? JSON.stringify([agentType, pickedModel]) : null
  const pickedModelOffered =
    modelRow !== null && effectivePick(modelRow, selection) !== null

  const gate: OptionsGate = useMemo(() => {
    if (agentType === null) return { kind: "no-agent" }
    if (agentUnavailable) return { kind: "unavailable-agent" }
    if (probe.error && !probe.loading) {
      return { kind: "error", message: probe.error, modelRow }
    }
    if (currentRows && currentSnapshot) {
      const currentModelRow = currentRows.find(isModelRow)
      if (
        !currentModelRow ||
        (currentModelRow.kind === "select" && currentModelRow.empty)
      ) {
        return { kind: "ready", rows: currentRows }
      }
      if (effectivePick(currentModelRow, selection) === null) {
        return { kind: "pick-model", modelRow: currentModelRow }
      }
      const unapplied = currentSnapshot.unapplied_config_ids
      if (unapplied === undefined) {
        return confirmKey && reprobed.has(confirmKey)
          ? { kind: "not-switched", modelRow: currentModelRow }
          : { kind: "confirming", modelRow: currentModelRow }
      }
      if (unapplied.includes("model")) {
        return { kind: "not-switched", modelRow: currentModelRow }
      }
      return { kind: "ready", rows: currentRows }
    }
    if (!modelRow) return { kind: "loading", modelRow: null }
    if (!pickedModelOffered) return { kind: "pick-model", modelRow }
    return { kind: "confirming", modelRow }
  }, [
    agentType,
    agentUnavailable,
    probe.error,
    probe.loading,
    currentRows,
    currentSnapshot,
    modelRow,
    pickedModelOffered,
    selection,
    confirmKey,
    reprobed,
  ])

  // The forced re-probe for an unconfirmed snapshot (see `reprobed`).
  const needsReprobe =
    currentSnapshot !== null &&
    currentSnapshot.unapplied_config_ids === undefined &&
    pickedModelOffered &&
    confirmKey !== null &&
    !reprobed.has(confirmKey)
  const { reload } = probe
  useEffect(() => {
    if (!needsReprobe || !confirmKey) return
    setReprobed((prev) => new Set(prev).add(confirmKey))
    reload()
  }, [needsReprobe, confirmKey, reload])

  const saved = useMemo(
    () =>
      assistant && agentType === assistant.agent_type
        ? {
            selection: selectionFromOptions(assistant.agent_options),
            labels: assistant.label_snapshot,
          }
        : null,
    [assistant, agentType]
  )
  const booleanLabels = { on: tm("booleanOn"), off: tm("booleanOff") }

  const readyRows = gate.kind === "ready" ? gate.rows : null
  const missing = readyRows ? missingRows(readyRows, selection) : []
  // Rows that need a pick because the agent's options changed since the save.
  const driftCount =
    editing && readyRows && !agentTouched
      ? readyRows.filter((row) => rowMark(row, selection, saved, pickedLabels))
          .length
      : 0

  const pickValue = (row: OptionRow, value: string) => {
    setAgentTouched(true)
    setSubmitError(null)
    setInvalidIds((prev) => {
      if (!prev.has(row.id)) return prev
      const next = new Set(prev)
      next.delete(row.id)
      return next
    })
    setPickedLabels((prev) => ({
      ...prev,
      [row.id]:
        (row.kind === "select"
          ? row.groups.flatMap((g) => g.options).find((o) => o.value === value)
              ?.name
          : row.kind === "mode"
            ? row.modes.find((m) => m.id === value)?.name
            : value === "true"
              ? booleanLabels.on
              : booleanLabels.off) ?? value,
    }))
    setSelection((prev) =>
      row.kind === "mode"
        ? { ...prev, modeId: value }
        : { ...prev, configValues: { ...prev.configValues, [row.id]: value } }
    )
  }

  const pickAgent = (next: AgentType) => {
    if (next === agentType) return
    setAgentType(next)
    setAgentTouched(true)
    // Every option is the new agent's to pick from scratch.
    setSelection(EMPTY_SELECTION)
    setPickedLabels({})
    setInvalidIds(new Set())
    setSubmitError(null)
    setModelRowCache(null)
  }

  const renderRow = (row: OptionRow, disabled = false) => (
    <RequiredOptionRow
      key={row.id}
      row={row}
      value={effectivePick(row, selection)}
      onChange={(value) => pickValue(row, value)}
      disabled={disabled || saving}
      invalid={invalidIds.has(row.id)}
      mark={rowMark(row, selection, saved, pickedLabels)}
      triggerRef={(el) => {
        triggerRefs.current.set(row.id, el)
      }}
    />
  )

  const tRoot = t as unknown as AppErrorTranslator

  const save = async () => {
    if (submittingRef.current) return
    setSubmitError(null)
    const trimmedName = name.trim()
    if (!trimmedName) {
      setNameError(t("errors.emptyName"))
      nameRef.current?.focus()
      return
    }
    if (charCount(trimmedName) > NAME_MAX) {
      setNameError(t("errors.nameTooLong", { max: NAME_MAX }))
      nameRef.current?.focus()
      return
    }
    if (charCount(description) > DESCRIPTION_MAX) {
      setSubmitError(t("errors.descriptionTooLong", { max: DESCRIPTION_MAX }))
      return
    }
    if (charCount(instructions) > INSTRUCTIONS_MAX) {
      setSubmitError(t("errors.instructionsTooLong", { max: INSTRUCTIONS_MAX }))
      return
    }
    if (agentType === null) {
      setSubmitError(t("pickAgentFirst"))
      return
    }

    let agentConfig: AssistantAgentConfig | undefined
    if (gate.kind === "ready") {
      const stillMissing = missingRows(gate.rows, selection)
      if (stillMissing.length > 0) {
        setInvalidIds(new Set(stillMissing.map((row) => row.id)))
        setSubmitError(t("missingCount", { count: stillMissing.length }))
        triggerRefs.current.get(stillMissing[0].id)?.focus()
        return
      }
      const built = buildAgentConfig({
        agentType,
        agentLabel: getAgentLabel(agentType) ?? agentType,
        rows: gate.rows,
        selection,
        modeLabel: tm("modeLabel"),
        booleanLabels,
      })
      // An edit submits the selection only when it differs from the saved one
      // — the user changed something, or an option the agent dropped is
      // removed — so a rename alone leaves the saved names untouched.
      agentConfig =
        assistant && sameAgentSelection(built, assistant) ? undefined : built
    } else if (
      editing &&
      !agentTouched &&
      (gate.kind === "error" ||
        gate.kind === "unavailable-agent" ||
        gate.kind === "not-switched")
    ) {
      // The options cannot be checked right now — the probe failed, the agent
      // cannot run here, or it would not switch to the saved model — and were
      // not touched: the other fields save, the saved selection stays as it
      // was.
      agentConfig = undefined
    } else {
      setSubmitError(
        gate.kind === "error"
          ? t("cannotSaveProbeFailed")
          : gate.kind === "pick-model"
            ? t("missingCount", { count: 1 })
            : gate.kind === "not-switched"
              ? t("cannotSaveModelNotSwitched")
              : t("cannotSaveStillLoading")
      )
      if (gate.kind === "pick-model") {
        setInvalidIds(new Set([gate.modelRow.id]))
        triggerRefs.current.get(gate.modelRow.id)?.focus()
      }
      return
    }

    submittingRef.current = true
    setSaving(true)
    try {
      const avatarToSave = avatarTouched
        ? avatar
        : defaultAvatarFor(trimmedName)
      let row: AssistantInfo
      if (assistant) {
        row = await update(assistant.id, {
          name: trimmedName,
          description,
          avatar: avatarToSave,
          instructions,
          enabled,
          ...(agentConfig ? { agent_config: agentConfig } : {}),
        })
      } else {
        if (!agentConfig) return
        row = await create({
          name: trimmedName,
          description,
          avatar: avatarToSave,
          agent_config: agentConfig,
          instructions,
          enabled,
        })
      }
      onSaved?.(row)
      onClose()
    } catch (err) {
      const message = toLocalizedErrorMessage(err, tRoot)
      if (extractAppCommandError(err)?.i18n_key === "errors.duplicateName") {
        setNameError(message)
        focusNameAfterSaveRef.current = true
      } else {
        setSubmitError(message)
      }
    } finally {
      submittingRef.current = false
      setSaving(false)
    }
  }

  const agentChoices = agents.filter(
    (a) => a.enabled || a.agent_type === agentType
  )

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? t("editTitle") : t("createTitle")}</DialogTitle>
        <DialogDescription>{t("editorDescription")}</DialogDescription>
      </DialogHeader>

      <form
        className="flex min-h-0 flex-1 flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {/* Only the fields scroll: the footer stays in view, so Save is
            reachable however many options the agent has. `relative` keeps
            the hidden native inputs behind the selects and the switch
            inside this box; positioned against the dialog, they would make
            it scroll as well. */}
        <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          <div className="flex items-start gap-3">
            <AssistantAvatarPicker
              avatar={avatarTouched ? avatar : defaultAvatarFor(name)}
              name={name}
              onChange={(next) => {
                setAvatar(next)
                setAvatarTouched(true)
              }}
              disabled={saving}
            />
            <div className="min-w-0 flex-1 space-y-1">
              <label htmlFor="assistant-name" className="text-sm font-medium">
                {t("nameLabel")}
              </label>
              <Input
                id="assistant-name"
                ref={nameRef}
                value={name}
                maxLength={NAME_MAX * 2}
                onChange={(e) => {
                  setName(e.target.value)
                  setNameError(null)
                }}
                placeholder={t("namePlaceholder")}
                aria-invalid={nameError ? true : undefined}
                disabled={saving}
              />
              {nameError ? (
                <p className="text-xs text-destructive">{nameError}</p>
              ) : null}
            </div>
          </div>

          <div className="space-y-1">
            <label
              htmlFor="assistant-description"
              className="text-sm font-medium"
            >
              {t("descriptionLabel")}
            </label>
            <Input
              id="assistant-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              {t("descriptionHint")}
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium">{t("agentLabel")}</label>
              <Select
                value={agentType ?? ""}
                onValueChange={(v) => pickAgent(v as AgentType)}
                disabled={saving}
              >
                <SelectTrigger
                  size="sm"
                  className="w-56"
                  aria-label={t("agentLabel")}
                >
                  <SelectValue placeholder={t("agentPlaceholder")}>
                    {agentType
                      ? agentInfo
                        ? getAgentLabel(agentType)
                        : (assistant?.label_snapshot.agent ??
                          getAgentLabel(agentType))
                      : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {agentChoices.map((a) => (
                    <SelectItem
                      key={a.agent_type}
                      value={a.agent_type}
                      disabled={!a.available || !a.enabled}
                    >
                      {getAgentLabel(a.agent_type)}
                      {!a.available
                        ? ` (${t("agentNotInstalled")})`
                        : !a.enabled
                          ? ` (${t("agentDisabled")})`
                          : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="min-h-[5rem] space-y-4 rounded-lg border bg-card/50 p-3">
              <OptionsSection
                gate={gate}
                loading={probe.loading}
                savedAssistant={editing && !agentTouched ? assistant : null}
                driftCount={driftCount}
                missingCount={readyRows ? missing.length : null}
                renderRow={renderRow}
                onRetry={() => probe.reload()}
              />
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label
                htmlFor="assistant-instructions"
                className="text-sm font-medium"
              >
                {t("instructionsLabel")}
              </label>
              <span
                className={
                  charCount(instructions) > INSTRUCTIONS_MAX
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {t("charCount", {
                  count: charCount(instructions),
                  max: INSTRUCTIONS_MAX,
                })}
              </span>
            </div>
            <Textarea
              id="assistant-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={t("instructionsPlaceholder")}
              className="min-h-[7rem] text-sm"
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              {t("instructionsHint")}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <label htmlFor="assistant-enabled" className="text-sm font-medium">
              {t("enabledLabel")}
            </label>
            <Switch
              id="assistant-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={saving}
            />
          </div>
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <p
            className="min-h-4 text-xs text-destructive"
            role={submitError ? "alert" : undefined}
          >
            {submitError}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : null}
              {t("save")}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </>
  )
}

function OptionsSection({
  gate,
  loading,
  savedAssistant,
  driftCount,
  missingCount,
  renderRow,
  onRetry,
}: {
  gate: OptionsGate
  loading: boolean
  /** The assistant being edited while its agent and options are untouched:
   *  whose saved names stand in when the options cannot be read. */
  savedAssistant: AssistantInfo | null
  driftCount: number
  missingCount: number | null
  renderRow: (row: OptionRow, disabled?: boolean) => React.ReactNode
  onRetry: () => void
}) {
  const t = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  const probing = (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      {tm("probing")}
    </div>
  )
  switch (gate.kind) {
    case "no-agent":
      return (
        <p className="text-xs text-muted-foreground">{t("pickAgentFirst")}</p>
      )
    case "unavailable-agent":
      return (
        <div className="space-y-2">
          <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
            {t("agentUnavailableHint")}
          </p>
          <SavedLabels assistant={savedAssistant} />
        </div>
      )
    case "loading":
      return probing
    case "error":
      return (
        <div className="space-y-3">
          {gate.modelRow ? renderRow(gate.modelRow) : null}
          <div className="flex flex-col items-start gap-2">
            <p className="text-xs text-destructive">
              {tm("probeFailed", { detail: gate.message })}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              {tm("retry")}
            </Button>
          </div>
          <SavedLabels assistant={savedAssistant} />
        </div>
      )
    case "pick-model":
      return (
        <div className="space-y-3">
          {renderRow(gate.modelRow)}
          <p className="text-xs text-muted-foreground">{t("pickModelFirst")}</p>
        </div>
      )
    case "confirming":
      return (
        <div className="space-y-3">
          {renderRow(gate.modelRow)}
          {probing}
        </div>
      )
    case "not-switched":
      return (
        <div className="space-y-3">
          {renderRow(gate.modelRow)}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t("modelNotSwitched")}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRetry}
              disabled={loading}
            >
              {tm("retry")}
            </Button>
          </div>
          <SavedLabels assistant={savedAssistant} />
        </div>
      )
    case "ready":
      if (gate.rows.length === 0) {
        return (
          <p className="text-xs text-muted-foreground">
            {tm("noConfigAvailable")}
          </p>
        )
      }
      return (
        <div className="space-y-4">
          {driftCount > 0 ? (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              {t("optionsChanged", { count: driftCount })}
            </p>
          ) : null}
          {gate.rows.map((row) => renderRow(row))}
          {missingCount !== null && missingCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("missingCount", { count: missingCount })}
            </p>
          ) : null}
        </div>
      )
  }
}

/** The saved selection's names, read-only — shown when the options cannot be
 *  read (the agent is unavailable, the probe failed, or the agent would not
 *  switch to the saved model). A switch is named in the current locale from
 *  its stored value; the snapshot holds the label of the locale it was saved
 *  in. */
function SavedLabels({ assistant }: { assistant: AssistantInfo | null }) {
  const t = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  if (!assistant) return null
  const { label_snapshot: labels } = assistant
  const switchLabel = (id: string, fallback: string) => {
    const stored = assistant.agent_options.config_values?.[id]
    return stored === "true"
      ? tm("booleanOn")
      : stored === "false"
        ? tm("booleanOff")
        : fallback
  }
  const items = [
    ...(labels.mode ? [{ name: tm("modeLabel"), value: labels.mode }] : []),
    ...labels.options.map((o) => ({
      name: o.name,
      value:
        o.kind === "boolean" ? switchLabel(o.id, o.value_label) : o.value_label,
    })),
  ]
  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{t("savedNoOptions")}</p>
    )
  }
  return (
    <dl className="space-y-1">
      <p className="text-xs text-muted-foreground">{t("savedOptions")}</p>
      {items.map((item, idx) => (
        <div key={idx} className="flex justify-between gap-3 text-xs">
          <dt className="text-muted-foreground">{item.name}</dt>
          <dd className="truncate">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
