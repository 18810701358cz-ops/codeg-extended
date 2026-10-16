"use client"

/**
 * The "Assistants" tab of the Multi-Agent Collaboration settings: the list of
 * assistants — reorder by drag or arrow keys, enable/disable, edit, duplicate,
 * delete — and the entry to create one. Every change is written at once (there
 * is no section-wide save for this tab), and the list stays live across windows
 * through the assistants store.
 */

import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { Reorder, useDragControls } from "motion/react"
import {
  AlertTriangle,
  Copy,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  UserRound,
} from "lucide-react"
import { toast } from "sonner"

import { AgentIcon } from "@/components/agent-icon"
import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import { getAgentLabel } from "@/lib/custom-agents"
import type { AcpAgentInfo, AssistantInfo } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  useAssistants,
  useAssistantsStore,
  useAssistantsSync,
} from "@/stores/assistants-store"
import { AssistantEditorDialog, NAME_MAX } from "./assistant-editor-dialog"

export interface AssistantsPanelProps {
  /** The SAVED multi-agent switch (not the form's draft): while it is off, an
   *  assistant cannot be delegated to. `null` until known. */
  delegationEnabled: boolean | null
  /** Tabs of this section with unsaved changes, by display name. */
  unsavedTabs: string[]
  /** Go back to the first tab with unsaved changes. */
  onShowUnsaved?: () => void
}

function sameOrder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, idx) => id === b[idx])
}

/** "Name (2)", "Name (3)" … — the first that no live assistant has, the base
 *  shortened as needed to stay within the name limit. */
export function copyName(base: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()))
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`
    const room = NAME_MAX - Array.from(suffix).length
    const head = Array.from(base).slice(0, room).join("").trimEnd()
    const candidate = `${head}${suffix}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
  return base
}

/** "Codex CLI · GPT-5.5 · High" — the saved agent and picks, read off the
 *  saved names: listing never probes an agent. */
function selectionSummary(
  assistant: AssistantInfo,
  booleanLabels: { on: string; off: string }
): string {
  const labels = assistant.label_snapshot
  const parts = [
    labels.mode,
    ...labels.options.map((o) =>
      o.kind === "boolean"
        ? assistant.agent_options.config_values?.[o.id] === "true"
          ? booleanLabels.on
          : booleanLabels.off
        : o.value_label
    ),
  ].filter((p): p is string => !!p)
  return parts.slice(0, 3).join(" · ")
}

