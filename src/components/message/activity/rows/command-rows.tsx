"use client"

import { memo, useMemo } from "react"
import Ansi from "ansi-to-react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon } from "lucide-react"

import { normalizeCommandOutput } from "@/lib/activity/command"
import { countLines } from "@/lib/activity/format"
import type { ActivityStep, StepStatus } from "@/lib/activity/types"
import { describeStdinChars } from "@/lib/shell-session-tool"
import { cn } from "@/lib/utils"
import { useActivityRender } from "../activity-context"
import { ActivityRow } from "../activity-row"
import { CopyAction, DetailBox } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { RailIcon } from "../rail-icon"
import { ToolFigure, toolIcon, useStatusText } from "../step-visuals"
import type { ToolStep } from "./explore-rows"

/** Tail of a running command's output kept for display (as the legacy card). */
const LIVE_OUTPUT_CHARS = 24_000
/** Settled output rendered in full up to this many lines; then only the end. */
const MAX_OUTPUT_LINES = 2_000
/** Lines of a running command shown under its folded row. */
const LIVE_TAIL_LINES = 3
/** Below this a command's duration is noise. */
const SHOW_DURATION_MS = 10_000

/**
 * Some runtimes deliver ANSI escapes as literal "\u001b" / "\x1b" text;
 * decode them so the colours render (same rule as the terminal card).
 */
