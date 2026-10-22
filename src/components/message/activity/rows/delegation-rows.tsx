"use client"

import { memo, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ActivityIcon, ArrowUpRightIcon, BanIcon } from "lucide-react"

import { AgentIcon } from "@/components/agent-icon"
import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import { DelegationIdentityName } from "@/components/message/delegation-identity"
import { ErrorLabel } from "@/components/message/delegation-status-badge"
import { DelegationStatusRow } from "@/components/message/delegation-status-row"
import { useSessionViewerHost } from "@/components/message/session-viewer-host-context"
import { SubAgentSessionDialog } from "@/components/message/sub-agent-session-dialog"
import {
  useDelegationCardModel,
  type DelegationIdentity,
} from "@/hooks/use-delegation-card-model"
import { previewLine } from "@/lib/activity/format"
import type { ActivityStep, StepStatus } from "@/lib/activity/types"
import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import type { DelegationCardStatus } from "@/lib/delegation-card"
import {
  buildDelegationTaskRows,
  deriveBadge,
  formatDuration,
  parseStatusReport,
  parseTaskId,
  type DelegationTaskRow,
} from "@/lib/delegation-status"
import { useAssistant } from "@/stores/assistants-store"
import { cn } from "@/lib/utils"
import { useActivityRender } from "../activity-context"
import { ActivityRow } from "../activity-row"
import { DetailBox } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { RailIcon } from "../rail-icon"
import { useStatusText } from "../step-visuals"
import {
  formatClock,
  LIVE_CLOCK_AFTER_MS,
  useLiveElapsed,
} from "../use-live-elapsed"
import type { ToolStep } from "./explore-rows"
import { GenericRow } from "./generic-row"

/** Longest result line shown under a finished delegation. */
const RESULT_PREVIEW_CHARS = 240

function stepStatusOf(status: DelegationCardStatus): StepStatus {
  switch (status) {
    case "starting":
    case "running":
      return "running"
    case "waiting":
      return "awaiting"
    case "ok":
      return "succeeded"
    case "err":
      return "failed"
  }
}

/** The agent's logo — or the assistant's avatar — inside the rail's ring. */
function IdentityGlyph({ identity }: { identity: DelegationIdentity }) {
  const assistant = useAssistant(identity.assistantId)
  if (identity.assistantId !== null) {
    return (
      <AssistantAvatar
        avatar={assistant?.avatar ?? null}
        name={assistant?.name ?? identity.assistantName ?? ""}
        size={14}
      />
    )
  }
  return identity.agentType ? (
    <AgentIcon agentType={identity.agentType} className="size-3" />
  ) : (
    <span className="size-1.5 rounded-sm bg-muted-foreground/60" />
  )
}

function DelegationStatusWord({
  status,
  errorCode,
  durationMs,
  clock,
}: {
  status: DelegationCardStatus
  errorCode?: string
  durationMs: number | null
  /** How long it has been running here, once that is worth showing. */
  clock: string | null
}) {
  const t = useTranslations("Folder.chat.delegation.status")
  const duration = durationMs != null ? ` · ${formatDuration(durationMs)}` : ""
  switch (status) {
    case "err":
      return (
        <span className="text-tone-danger">
          <ErrorLabel code={errorCode} />
          {duration}
        </span>
      )
    case "waiting":
      return <span className="text-tone-warning">{t("waiting")}</span>
    case "ok":
      return (
        <>
          {t("ok")}
          {duration}
        </>
      )
    default:
      return (
        <>
          {t(status)}
          {clock ? <span aria-hidden="true">{` ${clock}`}</span> : null}
        </>
      )
  }
}

/**
 * One delegation, start to finish: `Codex  #14be49e7  done · 1m 34s`, the task
 * it was handed (two lines), and — once it reports back — the first line of
 * its result beside "Open conversation ↗" (usable while it still runs). The
 * agent's own `get_delegation_status` polls are folded in when they came right
 * after the hand-over; the full task and those checks (with any decision the
 * sub-agent is waiting on) are in the panel, which opens by itself while the
 * sub-agent waits for the user.
 */
