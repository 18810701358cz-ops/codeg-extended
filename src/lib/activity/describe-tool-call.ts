/**
 * `describeToolCall`: one tool call → the structured description every
 * activity row is drawn from (kind, target, metric, status, exit, files, MCP
 * identity…).
 *
 * This is the single place a tool name is mapped to what the call was. The
 * switch reads the NORMALIZED name (`normalizeToolName`) — the same one the
 * row components dispatch on — so a tool can no longer get its icon from one
 * spelling and its body from another. The raw name is consulted only to
 * recognise a third-party MCP server.
 */

import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import { parseBackgroundLaunch } from "@/lib/background-task"
import {
  CODEX_SCRIPT_TOOL_NAME,
  parseCodexScriptCard,
} from "@/lib/codex-code-mode"
import { isCodegMcpWorkbenchTool } from "@/lib/codeg-mcp-tool"
import { COLLAB_AGENT_TOOL_NAME } from "@/lib/collab-tool"
import { isContextCompactionMeta } from "@/lib/context-compaction"
import { isDelegateToAgentToolName } from "@/lib/delegation-card"
import {
  extractAnnouncedSessionId,
  isShellSessionToolName,
  parseShellSessionInput,
  WAIT_TOOL_NAME,
} from "@/lib/shell-session-tool"
import { isUnsettledToolCall } from "@/lib/tool-call-lifecycle"
import {
  aliasToolInputKeys,
  extractClaudeCodeMetaTitle,
  extractClaudeCodeSkillName,
  normalizeToolName,
  toolCallMovedToBackground,
} from "@/lib/tool-call-normalization"
import { approvalFromMeta } from "./approval"
import {
  detectHeredoc,
  extractCommandExit,
  type CommandExit,
  extractDisplayCommandFromToolInput,
  extractWallTimeMs,
  simplifyShellCommand,
} from "./command"
import { describeEditFiles } from "./edit"
import {
  readLineCount,
  searchResultText,
  summarizeSearchResult,
  type SearchOutcome,
} from "./explore"
import { countLines, ellipsis, shortPath } from "./format"
import {
  extractJsonField,
  findStringFieldDeep,
  isLikelyIdField,
  num,
  tryParseJson,
} from "./json"
import {
  mcpArgumentPreview,
  mcpResultLabel,
  mcpResultPayload,
  parseMcpToolName,
  type McpIdentity,
} from "./mcp"
import { toolCallStatus, type StepStatus } from "./status"
import type {
  CommandInfo,
  ToolDescriptor,
  ToolMetric,
  ToolNote,
  ToolStepKind,
  ToolTarget,
} from "./types"

const PLAN_MODE_TOOLS = new Set([
  "enterplanmode",
  "exitplanmode",
  "switch_mode",
  "plan_review",
])

const TODO_TOOLS = new Set([
  "todowrite",
  "taskcreate",
  "taskupdate",
  "tasklist",
])

/** Which row a tool call gets, before any of its payload is read. */
export function toolStepKind(part: AdaptedToolCallPart): ToolStepKind {
  if (isContextCompactionMeta(part.meta)) return "compaction"
  const name = normalizeToolName(part.toolName).toLowerCase()
  switch (name) {
    case "agent":
      return "agent"
    case "create_goal":
    case "update_goal":
      return "goal"
    case COLLAB_AGENT_TOOL_NAME:
      return "collab-agent"
    case "get_delegation_status":
      return "delegation-status"
    case "cancel_delegation":
      return "delegation-cancel"
    case "question":
      return "question"
    case "check_user_feedback":
      return "feedback"
    case "attempt_completion":
      return "completion"
    case "bash":
    case "exec_command":
      return "command"
    case CODEX_SCRIPT_TOOL_NAME:
      return "script"
    case "read":
    case "read file":
      return "read"
    case "grep":
      return "search"
    case "glob":
    case "find":
      return "glob"
    case "ls":
      return "list"
    case "webfetch":
      return "fetch"
    case "websearch":
      return "web-search"
    case "memory_recall":
      return "memory"
    case "edit":
    case "write":
    case "apply_patch":
    case "notebookedit":
    case "delete":
    case "move":
      return "edit"
    case "skill":
      return "skill"
  }
  if (isDelegateToAgentToolName(name)) {
    return part.toolCallId ? "delegation" : "generic"
  }
  if (name === "resume_delegation") {
    return part.toolCallId ? "delegation-resume" : "workbench"
  }
  if (isCodegMcpWorkbenchTool(name)) return "workbench"
  if (PLAN_MODE_TOOLS.has(name)) return "plan-mode"
  if (TODO_TOOLS.has(name)) return "todo"
  if (isShellSessionToolName(name)) return "shell-session"
  if (mcpIdentityOf(part)) return "mcp"
  return "generic"
}

