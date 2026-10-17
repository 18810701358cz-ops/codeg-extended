"use client"

import { useEffect, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  BotIcon,
  ChevronRight,
  ListTodoIcon,
  Loader2,
  MapPinned,
} from "lucide-react"

import { AgentPlanEntryList } from "@/components/chat/agent-plan-overlay"
import { SubAgentRow } from "@/components/chat/sub-agent-overlay"
import { MessageNavList } from "@/components/message/conversation-message-nav"
import { SessionViewerHost } from "@/components/message/session-viewer-host"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  useSessionDetailsSectionOpen,
  useSubAgentScope,
  type SubAgentScope,
} from "@/lib/session-details-prefs"
import { cn } from "@/lib/utils"
import {
  demandTranscriptNav,
  useTranscriptInsightsPart,
} from "@/stores/transcript-insights-store"

interface SessionDetailsInsightsProps {
  /** The active tab's runtime conversation id (`runtimeConversationId ??
   *  conversationId`) — the key its transcript publishes under. */
  conversationId: number | null
  /** The panel and this tab are on screen. The navigator's rows are only
   *  computed while they are. */
  active: boolean
}

/**
 * The part of the Session Details side panel that follows the conversation's
 * transcript: the agent's plan, its sub-agents and the message navigator —
 * what the conversation page used to stack as chips over the messages' top
 * inline-start corner. The transcript derives them and publishes them to the
 * insights store (see `MessageListView`'s `insightsInSidebar`); each section
 * reads its own part and renders nothing while that part is empty.
 *
 * The sub-agent rows open their "查看会话" drawer through a host of their own:
 * the transcript's host is in another branch of the tree, and keeping the
 * drawer here rather than in a row means a row leaving the list (a new reply
 * clearing the "current message" scope) doesn't close it.
 */
export function SessionDetailsInsights({
  conversationId,
  active,
}: SessionDetailsInsightsProps) {
  return (
    <SessionViewerHost>
      <PlanSection conversationId={conversationId} />
      <SubAgentsSection conversationId={conversationId} />
      <MessageNavSection conversationId={conversationId} active={active} />
    </SessionViewerHost>
  )
}

/**
 * A collapsible section of the panel: a disclosure header in the panel's
 * section-heading style (with the item count), and its body while open.
 */
function InsightsSection({
  icon,
  title,
  count,
  open,
  onOpenChange,
  children,
}: {
  icon: ReactNode
  title: string
  count: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <section className="min-w-0 space-y-3 border-t pt-4">
      <h3 className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-sm text-start text-xs font-medium uppercase tracking-wide text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              open ? "rotate-90" : "rtl:rotate-180"
            )}
          />
          <span aria-hidden="true" className="inline-flex shrink-0">
            {icon}
          </span>
          <span className="min-w-0 truncate">{title}</span>
          <Badge
            variant="secondary"
            className="h-4 shrink-0 px-1.5 text-3xs normal-case tracking-normal tabular-nums"
          >
            {count}
          </Badge>
        </button>
      </h3>
      {open ? children : null}
    </section>
  )
}

function PlanSection({ conversationId }: { conversationId: number | null }) {
  const t = useTranslations("Folder.chat.agentPlanOverlay")
  const plan = useTranscriptInsightsPart(conversationId, (i) => i.plan)
  const [open, setOpen] = useSessionDetailsSectionOpen("plan")
  if (plan == null || plan.entries.length === 0) return null
  const completed = plan.entries.filter(
    (entry) => entry.status === "completed"
  ).length
  return (
    <InsightsSection
      icon={<ListTodoIcon className="size-3.5" />}
      title={t("title")}
      count={`${completed}/${plan.entries.length}`}
      open={open}
      onOpenChange={setOpen}
    >
      <AgentPlanEntryList entries={plan.entries} isStreaming={plan.streaming} />
    </InsightsSection>
  )
}