export const DelegationRow = memo(function DelegationRow({
  step,
}: {
  step: ToolStep
}) {
  const t = useTranslations("Folder.chat.activity")
  const tDelegation = useTranslations("Folder.chat.delegation")
  const statusText = useStatusText()
  const { pinnedOnly } = useActivityRender()
  const { part } = step
  const source = useMemo(
    () => ({
      parentToolUseId: part.toolCallId,
      input: part.input,
      output: part.output ?? null,
      errorText: part.errorText ?? null,
      state: part.state,
      meta: part.meta ?? null,
    }),
    [part]
  )
  const model = useDelegationCardModel(source)
  const viewerHost = useSessionViewerHost()
  const [dialogOpen, setDialogOpen] = useState(false)
  const pollRows = useMemo(
    () => (step.polls ? buildDelegationTaskRows(step.polls) : []),
    [step.polls]
  )
  const latest = pollRows[pollRows.length - 1]
  const status = stepStatusOf(model.status)
  const [open, setOpen] = useDisclosure(step.key, {
    defaultOpen: false,
    force: model.status === "waiting",
  })
  const elapsed = useLiveElapsed(step.key, status === "running")

  if (!model.hasModel) return pinnedOnly ? null : <GenericRow step={step} />
  if (pinnedOnly && status !== "running" && status !== "awaiting") return null

  const result =
    model.status === "ok" || model.status === "err"
      ? previewLine(latest?.report.text, RESULT_PREVIEW_CHARS)
      : null
  const openSession =
    model.childConversationId != null
      ? () =>
          viewerHost
            ? viewerHost.open({ kind: "delegation", source })
            : setDialogOpen(true)
      : null
  const hasTask = !!model.task?.trim()

  return (
    <>
      <ActivityRow
        stepKey={step.key}
        approval={step.tool.approval}
        status={status}
        marker={
          <RailIcon
            glyph={<IdentityGlyph identity={model.identity} />}
            status={status}
            label={`${t("kind.delegation")}, ${statusText(status)}`}
          />
        }
        expandable={hasTask || pollRows.length > 0}
        expanded={open}
        onExpandedChange={setOpen}
        title={model.taskId ?? undefined}
        trailing={
          <DelegationStatusWord
            status={model.status}
            errorCode={model.errorCode}
            durationMs={latest?.report.durationMs ?? null}
            clock={
              elapsed !== null && elapsed >= LIVE_CLOCK_AFTER_MS
                ? formatClock(elapsed)
                : null
            }
          />
        }
        addon={
          hasTask || result || openSession ? (
            <div className="space-y-1 pb-0.5">
              {hasTask ? (
                <p
                  dir="auto"
                  className="line-clamp-2 whitespace-pre-wrap break-words text-sm text-foreground/90"
                >
                  {model.task}
                </p>
              ) : null}
              {result || openSession ? (
                <div className="flex min-w-0 items-baseline gap-3 text-sm">
                  {result ? (
                    <span
                      dir="auto"
                      className="min-w-0 flex-1 truncate text-muted-foreground"
                      title={result}
                    >
                      {result}
                    </span>
                  ) : (
                    <span className="flex-1" />
                  )}
                  {openSession ? (
                    <button
                      type="button"
                      onClick={openSession}
                      className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-sm text-foreground/80 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {tDelegation("openDetail")}
                      <ArrowUpRightIcon
                        aria-hidden="true"
                        className="size-3.5 rtl:-scale-x-100"
                      />
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null
        }
        detail={() => (
          <div className="space-y-2">
            {hasTask ? (
              <DetailBox tone="neutral">
                <p
                  dir="auto"
                  className="whitespace-pre-wrap break-words px-4 py-3 text-sm text-foreground/90"
                >
                  {model.task}
                </p>
              </DetailBox>
            ) : null}
            {pollRows.length > 0 ? <PollRows rows={pollRows} /> : null}
          </div>
        )}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <DelegationIdentityName
            identity={model.identity}
            className="min-w-0 truncate font-semibold text-foreground"
          />
          {model.taskId ? (
            <span
              className="shrink-0 font-mono text-[0.8125rem] text-muted-foreground"
              title={model.taskId}
              dir="ltr"
            >
              #{model.taskId.slice(0, 8)}
            </span>
          ) : null}
        </span>
      </ActivityRow>
      {viewerHost == null && model.childConversationId != null ? (
        <SubAgentSessionDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          childConversationId={model.childConversationId}
          childConnectionId={model.childConnectionId}
          identity={model.identity}
          kickoffTask={model.task}
        />
      ) : null}
    </>
  )
})

/** A delegation's checks, as the status rows that carry their results and any
 *  pending decision. */
function PollRows({ rows }: { rows: DelegationTaskRow[] }) {
  return (
    <div className="space-y-0.5">
      {rows.map((row) => (
        <DelegationStatusRow
          key={row.key}
          kind="status"
          layout="timeline"
          taskId={row.taskId}
          report={row.report}
          badge={row.badge}
          results={row.results}
          runningConfirmed={row.runningConfirmed}
          latestPollId={row.latestPollId}
        />
      ))}
    </div>
  )
}

function pollsStatus(rows: DelegationTaskRow[]): StepStatus {
  if (rows.some((r) => r.badge.status === "waiting")) return "awaiting"
  if (rows.some((r) => r.badge.status === "running")) return "running"
  if (rows.some((r) => r.badge.status === "err")) return "failed"
  return "succeeded"
}

type PollsStep = Extract<ActivityStep, { type: "delegation-polls" }>

/**
 * Checks on a delegation that did not come right after it (the agent did
 * other work in between): a thin `Waiting for task #… result · 1m 34s` row per
 * task, which keeps the decision a waiting sub-agent needs answered.
 */
export const DelegationPollsRow = memo(function DelegationPollsRow({
  step,
}: {
  step: PollsStep
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const rows = useMemo(() => buildDelegationTaskRows(step.polls), [step.polls])
  if (rows.length === 0) return null
  const status = pollsStatus(rows)
  return (
    <PollsLi stepKey={step.key} status={status}>
      <RailIcon
        icon={ActivityIcon}
        status={status}
        label={`${t("kind.delegation")}, ${statusText(status)}`}
      />
      <PollRows rows={rows} />
    </PollsLi>
  )
})

/** `cancel_delegation`: one thin status row, like a check. */
export const DelegationCancelRow = memo(function DelegationCancelRow({
  part,
  stepKey,
}: {
  part: AdaptedToolCallPart
  stepKey: string
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const report = useMemo(
    () => parseStatusReport(part.output ?? null, part.errorText ?? null),
    [part.output, part.errorText]
  )
  const taskId = parseTaskId(part.input) ?? report.taskId
  const badge = deriveBadge("cancel", report, part.state, !!part.errorText)
  const status: StepStatus =
    badge.status === "err"
      ? "failed"
      : badge.status === "running" || badge.status === "starting"
        ? "running"
        : "succeeded"
  return (
    <PollsLi stepKey={stepKey} status={status}>
      <RailIcon
        icon={BanIcon}
        status={status}
        label={`${t("kind.delegation")}, ${statusText(status)}`}
      />
      <DelegationStatusRow
        kind="cancel"
        layout="timeline"
        taskId={taskId}
        report={report}
        badge={badge}
      />
    </PollsLi>
  )
})

function PollsLi({
  stepKey,
  status,
  children,
}: {
  stepKey: string
  status: StepStatus
  children: [React.ReactNode, React.ReactNode]
}) {
  const [marker, body] = children
  return (
    <li
      className="activity-item"
      data-marker="ring"
      data-status={status}
      data-step-key={stepKey}
    >
      <span className="absolute start-0.5 top-1 flex size-5 items-center justify-center">
        {marker}
      </span>
      <div className={cn("min-w-0")}>{body}</div>
    </li>
  )
}