/** Cline routes every MCP call through `use_mcp_tool {server_name, tool_name}`. */
function clineMcpIdentity(input: string | null): McpIdentity | null {
  const parsed = input ? tryParseJson(input) : null
  const server = parsed?.server_name
  const tool = parsed?.tool_name
  return typeof server === "string" &&
    server &&
    typeof tool === "string" &&
    tool
    ? { server, tool }
    : null
}

function mcpIdentityOf(part: AdaptedToolCallPart): McpIdentity | null {
  if (normalizeToolName(part.toolName) === "tool") {
    return clineMcpIdentity(part.input)
  }
  return parseMcpToolName(part.toolName)
}

// ── field access ──────────────────────────────────────────────────────────

interface Payload {
  input: string | null
  output: string | null
  parsed: Record<string, unknown> | null
  field: (key: string) => string | null
}

function payloadOf(part: AdaptedToolCallPart): Payload {
  const input = part.input ?? null
  const output = part.output ?? part.errorText ?? null
  const parsed =
    aliasToolInputKeys(input ? tryParseJson(input) : null) ??
    (output ? tryParseJson(output) : null)
  const field = (key: string): string | null => {
    const nested = findStringFieldDeep(parsed, key)
    if (nested) return nested
    if (input) {
      const fromInput = extractJsonField(input, key)
      if (fromInput) return fromInput
    }
    return null
  }
  return { input, output, parsed, field }
}

function filePathOf(payload: Payload): string | null {
  return (
    payload.field("file_path") ??
    payload.field("filePath") ??
    payload.field("target_file") ??
    payload.field("targetFile") ??
    payload.field("filename") ??
    payload.field("path") ??
    payload.field("notebook_path")
  )
}

function pathTarget(path: string): ToolTarget {
  const text = shortPath(path)
  return text === path ? { text, path } : { text, full: path, path }
}

function textTarget(value: string, max: number): ToolTarget {
  const clean = value.replace(/\s+/g, " ").trim()
  const text = ellipsis(clean, max)
  return text === value ? { text } : { text, full: value }
}

/** The first argument that reads as a value rather than an id. */
function firstMeaningfulArgument(
  parsed: Record<string, unknown> | null
): string | null {
  if (!parsed) return null
  for (const [key, value] of Object.entries(parsed)) {
    if (isLikelyIdField(key)) continue
    if (typeof value === "string" && value.trim().length > 0) {
      return ellipsis(value.replace(/\s+/g, " ").trim(), 60)
    }
  }
  return null
}

// ── per-kind descriptions ─────────────────────────────────────────────────

function emptyDescriptor(
  kind: ToolStepKind,
  toolName: string,
  status: StepStatus
): ToolDescriptor {
  return {
    kind,
    toolName,
    status,
    target: null,
    detail: null,
    notes: [],
    metric: null,
    exit: null,
    command: null,
    files: null,
    mcp: null,
    background: null,
    approval: null,
  }
}