export function AssistantsPanel({
  delegationEnabled,
  unsavedTabs,
  onShowUnsaved,
}: AssistantsPanelProps) {
  // The settings window has no workspace layout to keep this store live.
  useAssistantsSync()
  const t = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  const assistants = useAssistants()
  const hydrated = useAssistantsStore((s) => s.hydrated)
  const loadError = useAssistantsStore((s) => s.loadError)
  const { agents } = useAcpAgents()
  const agentsByType = useMemo(
    () => new Map(agents.map((a) => [a.agent_type, a])),
    [agents]
  )
  const [editor, setEditor] = useState<{
    key: number
    assistant: AssistantInfo | null
  } | null>(null)
  const editorSeq = useRef(0)
  const [deleting, setDeleting] = useState<AssistantInfo | null>(null)
  const tErr = t as unknown as AppErrorTranslator
  const booleanLabels = { on: tm("booleanOn"), off: tm("booleanOff") }

  // The order while a drag is in flight; null = the store's. Persisted once,
  // on release.
  const [dragOrder, setDragOrder] = useState<number[] | null>(null)
  const dragOrderRef = useRef<number[] | null>(null)
  const dragStartRef = useRef<number[] | null>(null)
  const shown = useMemo(() => {
    if (!dragOrder) return assistants
    const byId = new Map(assistants.map((a) => [a.id, a]))
    return dragOrder
      .map((id) => byId.get(id))
      .filter((a): a is AssistantInfo => a !== undefined)
  }, [assistants, dragOrder])
  const shownIds = useMemo(() => shown.map((a) => a.id), [shown])

  const persistOrder = useCallback(
    (order: number[]) => {
      useAssistantsStore
        .getState()
        .reorder(order)
        .catch((err: unknown) =>
          toast.error(t("reorderFailed"), {
            description: toLocalizedErrorMessage(err, tErr),
          })
        )
    },
    [t, tErr]
  )

  const handleReorder = useCallback(
    (next: number[]) => {
      dragStartRef.current ??= assistants.map((a) => a.id)
      dragOrderRef.current = next
      setDragOrder(next)
    },
    [assistants]
  )

  const handleDragEnd = useCallback(() => {
    const order = dragOrderRef.current
    const start = dragStartRef.current
    dragOrderRef.current = null
    dragStartRef.current = null
    setDragOrder(null)
    if (!order || !start || sameOrder(order, start)) return
    persistOrder(order)
  }, [persistOrder])

  const move = useCallback(
    (id: number, delta: -1 | 1) => {
      const order = assistants.map((a) => a.id)
      const from = order.indexOf(id)
      const to = from + delta
      if (from < 0 || to < 0 || to >= order.length) return
      ;[order[from], order[to]] = [order[to], order[from]]
      persistOrder(order)
    },
    [assistants, persistOrder]
  )

  const toggle = useCallback(
    (assistant: AssistantInfo, enabled: boolean) => {
      useAssistantsStore
        .getState()
        .update(assistant.id, { enabled })
        .catch((err: unknown) =>
          toast.error(t("saveFailed"), {
            description: toLocalizedErrorMessage(err, tErr),
          })
        )
    },
    [t, tErr]
  )

  const duplicate = useCallback(
    (assistant: AssistantInfo) => {
      const name = copyName(
        assistant.name,
        assistants.map((a) => a.name)
      )
      useAssistantsStore
        .getState()
        .create({
          name,
          description: assistant.description,
          avatar: assistant.avatar,
          agent_config: {
            agent_type: assistant.agent_type,
            agent_options: {
              mode_id: assistant.agent_options.mode_id ?? null,
              config_values: {
                ...(assistant.agent_options.config_values ?? {}),
              },
            },
            label_snapshot: assistant.label_snapshot,
          },
          instructions: assistant.instructions,
          enabled: assistant.enabled,
        })
        .then((row) => toast.success(t("duplicated", { name: row.name })))
        .catch((err: unknown) =>
          toast.error(t("saveFailed"), {
            description: toLocalizedErrorMessage(err, tErr),
          })
        )
    },
    [assistants, t, tErr]
  )

  const confirmDelete = useCallback(() => {
    const target = deleting
    setDeleting(null)
    if (!target) return
    useAssistantsStore
      .getState()
      .remove(target.id)
      .catch((err: unknown) =>
        toast.error(t("deleteFailed"), {
          description: toLocalizedErrorMessage(err, tErr),
        })
      )
  }, [deleting, t, tErr])

  const openEditor = (assistant: AssistantInfo | null) => {
    editorSeq.current += 1
    setEditor({ key: editorSeq.current, assistant })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-5 text-muted-foreground">
          {t("description")}
        </p>
        <Button size="sm" onClick={() => openEditor(null)}>
          <Plus className="size-3.5" aria-hidden />
          {t("create")}
        </Button>
      </div>

      {delegationEnabled === false ? (
        <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          {t("delegationOff")}
        </p>
      ) : null}

      {unsavedTabs.length > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            {t("unsavedElsewhere", { tabs: unsavedTabs.join(" / ") })}
          </span>
          {onShowUnsaved ? (
            <Button size="xs" variant="ghost" onClick={onShowUnsaved}>
              {t("unsavedGoBack")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {loadError && !hydrated ? (
        <p className="text-xs text-destructive">
          {t("loadFailed", { detail: loadError })}
        </p>
      ) : null}

      {hydrated && shown.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-8 text-center">
          <UserRound className="size-6 text-muted-foreground" aria-hidden />
          <p className="max-w-sm text-xs text-muted-foreground">{t("empty")}</p>
          <Button size="sm" variant="outline" onClick={() => openEditor(null)}>
            <Plus className="size-3.5" aria-hidden />
            {t("create")}
          </Button>
        </div>
      ) : null}

      {shown.length > 0 ? (
        <Reorder.Group
          as="ul"
          axis="y"
          values={shownIds}
          onReorder={handleReorder}
          aria-label={tm("tabAssistants")}
          className="space-y-1.5"
        >
          {shown.map((assistant, index) => (
            <AssistantRow
              key={assistant.id}
              assistant={assistant}
              agent={agentsByType.get(assistant.agent_type) ?? null}
              agentsKnown={agents.length > 0}
              summary={selectionSummary(assistant, booleanLabels)}
              isFirst={index === 0}
              isLast={index === shown.length - 1}
              onMove={move}
              onDragEnd={handleDragEnd}
              onToggle={toggle}
              onEdit={() => openEditor(assistant)}
              onDuplicate={() => duplicate(assistant)}
              onDelete={() => setDeleting(assistant)}
            />
          ))}
        </Reorder.Group>
      ) : null}

      {editor ? (
        <AssistantEditorDialog
          key={editor.key}
          open
          onOpenChange={(open) => {
            if (!open) setEditor(null)
          }}
          assistant={editor.assistant}
        />
      ) : null}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("deleteTitle", { name: deleting?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface AssistantRowProps {
  assistant: AssistantInfo
  agent: AcpAgentInfo | null
  /** The agent list has loaded, so a missing entry means "not installed". */
  agentsKnown: boolean
  summary: string
  isFirst: boolean
  isLast: boolean
  onMove: (id: number, delta: -1 | 1) => void
  onDragEnd: () => void
  onToggle: (assistant: AssistantInfo, enabled: boolean) => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}

function AssistantRow({
  assistant,
  agent,
  agentsKnown,
  summary,
  isFirst,
  isLast,
  onMove,
  onDragEnd,
  onToggle,
  onEdit,
  onDuplicate,
  onDelete,
}: AssistantRowProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const dragControls = useDragControls()
  const agentProblem = !agentsKnown
    ? null
    : !agent || !agent.available
      ? t("agentNotInstalled")
      : !agent.enabled
        ? t("agentDisabled")
        : null

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    dragControls.start(event)
  }
  // The keyboard way to do what the handle does.
  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" && !isFirst) {
      event.preventDefault()
      onMove(assistant.id, -1)
    } else if (event.key === "ArrowDown" && !isLast) {
      event.preventDefault()
      onMove(assistant.id, 1)
    }
  }

  return (
    <Reorder.Item
      as="li"
      value={assistant.id}
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      layout="position"
      onDragEnd={onDragEnd}
      data-assistant-row={assistant.id}
      className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background px-2 py-2"
    >
      <button
        type="button"
        onPointerDown={startDrag}
        onKeyDown={onHandleKeyDown}
        title={t("move", { name: assistant.name })}
        aria-label={t("move", { name: assistant.name })}
        className="cursor-grab touch-none rounded p-0.5 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" />
      </button>
      <AssistantAvatar
        avatar={assistant.avatar}
        name={assistant.name}
        size={32}
      />
      <div className={cn("min-w-0 flex-1", !assistant.enabled && "opacity-60")}>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{assistant.name}</span>
          {agentProblem ? (
            <span
              className="flex shrink-0 items-center gap-0.5 text-[0.625rem] text-amber-700 dark:text-amber-400"
              title={agentProblem}
            >
              <AlertTriangle className="size-3" aria-hidden />
              {agentProblem}
            </span>
          ) : null}
        </div>
        {assistant.description ? (
          <p className="truncate text-xs text-muted-foreground">
            {assistant.description}
          </p>
        ) : null}
        <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[0.6875rem] text-muted-foreground">
          <AgentIcon agentType={assistant.agent_type} className="size-3" />
          <span className="truncate">
            {agent
              ? getAgentLabel(assistant.agent_type)
              : assistant.label_snapshot.agent ||
                getAgentLabel(assistant.agent_type)}
            {summary ? ` · ${summary}` : ""}
          </span>
        </div>
      </div>
      <Switch
        className="shrink-0"
        checked={assistant.enabled}
        aria-label={t("enableAssistant", { name: assistant.name })}
        onCheckedChange={(enabled) => onToggle(assistant, enabled)}
      />
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t("edit", { name: assistant.name })}
        onClick={onEdit}
      >
        <Pencil className="size-3.5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("more", { name: assistant.name })}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onDuplicate}>
            <Copy className="size-3.5" />
            {t("duplicate")}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 className="size-3.5" />
            {t("delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Reorder.Item>
  )
}
