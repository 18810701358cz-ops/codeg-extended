import { memo, useMemo, useState, type ReactNode } from "react"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type { AgentTranscriptEntry } from "@/lib/types"
import {
  groupConsecutiveToolRuns,
  ToolGroupPart,
  type AdaptedToolCallPart,
} from "./tool-group-part"
import { SubagentSessionDialog } from "./subagent-session-dialog"
import {
  AGENT_TRANSCRIPT_RENDER_TAIL,
  formatDuration,
  useAgentCallModel,
} from "./use-agent-call-model"
import { shortAgentId } from "@/lib/collab-tool"
import { MessageResponse } from "@/components/ai-elements/message"
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning"
import { Shimmer } from "@/components/ai-elements/shimmer"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { cn } from "@/lib/utils"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDashed,
  Clock3,
  Loader2,
  OctagonX,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentCapsule } from "./agent-capsule"
import { SubagentSessionButton } from "./subagent-session-button"
import { unwrapWholeFence } from "@/lib/fenced-text"

/**
 * How the codex sub-agent itself ended, as a pill chip.
 *
 * Separate from the capsule's own status chrome, and deliberately so: the card
 * settles when codex acknowledges the LAUNCH, so its "completed" says nothing
 * about the child, which may still be working. codex reports the real outcome
 * later as `SubAgentActivity{kind}` — live via `settle_codex_subagent_launch`,
 * on reload via the rollout parser — and both write it to the same key.
 *
 * `null` (no outcome heard yet) is a state in its own right, not an absence:
 * the child's fate is genuinely unknown, and saying so is the whole reason this
 * chip exists. That case keeps the full explanation in the body, since a
 * two-word chip cannot carry a caveat.
 */
function CodexSubagentStateBadge({ state }: { state: string | null }) {
  const t = useTranslations("Folder.chat.contentParts")
  const [Icon, label, tone] =
    state === "completed"
      ? ([CheckIcon, t("agentSubagentDone"), "text-green-600"] as const)
      : state === "interrupted"
        ? ([OctagonX, t("agentSubagentInterrupted"), "text-amber-500"] as const)
        : ([
            CircleDashed,
            t("agentSubagentUnknown"),
            "text-muted-foreground/70",
          ] as const)

  return (
    <span className="inline-flex items-center gap-1 text-3xs font-normal text-muted-foreground">
      <Icon aria-hidden className={cn("size-3 shrink-0", tone)} />
      {label}
    </span>
  )
}

// ── main component ────────────────────────────────────────────────────