function decodeEscapedAnsi(output: string): string {
  if (!/\\u001b|\\x1b|\\u009b/i.test(output)) return output
  return output
    .replace(/\\u001b/gi, "\u001b")
    .replace(/\\x1b/gi, "\u001b")
    .replace(/\\u009b/gi, "\u009b")
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

interface CommandOutput {
  text: string
  lines: number
  /** Lines dropped from the front to stay under the render cap. */
  truncated: number
}

function useCommandOutput(step: ToolStep): CommandOutput | null {
  const t = useTranslations("Folder.chat.contentParts")
  const { part, tool } = step
  return useMemo(() => {
    if (tool.background?.taskId && part.output) {
      const text = t("backgroundTask.launchNote", {
        id: tool.background.taskId,
      })
      return { text, lines: 1, truncated: 0 }
    }
    const source = part.output ?? part.errorText ?? null
    if (!source) return null
    let text = decodeEscapedAnsi(normalizeCommandOutput(source))
    const live = tool.status === "running" || tool.status === "pending"
    if (live && text.length > LIVE_OUTPUT_CHARS) {
      text = text.slice(-LIVE_OUTPUT_CHARS)
    }
    text = text.replace(/\n+$/, "")
    if (!text.trim()) return null
    const lines = countLines(text)
    if (lines > MAX_OUTPUT_LINES) {
      const all = text.split("\n")
      return {
        text: all.slice(-MAX_OUTPUT_LINES).join("\n"),
        lines,
        truncated: lines - MAX_OUTPUT_LINES,
      }
    }
    return { text, lines, truncated: 0 }
  }, [part.output, part.errorText, tool.background, tool.status, t])
}

/** The command line a row shows: `$ cmd`, a heredoc's opener, a session verb. */
function CommandLabel({ step }: { step: ToolStep }) {
  const t = useTranslations("Folder.chat.activity")
  const command = step.tool.command
  if (!command) return null

  if (command.session) {
    const verb =
      command.session.verb === "stdin"
        ? t("row.sessionStdin")
        : command.session.verb === "terminate"
          ? t("row.sessionTerminate")
          : t("row.sessionWait")
    const target = command.session.stdin
      ? describeStdinChars(command.session.stdin)
      : command.display ||
        (command.session.sessionId
          ? t("row.sessionCell", { id: command.session.sessionId })
          : "")
    return (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-medium text-muted-foreground">
          {verb}
        </span>
        <span className="min-w-0 truncate font-mono text-[0.8125rem]" dir="ltr">
          {target}
        </span>
      </span>
    )
  }

  if (step.tool.kind === "script") {
    return (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-medium text-muted-foreground">
          {t("row.codexScript")}
        </span>
        {command.display ? (
          <span
            className="min-w-0 truncate font-mono text-[0.8125rem]"
            dir="ltr"
          >
            {command.display}
          </span>
        ) : null}
        {command.lineCount > 0 ? (
          <span className="shrink-0 text-muted-foreground">
            {t("row.script", { count: command.lineCount })}
          </span>
        ) : null}
      </span>
    )
  }

  const heredoc = command.heredoc
  const firstLine = heredoc ? heredoc.head : command.display.split("\n")[0]!
  const extraLines = heredoc ? 0 : command.lineCount - 1
  // One clamped block holding the command and its trailing notes, so the
  // notes flow after the last line of the command instead of dropping below.
  return (
    <span className="line-clamp-3 [overflow-wrap:anywhere]">
      <span className="font-mono text-[0.8125rem]" dir="ltr">
        <span className="select-none text-muted-foreground">$ </span>
        {firstLine}
      </span>
      {heredoc ? (
        <span className="ms-2 text-muted-foreground">
          {t("row.script", { count: heredoc.bodyLines })}
        </span>
      ) : extraLines > 0 ? (
        <span className="ms-2 text-muted-foreground">
          {t("row.moreLines", { count: extraLines })}
        </span>
      ) : null}
      {step.tool.background ? (
        <span className="ms-2 inline-block rounded-full bg-muted px-1.5 align-[0.0625rem] font-mono text-3xs leading-4 text-muted-foreground ws-msg-chip">
          {step.tool.background.taskId
            ? t("row.background", { id: step.tool.background.taskId })
            : t("row.backgroundShort")}
        </span>
      ) : null}
    </span>
  )
}

function CommandDetail({
  step,
  output,
}: {
  step: ToolStep
  output: CommandOutput | null
}) {
  const t = useTranslations("Folder.chat.activity")
  const { tool } = step
  const command = tool.command
  const failed = tool.status === "failed" || tool.status === "rejected"
  const live = tool.status === "running" || tool.status === "pending"
  const showCommand =
    !!command && !command.session && command.lineCount > 1 && !!command.display
  const fullCommand = command?.display ?? ""

  return (
    <DetailBox
      tone={failed ? "danger" : "neutral"}
      anchor={failed || live ? "end" : "start"}
      footer={output ? t("detail.lines", { count: output.lines }) : null}
      actions={
        <>
          {fullCommand && !command?.session ? (
            <CopyAction text={fullCommand} label={t("detail.copyCommand")} />
          ) : null}
          {output ? (
            <CopyAction
              text={() => stripAnsi(output.text)}
              label={t("detail.copyOutput")}
            />
          ) : null}
        </>
      }
    >
      {command?.description ? (
        <p className="border-b border-foreground/5 px-4 py-2 text-xs text-muted-foreground">
          {command.description}
        </p>
      ) : null}
      {showCommand ? (
        <pre
          className="whitespace-pre-wrap break-words border-b border-foreground/5 px-4 py-3 font-mono text-[0.78125rem] leading-relaxed"
          dir="ltr"
        >
          <span className="select-none text-muted-foreground">$ </span>
          {fullCommand}
        </pre>
      ) : null}
      {output ? (
        <>
          {output.truncated > 0 ? (
            <p className="px-4 pt-2 font-mono text-2xs text-muted-foreground">
              {t("detail.tailOnly", { count: MAX_OUTPUT_LINES })}
            </p>
          ) : null}
          <pre
            className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[0.78125rem] leading-relaxed"
            dir="ltr"
          >
            <Ansi>{output.text}</Ansi>
          </pre>
        </>
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {t("detail.noOutput")}
        </p>
      )}
    </DetailBox>
  )
}

/** The last few lines of a running command, under its folded row. */
function LiveTail({ text }: { text: string }) {
  const tail = useMemo(() => {
    const lines = stripAnsi(text)
      .split("\n")
      .filter((line) => line.trim().length > 0)
    return lines.slice(-LIVE_TAIL_LINES).join("\n")
  }, [text])
  return (
    <pre
      aria-hidden="true"
      className="mt-0.5 overflow-hidden whitespace-pre-wrap break-all font-mono text-2xs leading-4 text-muted-foreground/70 [animation:tool-content-fade_200ms_ease-out_500ms_both]"
      dir="ltr"
    >
      {tail}
    </pre>
  )
}

/**
 * `$ pnpm --filter web test   exit 1` — a shell command (or codex's session
 * polls and scripts). The row shows the command itself, never the agent's
 * description of it (that goes in the tooltip and atop the panel). A failure
 * opens itself — output anchored at the end, where the error is — and stays
 * open; a running command stays folded with its last lines showing beneath.
 */
export const CommandRow = memo(function CommandRow({
  step,
  inGroup = false,
}: {
  step: ToolStep
  inGroup?: boolean
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const { recoveredKeys } = useActivityRender()
  const { tool } = step
  const output = useCommandOutput(step)
  const failed = tool.status === "failed" || tool.status === "rejected"
  const live = tool.status === "running" || tool.status === "pending"
  const [open, setOpen] = useDisclosure(step.key, {
    defaultOpen: false,
    force: failed && !recoveredKeys.has(step.key),
  })
  const expandable =
    !!output ||
    !!tool.command?.description ||
    (tool.command?.lineCount ?? 0) > 1
  const duration =
    tool.status === "succeeded" &&
    tool.command?.durationMs != null &&
    tool.command.durationMs >= SHOW_DURATION_MS
      ? formatDuration(tool.command.durationMs)
      : null

  return (
    <ActivityRow
      stepKey={step.key}
      status={tool.status}
      variant={inGroup ? "child" : "main"}
      marker={
        <RailIcon
          icon={toolIcon(tool)}
          status={tool.status}
          size={inGroup ? "sm" : "md"}
          label={`${t("kind.command")}, ${statusText(tool.status, tool.exit)}`}
        />
      }
      expandable={expandable}
      expanded={open}
      onExpandedChange={setOpen}
      title={tool.command?.description ?? tool.command?.display ?? undefined}
      trailing={duration ?? <ToolFigure tool={tool} />}
      addon={live && !open && output ? <LiveTail text={output.text} /> : null}
      detail={() => <CommandDetail step={step} output={output} />}
    >
      <CommandLabel step={step} />
    </ActivityRow>
  )
})

/**
 * "Ran 2 commands · all passed". Folded unless a member failed without being
 * redone; while live and folded, the running member shows under the header.
 */
export const CommandGroupRow = memo(function CommandGroupRow({
  groupKey,
  steps,
  status,
}: {
  groupKey: string
  steps: ActivityStep[]
  status: StepStatus
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const { recoveredKeys } = useActivityRender()
  const tools = steps.filter((s): s is ToolStep => s.type === "tool")
  const failures = tools.filter(
    (s) => s.tool.status === "failed" || s.tool.status === "rejected"
  )
  const unrecovered = failures.some((s) => !recoveredKeys.has(s.key))
  const [open, setOpen] = useDisclosure(`group:${groupKey}`, {
    defaultOpen: false,
    force: unrecovered,
  })
  const live = status === "running" || status === "pending"
  const liveStep =
    !open && live
      ? ([...tools]
          .reverse()
          .find(
            (s) => s.tool.status === "running" || s.tool.status === "pending"
          ) ?? null)
      : null
  const allSucceeded = tools.every((s) => s.tool.status === "succeeded")

  return (
    <ActivityRow
      stepKey={groupKey}
      status={status}
      marker={
        <RailIcon
          icon={ChevronRightIcon}
          status={status}
          label={`${t("kind.command")}, ${statusText(status)}`}
          iconClassName={cn(
            "transition-[rotate] rtl:-scale-x-100",
            open && "rotate-90"
          )}
        />
      }
      showChevron={false}
      expandable
      expanded={open}
      onExpandedChange={setOpen}
      trailing={
        failures.length > 0 ? (
          <span className="text-tone-danger">
            {t("metric.someFailed", { count: failures.length })}
          </span>
        ) : allSucceeded ? (
          t("metric.allPassed")
        ) : null
      }
      addon={
        liveStep ? (
          <ul role="list" className="activity-children">
            <CommandRow step={liveStep} inGroup />
          </ul>
        ) : null
      }
      detail={() => (
        <ul role="list" className="activity-children">
          {tools.map((step) => (
            <CommandRow key={step.key} step={step} inGroup />
          ))}
        </ul>
      )}
    >
      <span
        className={cn(
          "font-medium",
          live ? "activity-shimmer" : "text-foreground"
        )}
      >
        {live
          ? t("row.runningCommands", { count: tools.length })
          : t("row.ranCommands", { count: tools.length })}
      </span>
    </ActivityRow>
  )
})