function searchMetric(outcome: SearchOutcome | null): ToolMetric | null {
  if (!outcome) return null
  switch (outcome.kind) {
    case "none":
      return { kind: "noMatch" }
    case "matches":
      return { kind: "matches", count: outcome.matches, files: outcome.files }
    case "files":
      return { kind: "files", count: outcome.files }
    case "lines":
      return { kind: "results", count: outcome.lines }
  }
}

function readRange(parsed: Record<string, unknown> | null): string | null {
  if (!parsed) return null
  const offset = num(parsed, "offset")
  const limit = num(parsed, "limit")
  if (offset === undefined && limit === undefined) return null
  const start = offset !== undefined && offset > 0 ? offset : 1
  if (limit === undefined) return `L${start}–`
  return `L${start}–${start + Math.max(limit, 1) - 1}`
}

/** Claude Code's Read flags worth naming: past the size limit (CLI
 *  2.1.296+), and the PDF pages it read. */
function readNotes(parsed: Record<string, unknown> | null): ToolNote[] {
  if (!parsed) return []
  const notes: ToolNote[] = []
  const pages = parsed.pages
  if (typeof pages === "string" && pages.trim()) {
    notes.push({ kind: "pages", value: pages.trim() })
  }
  if (parsed.allow_large === true || parsed.allow_large === "true") {
    notes.push({ kind: "allowLarge" })
  }
  return notes
}

/** The exit code the transcript kept as a field, ahead of any read from the
 *  output text. */
function structuredExit(part: AdaptedToolCallPart): CommandExit | null {
  return typeof part.exitCode === "number"
    ? { code: part.exitCode, signal: null }
    : null
}

function describeCommand(
  part: AdaptedToolCallPart,
  payload: Payload,
  base: ToolDescriptor
): ToolDescriptor {
  const display =
    extractDisplayCommandFromToolInput(part.input) ??
    extractDisplayCommandFromToolInput(part.output) ??
    extractDisplayCommandFromToolInput(part.errorText) ??
    ""
  const metaTitle = extractClaudeCodeMetaTitle(part.meta)
  const described = payload.field("description") ?? metaTitle
  const description =
    described && described.trim() && described.trim() !== display.trim()
      ? described.trim()
      : null
  const command: CommandInfo = {
    display,
    lineCount: display ? countLines(display) : 0,
    heredoc: display ? detectHeredoc(display) : null,
    description,
    session: null,
    durationMs: extractWallTimeMs(payload.output),
    announcedSession:
      base.toolName.toLowerCase() === "exec_command"
        ? extractAnnouncedSessionId(payload.output)
        : null,
  }
  const launch = parseBackgroundLaunch(payload.output)
  const background = launch
    ? { taskId: launch.taskId }
    : toolCallMovedToBackground(part.meta) && isUnsettledToolCall(part)
      ? { taskId: null }
      : null
  const exit =
    base.status === "failed"
      ? (structuredExit(part) ?? extractCommandExit(payload.output))
      : null
  return {
    ...base,
    command,
    background,
    // A non-zero exit on a call that still reports success is the program's
    // own text, not its status; only a failure gets an exit badge.
    exit: exit && (exit.code !== 0 || exit.signal) ? exit : null,
  }
}

function describeShellSession(
  part: AdaptedToolCallPart,
  base: ToolDescriptor
): ToolDescriptor {
  const call = parseShellSessionInput(part.input)
  const name = base.toolName.toLowerCase()
  const display = call?.command ? simplifyShellCommand(call.command) : ""
  return {
    ...base,
    command: {
      display,
      lineCount: display ? countLines(display) : 0,
      heredoc: null,
      description: null,
      session: {
        verb: call?.chars
          ? "stdin"
          : name === WAIT_TOOL_NAME && call?.terminate
            ? "terminate"
            : "wait",
        sessionId: call?.sessionId ?? null,
        stdin: call?.chars ? call.chars : null,
      },
      durationMs: extractWallTimeMs(part.output ?? part.errorText),
      announcedSession: null,
    },
    exit:
      base.status === "failed"
        ? (structuredExit(part) ??
          extractCommandExit(part.output ?? part.errorText))
        : null,
  }
}