export const AgentToolCallPart = memo(function AgentToolCallPart({
  part,
  renderToolCall,
}: {
  part: Extract<AdaptedContentPart, { type: "tool-call" }>
  /** Render a single tool-call part — injected by the parent to avoid
   *  circular imports (content-parts-renderer → agent-tool-call → renderer). */
  renderToolCall: (
    part: Extract<AdaptedContentPart, { type: "tool-call" }>,
    key: string
  ) => ReactNode
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const tBg = useTranslations("Folder.chat.backgroundTasks")
  const {
    isRunning,
    isError,
    backgroundLifecycle,
    taskOutcome,
    outcomeError,
    outcomeBackground,
    isLiveBackgroundLaunch,
    backgroundSettled,
    backgroundFailed,
    transcript,
    hasTimeline,
    subagentType,
    description,
    prompt,
    model,
    effort,
    isCodexSubagent,
    codexSubagentState,
    agentId,
    title,
    statusLabel,
    agentStats,
    adaptedToolCalls,
    childSession,
    viewerHost,
    sessionOpen,
    setSessionOpen,
    grokProgressLine,
    durationSuffix,
    openChildSession,
  } = useAgentCallModel(part)

  const [promptOpen, setPromptOpen] = useState(false)
  // Settled cards lead with the conclusion; the timeline pill starts closed.
  const [timelineOpen, setTimelineOpen] = useState(false)

  // The timeline's display stream: tool_call markers materialize into their
  // child cards and consecutive ones collapse into one pill group (a text or
  // thinking entry breaks the run — same semantics as the main thread's
  // grouping); prose/thinking stay standalone in arrival order. A marker
  // pointing outside `adaptedToolCalls` is dropped rather than rendered as a
  // hole. While the card runs, prose older than the newest
  // AGENT_TRANSCRIPT_RENDER_TAIL entries is skipped; markers never are.
  //
  // Every item carries its index in the WHOLE transcript (`at`) and is keyed
  // by it. Keying by the position in what is visible would hand an entry's
  // component to its neighbour each time the tail slides: an opened
  // <Reasoning> would fold, and Streamdown — which memoizes its elements on
  // source position alone — would keep painting the previous entry's words.
  const transcriptSegments = useMemo(() => {
    if (!hasTimeline) return []
    const proseCount = transcript.filter(
      (entry) => entry.type !== "tool_call"
    ).length
    let proseToSkip = isRunning
      ? Math.max(0, proseCount - AGENT_TRANSCRIPT_RENDER_TAIL)
      : 0
    const display: Array<{
      call?: { part: AdaptedToolCallPart; at: number }
      other?: {
        entry: Extract<AgentTranscriptEntry, { type: "text" | "thinking" }>
        at: number
      }
    }> = []
    transcript.forEach((entry, at) => {
      if (entry.type === "tool_call") {
        const tc = adaptedToolCalls[entry.childIndex]
        if (tc) display.push({ call: { part: tc, at } })
        return
      }
      if (proseToSkip > 0) {
        proseToSkip -= 1
        return
      }
      display.push({ other: { entry, at } })
    })
    return groupConsecutiveToolRuns(display)
  }, [hasTimeline, transcript, isRunning, adaptedToolCalls])

  const transcriptSegmentNodes = transcriptSegments.map((segment) => {
    if (segment.kind === "calls") {
      return (
        <ToolGroupPart
          key={`subagent-embed-group-${segment.calls[0].at}`}
          part={{
            type: "tool-group",
            items: segment.calls.map((call) => call.part),
            isStreaming: isRunning,
          }}
          renderItem={renderToolCall}
        />
      )
    }
    const { entry, at } = segment.value
    if (entry.type === "thinking") {
      return entry.text.trim() ? (
        // Folded like the main thread's thinking (same contract as
        // <ReasoningPart>): a subagent's reasoning is reference
        // material — it stays collapsed until the reader opens it. The
        // running card's newest entry is the thought still being written,
        // so it reads "Thinking…" until anything follows it.
        <Reasoning
          key={`subagent-embed-${at}`}
          isStreaming={isRunning && at === transcript.length - 1}
        >
          <ReasoningTrigger />
          <ReasoningContent>{entry.text}</ReasoningContent>
        </Reasoning>
      ) : null
    }
    return (
      <div
        key={`subagent-embed-${at}`}
        className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside"
      >
        <MessageResponse>{entry.text}</MessageResponse>
      </div>
    )
  })

  return (
    <>
      <AgentCapsule
        title={title}
        isRunning={isRunning || isLiveBackgroundLaunch || outcomeBackground}
        isError={isError || backgroundFailed || outcomeError != null}
        rightSuffix={durationSuffix}
        idBadge={agentId ? shortAgentId(agentId) : null}
        // codex only: the launch capsule's own state describes the spawn, so the
        // child's outcome needs a chip of its own. Held back while the spawn is
        // still in flight — there is nothing to report yet.
        stateBadge={
          isCodexSubagent && !isRunning ? (
            <CodexSubagentStateBadge state={codexSubagentState} />
          ) : null
        }
        headerAction={
          openChildSession ? (
            <SubagentSessionButton onClick={openChildSession} />
          ) : null
        }
        statusLabel={statusLabel}
      >
        {/* Model and effort summary */}
        {(model || effort) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {model && (
              <span>
                {t("agentModelLabel")}:{" "}
                <span className="font-mono">{model}</span>
              </span>
            )}
            {effort && (
              <span>
                {t("agentEffortLabel")}:{" "}
                <span className="font-mono">{effort}</span>
              </span>
            )}
          </div>
        )}

        {/* Collapsible prompt */}
        {prompt && (
          <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
              <ChevronRightIcon
                aria-hidden="true"
                className={cn(
                  "size-3.5 transition-transform",
                  promptOpen && "rotate-90"
                )}
              />
              {t("agentPromptLabel")}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
                <MessageResponse>{prompt}</MessageResponse>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Child tool calls when no timeline carries them in position — a
      card whose stats predate timelines, whose child transcript was never
      parsed, or whose transcript holds no prose to interleave them with.
      Rendered through the same pill group the main thread folds consecutive
      tool calls into, single calls included. */}
        {adaptedToolCalls.length > 0 && !hasTimeline && (
          <ToolGroupPart
            key="subagent-tc-group"
            part={{
              type: "tool-group",
              items: adaptedToolCalls,
              isStreaming: isRunning,
            }}
            renderItem={renderToolCall}
          />
        )}

        {/* The child's mixed timeline — thinking/text/child-tool markers in
          arrival order (claude-agent-acp ≥0.63 live, or the child's own JSONL
          parsed into `agent_stats.timeline` on history). While the card runs
          it streams in place (prose tail-bounded) under the live heading; once
          the card settles the whole interleaved record collapses into one pill,
          closed by default — the finished card leads with its conclusion, and
          the process is one click away. That is the settled shape every host
          converges on: Claude Code's `Done (N tool uses · …)` line, codex's
          `⌃t to view transcript`, ZCode's permanently compact capsule. The
          tail bound never applies to settled data.
          The pill's summary prefers the child's total duration (the
          transcript's own span, or the task-reported one); the entry count is
          the fallback for agents that supply neither. Right after settle the
          detail may not have landed yet, so the count can show until
          FETCH_DETAIL_SUCCESS re-renders the card with parsed stats. */}
        {hasTimeline &&
          (isRunning ? (
            <div className="space-y-1.5">
              <div className="text-3xs font-medium uppercase tracking-wide text-muted-foreground/70">
                {t("agentLiveTranscript")}
              </div>
              {transcriptSegmentNodes}
            </div>
          ) : (
            <Collapsible
              open={timelineOpen}
              onOpenChange={setTimelineOpen}
              className="w-full"
            >
              <CollapsibleTrigger
                className={cn(
                  "group inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted/60 px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ws-msg-chip"
                )}
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className={cn(
                    "size-3 shrink-0 opacity-60 transition-transform",
                    timelineOpen && "rotate-90"
                  )}
                />
                <span className="min-w-0 truncate">
                  {agentStats?.total_duration_ms
                    ? t("agentProcessDuration", {
                        duration: formatDuration(agentStats.total_duration_ms),
                      })
                    : t("agentProcessCount", {
                        count: transcript.length,
                      })}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent
                className={cn(
                  "w-full outline-none",
                  "data-[state=open]:animate-in data-[state=closed]:animate-out",
                  "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                  "data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1"
                )}
              >
                <div className="mt-3 w-full space-y-3">
                  {transcriptSegmentNodes}
                </div>
              </CollapsibleContent>
            </Collapsible>
          ))}

        {/* Running indicator (in-turn streaming, a live background launch whose
          ack just replaced the stream, or a cursor background-task envelope) */}
        {((isRunning && !part.output) ||
          isLiveBackgroundLaunch ||
          outcomeBackground) && (
          <div className="flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <Shimmer
              className="text-sm"
              duration={1}
              shineColor="var(--primary)"
            >
              {isLiveBackgroundLaunch || outcomeBackground
                ? tBg("cardRunning")
                : t("agentRunning")}
            </Shimmer>
          </div>
        )}

        {/* codex native sub-agent whose outcome codex has NOT reported. The chip
          can only say "unknown"; the caveat behind it needs a sentence, because
          the card would otherwise read as "the sub-agent finished" when all
          that finished was the launch. Settled outcomes say it in the chip
          instead and add nothing here — which is what lets a live capsule with
          no result collapse to a bare pill rather than an empty frame. */}
        {isCodexSubagent && !isRunning && codexSubagentState === null && (
          <div className="text-xs text-muted-foreground">
            {t("agentCodexLaunchOnly")}
          </div>
        )}

        {/* Grok live sub-agent ticker (`subagent_progress`) — only while the
          child is still running; the settled card renders stats/result. */}
        {(isRunning || isLiveBackgroundLaunch) && grokProgressLine && (
          <div className="text-xs text-muted-foreground">
            {grokProgressLine}
          </div>
        )}

        {/* Error output */}
        {isError && part.errorText && (
          <div className="rounded-md bg-destructive/10 p-3">
            <pre className="whitespace-pre-wrap break-words text-xs text-destructive">
              {unwrapWholeFence(part.errorText)}
            </pre>
          </div>
        )}

        {/* Orphaned result recovery: a turn the provider killed mid-flight
          leaves its pending async Agent calls as errors ("no result") while
          the children actually finished — their reports exist only in the
          task files the parser recovered into `recovered_result`. Rendered
          ONLY on an errored card whose child's task COMPLETED: a normally
          completed async child delivered its result via the notification
          turn, and a task that did not complete holds no report — Qoder files
          the error message there for `failed`/`cancelled`, and a placeholder
          for a dead process's task it rewrites to `interrupted`. */}
        {isError &&
          agentStats?.status === "completed" &&
          agentStats.recovered_result && (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">
                {t("agentRecoveredNote")}
              </div>
              <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
                <MessageResponse>{agentStats.recovered_result}</MessageResponse>
              </div>
            </div>
          )}

        {/* Cursor task failure envelope ({error}) — the wire marks the call
          "completed", so this renders where the error styling belongs. */}
        {outcomeError && !isError && (
          <div className="rounded-md bg-destructive/10 p-3">
            <pre className="whitespace-pre-wrap break-words text-xs text-destructive">
              {outcomeError}
            </pre>
          </div>
        )}

        {/* Background lifecycle: settled summary + folded result markdown, or a
          neutral "result pending" line for an unsettled launch. Never dumps
          the marker/ack text. */}
        {backgroundLifecycle && !isError && (
          <div className="space-y-2">
            {backgroundLifecycle.summary && (
              <div className="text-xs text-muted-foreground">
                {backgroundLifecycle.summary}
              </div>
            )}
            {backgroundLifecycle.result ? (
              <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
                <MessageResponse>{backgroundLifecycle.result}</MessageResponse>
              </div>
            ) : !backgroundSettled ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock3 className="size-3.5 shrink-0" />
                {tBg("cardResultPending")}
              </div>
            ) : null}
          </div>
        )}

        {/* Final output. A folded task-outcome envelope renders via the
          capsule chrome above (duration suffix / error box), never as body. */}
        {part.output &&
          !isError &&
          !taskOutcome &&
          !backgroundLifecycle &&
          !isLiveBackgroundLaunch && (
            <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
              <MessageResponse>{part.output}</MessageResponse>
            </div>
          )}
      </AgentCapsule>

      {/* The drawer the header action opens when this card has to own it (no
          `SessionViewerHost` above — see `openChildSession`). A SIBLING of the
          capsule, never one of its children: the capsule counts its children to
          decide whether it has a body, so mounting the drawer inside would grow
          a chevron and a bordered frame the moment the drawer opened — and a
          bodyless capsule never renders its children at all, which is exactly
          the live case this drawer exists for. */}
      {childSession && viewerHost == null && sessionOpen && (
        <SubagentSessionDialog
          open={sessionOpen}
          onOpenChange={setSessionOpen}
          sessionId={childSession.sessionId}
          agentType={childSession.agentType}
          subagentType={subagentType}
          description={description}
          live={isRunning || isLiveBackgroundLaunch}
        />
      )}
    </>
  )
})