function SubAgentsSection({
  conversationId,
}: {
  conversationId: number | null
}) {
  const t = useTranslations("Folder.sessionDetails")
  const tOverlay = useTranslations("Folder.chat.subAgentOverlay")
  const subAgents = useTranscriptInsightsPart(
    conversationId,
    (i) => i.subAgents
  )
  const actions = useTranscriptInsightsPart(conversationId, (i) => i.actions)
  const [open, setOpen] = useSessionDetailsSectionOpen("subAgents")
  const [scope, setScope] = useSubAgentScope()
  // Hidden while the loaded thread started no sub-agent at all — the
  // "current message" scope can only ever be a part of that.
  if (subAgents == null || subAgents.conversation.length === 0) return null
  const sources = scope === "reply" ? subAgents.reply : subAgents.conversation
  return (
    <InsightsSection
      icon={<BotIcon className="size-3.5" />}
      title={tOverlay("title")}
      count={sources.length}
      open={open}
      onOpenChange={setOpen}
    >
      {/* In the body, not beside the title: the panel is narrow, and two
          spelled-out scopes next to the heading would squeeze it away. */}
      <SubAgentScopeToggle scope={scope} onChange={setScope} />
      <div className="space-y-1.5">
        {sources.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("subAgentsReplyEmpty")}
          </p>
        ) : (
          sources.map((source) => (
            <SubAgentRow key={source.parentToolUseId} source={source} />
          ))
        )}
        {scope === "conversation" && subAgents.partial && (
          <div className="flex min-w-0 items-center gap-2 pt-1">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {t("subAgentsPartial")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0"
              disabled={subAgents.loadingOlder || actions == null}
              aria-busy={subAgents.loadingOlder || undefined}
              onClick={actions?.loadEarlierHistory}
            >
              {subAgents.loadingOlder ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : null}
              {t("subAgentsLoadAll")}
            </Button>
          </div>
        )}
      </div>
    </InsightsSection>
  )
}

const SUB_AGENT_SCOPES: SubAgentScope[] = ["reply", "conversation"]

function SubAgentScopeToggle({
  scope,
  onChange,
}: {
  scope: SubAgentScope
  onChange: (scope: SubAgentScope) => void
}) {
  const t = useTranslations("Folder.sessionDetails")
  const label = (value: SubAgentScope) =>
    value === "reply" ? t("subAgentScopeReply") : t("subAgentScopeConversation")
  return (
    <div
      role="group"
      aria-label={t("subAgentScopeLabel")}
      className="grid grid-cols-2 rounded-full bg-muted p-0.5"
    >
      {SUB_AGENT_SCOPES.map((value) => {
        const selected = value === scope
        return (
          <button
            key={value}
            type="button"
            aria-pressed={selected}
            title={label(value)}
            onClick={() => onChange(value)}
            className={cn(
              "min-w-0 truncate rounded-full px-2 py-0.5 text-2xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
              selected
                ? "bg-background text-foreground shadow-sm dark:bg-input/30"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label(value)}
          </button>
        )
      })}
    </div>
  )
}

function MessageNavSection({
  conversationId,
  active,
}: {
  conversationId: number | null
  active: boolean
}) {
  const t = useTranslations("Folder.chat.messageNav")
  const nav = useTranscriptInsightsPart(conversationId, (i) => i.nav)
  const actions = useTranscriptInsightsPart(conversationId, (i) => i.actions)
  const [open, setOpen] = useSessionDetailsSectionOpen("messageNav")
  const count = nav?.count ?? 0
  // Ask the transcript for the rows only while they are on screen: building
  // them parses every turn's diffs.
  const showRows = active && open && count > 0
  useEffect(() => {
    if (!showRows || conversationId == null) return
    return demandTranscriptNav(conversationId)
  }, [showRows, conversationId])
  if (nav == null || actions == null || count === 0) return null
  return (
    <InsightsSection
      icon={<MapPinned className="size-3.5" />}
      title={t("title")}
      count={count}
      open={open}
      onOpenChange={setOpen}
    >
      <MessageNavList
        entries={nav.entries}
        onSelect={actions.selectNavEntry}
        revealingTurnId={nav.revealingTurnId}
        earlier={nav.earlier}
        onRetryEarlier={actions.retryEarlierNav}
      />
    </InsightsSection>
  )
}