function describeScript(
  part: AdaptedToolCallPart,
  base: ToolDescriptor
): ToolDescriptor {
  const card = parseCodexScriptCard(part.input)
  const title = card?.title
    ? simplifyShellCommand(card.title).split("\n")[0]!
    : ""
  return {
    ...base,
    command: {
      display: title,
      lineCount: card ? countLines(card.source) : 0,
      heredoc: null,
      description: null,
      session: null,
      durationMs: extractWallTimeMs(part.output ?? part.errorText),
      announcedSession: null,
    },
  }
}

function describeEdit(
  part: AdaptedToolCallPart,
  base: ToolDescriptor
): ToolDescriptor {
  const files = describeEditFiles(
    base.toolName.toLowerCase(),
    part.input,
    part.output ?? null
  )
  let additions = 0
  let deletions = 0
  let counted = false
  for (const file of files) {
    if (file.additions !== null) {
      additions += file.additions
      counted = true
    }
    if (file.deletions !== null) {
      deletions += file.deletions
      counted = true
    }
  }
  const live = base.status === "running" || base.status === "pending"
  return {
    ...base,
    files,
    target: files.length === 1 ? pathTarget(files[0]!.path) : null,
    metric:
      counted && !live && (additions > 0 || deletions > 0)
        ? { kind: "diff", additions, deletions }
        : null,
  }
}

function describeMcp(
  part: AdaptedToolCallPart,
  payload: Payload,
  base: ToolDescriptor
): ToolDescriptor {
  const identity = mcpIdentityOf(part)
  const clineArgs =
    normalizeToolName(part.toolName) === "tool" && payload.parsed
      ? (payload.parsed.arguments ?? null)
      : null
  const argsSource =
    clineArgs === null
      ? part.input
      : typeof clineArgs === "string"
        ? clineArgs
        : JSON.stringify(clineArgs)
  const argument = mcpArgumentPreview(argsSource)
  const result =
    base.status === "succeeded"
      ? mcpResultLabel(mcpResultPayload(part.output ?? null))
      : null
  const detail = [argument, result].filter(Boolean).join(" · ") || null
  return {
    ...base,
    mcp: identity,
    target: identity ? { text: identity.tool } : null,
    detail,
  }
}

function genericName(part: AdaptedToolCallPart, normalized: string): string {
  const lower = normalized.toLowerCase()
  // `tool` / `task` are catch-all normalizations; the raw name says more.
  if (lower === "tool" || lower === "task" || lower === "lsp") {
    return part.toolName.trim() || normalized
  }
  return normalized
}

function describeTodo(payload: Payload, base: ToolDescriptor): ToolDescriptor {
  const name = base.toolName.toLowerCase()
  if (name === "todowrite") {
    const todos = payload.parsed?.todos
    if (Array.isArray(todos)) {
      const done = todos.filter(
        (t) =>
          !!t &&
          typeof t === "object" &&
          (t as Record<string, unknown>).status === "completed"
      ).length
      return { ...base, detail: `${done}/${todos.length}` }
    }
    return base
  }
  if (name === "taskcreate") {
    const subject = payload.field("subject")
    return subject ? { ...base, target: textTarget(subject, 60) } : base
  }
  if (name === "taskupdate") {
    const id = payload.field("taskId")
    const status = payload.field("status")
    return id
      ? {
          ...base,
          target: { text: `#${id}` },
          detail: status ?? null,
        }
      : base
  }
  return base
}

function describeUncached(part: AdaptedToolCallPart): ToolDescriptor {
  const kind = toolStepKind(part)
  const toolName = normalizeToolName(part.toolName)
  const status = toolCallStatus(part)
  const base = {
    ...emptyDescriptor(kind, toolName, status),
    approval: approvalFromMeta(part.meta),
  }
  const payload = payloadOf(part)

  switch (kind) {
    case "command":
      return describeCommand(part, payload, base)
    case "shell-session":
      return describeShellSession(part, base)
    case "script":
      return describeScript(part, base)
    case "read": {
      const path = filePathOf(payload)
      return {
        ...base,
        target: path ? pathTarget(path) : null,
        detail: readRange(payload.parsed),
        notes: readNotes(payload.parsed),
        metric:
          status === "succeeded" && part.output
            ? lineMetric(readLineCount(part.output))
            : null,
      }
    }
    case "search":
    case "glob":
    case "list": {
      const pattern = payload.field("pattern") ?? payload.field("query")
      const path = payload.field("path")
      const target = pattern
        ? textTarget(pattern, 60)
        : path
          ? pathTarget(path)
          : null
      const text = searchResultText(
        toolName.toLowerCase(),
        part.output,
        part.errorText
      )
      // grep's exit 1 means "found nothing", which codex reports as a failed
      // call carrying its no-match envelope (`searchResultText` reads that as
      // ""): an empty result, not a failure.
      const settled = status === "failed" && text === "" ? "succeeded" : status
      return {
        ...base,
        kind: kind === "glob" && !pattern && path ? "list" : kind,
        status: settled,
        target,
        detail: pattern && path ? shortPath(path) : null,
        metric:
          settled === "succeeded"
            ? searchMetric(summarizeSearchResult(text))
            : null,
      }
    }
    case "fetch": {
      const url = payload.field("url")
      const offset = payload.parsed ? num(payload.parsed, "offset") : undefined
      return {
        ...base,
        target: url ? textTarget(url.replace(/^https?:\/\//, ""), 60) : null,
        // Claude Code's WebFetch reads on past its page window from here.
        notes:
          offset !== undefined && offset > 0
            ? [{ kind: "offset", value: offset }]
            : [],
      }
    }
    case "web-search": {
      const query = payload.field("query")
      return { ...base, target: query ? textTarget(query, 60) : null }
    }
    case "memory": {
      const title = extractClaudeCodeMetaTitle(part.meta)
      return { ...base, detail: title }
    }
    case "edit":
      return describeEdit(part, base)
    case "mcp":
      return describeMcp(part, payload, base)
    case "skill": {
      const name =
        extractClaudeCodeSkillName(part.meta) ??
        payload.field("skill") ??
        payload.field("name")
      return { ...base, target: name ? { text: name } : null }
    }
    case "todo":
      return describeTodo(payload, base)
    case "completion": {
      const result = payload.field("result")
      const firstLine = result?.split("\n")[0]?.trim()
      return {
        ...base,
        target: firstLine ? textTarget(firstLine, 80) : null,
      }
    }
    case "generic": {
      const name = genericName(part, toolName)
      const detail =
        firstMeaningfulArgument(payload.parsed) ??
        extractClaudeCodeMetaTitle(part.meta)
      return {
        ...base,
        target: { text: name },
        detail: detail && detail !== name ? detail : null,
      }
    }
    default:
      return base
  }
}

function lineMetric(lines: number | null): ToolMetric | null {
  return lines !== null ? { kind: "lines", count: lines } : null
}

const cache = new WeakMap<AdaptedToolCallPart, ToolDescriptor>()

/**
 * Describe one tool call. Cached per part object: settled turns keep their part
 * references across renders (the per-turn adapter cache and the merged-run
 * cache pin them), so their descriptors are computed once.
 */
export function describeToolCall(part: AdaptedToolCallPart): ToolDescriptor {
  const cached = cache.get(part)
  if (cached) return cached
  const descriptor = describeUncached(part)
  cache.set(part, descriptor)
  return descriptor
}
