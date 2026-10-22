/**
 * File-edit payload readers: which files an edit touched, how many lines it
 * added and removed, and — when the agent reported real hunk positions — which
 * lines changed. Edit payloads come in four shapes: codex's `*** Begin Patch`
 * text, Claude Code's `{file_path, old_string, new_string}`, codex's
 * `{changes: {<path>: …}}` map, and a plain unified diff.
 */

import {
  countUnifiedDiffLineChanges,
  estimateChangedLineStats,
  splitNormalizedLines,
} from "@/lib/line-change-stats"
import {
  commandFromUnknownValue,
  extractCommandFromUnknownInput,
} from "./command"
import { aliasToolInputKeys } from "@/lib/tool-call-normalization"
import { countLines } from "./format"
import {
  asObjectLike,
  decodeJsonEscapedString,
  findObjectFieldDeep,
  findStringFieldDeep,
  num,
  str,
  tryParseJson,
} from "./json"

export type ApplyPatchOp = "add" | "update" | "delete" | "move"

export type ApplyPatchFile = {
  op: ApplyPatchOp
  path: string
  from?: string
  to?: string
}

export type LineChangeStats = {
  additions: number
  deletions: number
}

interface ApplyPatchFileStats extends ApplyPatchFile {
  additions: number
  deletions: number
}

function parseApplyPatchDetailed(input: string): {
  files: ApplyPatchFileStats[]
  additions: number
  deletions: number
} {
  const files: ApplyPatchFileStats[] = []
  let currentFileIndex = -1
  let additions = 0
  let deletions = 0

  for (const line of input.split("\n")) {
    if (line.startsWith("*** Add File: ")) {
      files.push({
        op: "add",
        path: line.slice(14).trim(),
        additions: 0,
        deletions: 0,
      })
      currentFileIndex = files.length - 1
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      files.push({
        op: "update",
        path: line.slice(17).trim(),
        additions: 0,
        deletions: 0,
      })
      currentFileIndex = files.length - 1
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      files.push({
        op: "delete",
        path: line.slice(17).trim(),
        additions: 0,
        deletions: 0,
      })
      currentFileIndex = files.length - 1
      continue
    }
    if (line.startsWith("*** Move to: ")) {
      const to = line.slice(13).trim()
      if (currentFileIndex >= 0) {
        const current = files[currentFileIndex]
        files[currentFileIndex] = {
          ...current,
          op: "move",
          path: `${current.path} -> ${to}`,
          from: current.path,
          to,
        }
      }
      continue
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1
      if (currentFileIndex >= 0) files[currentFileIndex].additions += 1
      continue
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1
      if (currentFileIndex >= 0) files[currentFileIndex].deletions += 1
    }
  }

  return { files, additions, deletions }
}

export function parseApplyPatchInput(input: string): {
  files: ApplyPatchFile[]
  additions: number
  deletions: number
} {
  const detailed = parseApplyPatchDetailed(input)
  return {
    files: detailed.files.map((file) => {
      const plain: ApplyPatchFile = { op: file.op, path: file.path }
      if (file.from !== undefined) plain.from = file.from
      if (file.to !== undefined) plain.to = file.to
      return plain
    }),
    additions: detailed.additions,
    deletions: detailed.deletions,
  }
}

function hasLineChanges(
  stats: LineChangeStats | null | undefined
): stats is LineChangeStats {
  return !!stats && (stats.additions > 0 || stats.deletions > 0)
}

export function looksLikeDiffPayload(input: string): boolean {
  if (!input.trim()) return false
  const normalized = unescapeInlineEscapes(input)

  return (
    normalized.includes("*** Begin Patch") ||
    normalized.includes("*** Update File:") ||
    /^diff --git /m.test(normalized) ||
    (/^--- .+/m.test(normalized) && /^\+\+\+ .+/m.test(normalized)) ||
    /^@@ /m.test(normalized)
  )
}

export function extractEditLineChangeStats(
  input: string | null | undefined
): LineChangeStats | null {
  if (!input || input.trim().length === 0) return null

  const parsed = tryParseJson(input)
  const patchInput = extractApplyPatchTextFromUnknownInput(input, parsed)
  if (patchInput) {
    const patchStats = parseApplyPatchInput(patchInput)
    const stats = {
      additions: patchStats.additions,
      deletions: patchStats.deletions,
    }
    if (hasLineChanges(stats)) return stats
  }

  if (parsed) {
    const changesPayload = extractEditChangesPayload(parsed)
    if (changesPayload.length > 0) {
      let additions = 0
      let deletions = 0

      for (const change of changesPayload) {
        if (change.unifiedDiff && change.unifiedDiff.trim().length > 0) {
          const diffStats = countUnifiedDiffLineChanges(change.unifiedDiff)
          additions += diffStats.additions
          deletions += diffStats.deletions
          continue
        }

        const estimated = estimateChangedLineStats(
          change.oldText,
          change.newText
        )
        additions += estimated.additions
        deletions += estimated.deletions
      }

      const stats = { additions, deletions }
      if (hasLineChanges(stats)) return stats
    }

    if (isCanonicalEditPayload(parsed)) {
      const oldString =
        str(parsed, "old_string") ?? str(parsed, "old_text") ?? ""
      const newString =
        str(parsed, "new_string") ?? str(parsed, "new_text") ?? ""
      const stats = estimateChangedLineStats(oldString, newString)
      if (hasLineChanges(stats)) return stats
    }

    const parsedDiff =
      findStringFieldDeep(parsed, "unified_diff") ??
      findStringFieldDeep(parsed, "unifiedDiff") ??
      findStringFieldDeep(parsed, "patch") ??
      findStringFieldDeep(parsed, "diff")
    if (parsedDiff && looksLikeDiffPayload(parsedDiff)) {
      const stats = countUnifiedDiffLineChanges(
        unescapeInlineEscapes(parsedDiff)
      )
      if (hasLineChanges(stats)) return stats
    }
  }

  if (looksLikeDiffPayload(input)) {
    const stats = countUnifiedDiffLineChanges(unescapeInlineEscapes(input))
    if (hasLineChanges(stats)) return stats
  }

  return null
}

export function unescapeInlineEscapes(text: string): string {
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
}

export function extractApplyPatchTextFromUnknownInput(
  input: string,
  parsed: Record<string, unknown> | null
): string | null {
  const candidates: string[] = [input]
  const parsedCommand = parsed ? commandFromUnknownValue(parsed) : null
  if (parsedCommand) candidates.push(parsedCommand)

  const fallbackCommand = extractCommandFromUnknownInput(input)
  if (fallbackCommand) candidates.push(fallbackCommand)

  const seen = new Set<string>()

  for (const rawCandidate of candidates) {
    const candidate = rawCandidate.trim()
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)

    const variants = [candidate]
    const unescaped = unescapeInlineEscapes(candidate)
    if (unescaped !== candidate) variants.push(unescaped)

    for (const variant of variants) {
      if (!variant.includes("*** Begin Patch")) continue

      const block = variant.match(
        /(\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch(?:\n|$))/m
      )?.[1]

      if (block) return block.trim()
      return variant.trim()
    }
  }

  return null
}

export function parseApplyPatchFilesFromUnknownInput(
  input: string,
  parsed: Record<string, unknown> | null
): ApplyPatchFile[] {
  const patchText = extractApplyPatchTextFromUnknownInput(input, parsed)
  if (patchText) {
    const fromPatchText = parseApplyPatchInput(patchText)
    if (fromPatchText.files.length > 0) return fromPatchText.files
  }

  const direct = parseApplyPatchInput(input)
  if (direct.files.length > 0) return direct.files

  const unescaped = unescapeInlineEscapes(input)
  if (unescaped !== input) {
    const normalized = parseApplyPatchInput(unescaped)
    if (normalized.files.length > 0) return normalized.files
  }

  return []
}

export function isCanonicalEditPayload(
  parsed: Record<string, unknown>
): boolean {
  return (
    typeof parsed.file_path === "string" ||
    typeof parsed.path === "string" ||
    typeof parsed.old_string === "string" ||
    typeof parsed.new_string === "string" ||
    parsed.replace_all === true
  )
}

export type EditChangePreview = {
  path: string
  oldText: string
  newText: string
  unifiedDiff?: string
}

const EDIT_CHANGE_OLD_KEYS = [
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "old",
  "previous",
  "before",
  "source",
  "original",
]

const EDIT_CHANGE_NEW_KEYS = [
  "new_string",
  "newString",
  "new_text",
  "newText",
  "new_content",
  "newContent",
  "new",
  "new_value",
  "newValue",
  "replacement",
  "after",
  "after_text",
  "afterText",
  "updated",
  "updated_text",
  "updatedText",
  "content",
  "new_source",
  "newSource",
  "text",
]

const EDIT_CHANGE_DIFF_KEYS = ["diff", "patch", "unified_diff", "unifiedDiff"]

function collectLikelyChangeStrings(value: Record<string, unknown>): string[] {
  const entries = Object.entries(value).filter(
    ([, v]) => typeof v === "string" && v.length > 0
  ) as Array<[string, string]>
  if (entries.length === 0) return []

  const preferred = entries
    .filter(([key]) =>
      /(old|new|before|after|content|text|source|replace|value)/i.test(key)
    )
    .map(([, v]) => v)

  if (preferred.length > 0) return preferred

  return entries
    .filter(
      ([key]) =>
        !/^(id|status|type|call_id|callId|source|auto_approved)$/i.test(key)
    )
    .map(([, v]) => v)
}

function firstStringField(
  value: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const field = value[key]
    if (typeof field === "string") {
      return field
    }
  }
  return null
}

function parseEditChangeValue(
  path: string,
  value: unknown
): EditChangePreview | null {
  if (typeof value === "string") {
    return {
      path,
      oldText: "",
      newText: value,
    }
  }

  const record = asObjectLike(value)
  if (!record) return null

  const oldText =
    firstStringField(record, EDIT_CHANGE_OLD_KEYS) ??
    findStringFieldDeep(record, "old_string") ??
    findStringFieldDeep(record, "old_text") ??
    findStringFieldDeep(record, "before_text") ??
    findStringFieldDeep(record, "old") ??
    ""
  const newText =
    firstStringField(record, EDIT_CHANGE_NEW_KEYS) ??
    findStringFieldDeep(record, "new_string") ??
    findStringFieldDeep(record, "new_text") ??
    findStringFieldDeep(record, "after_text") ??
    findStringFieldDeep(record, "new") ??
    ""
  const unifiedDiff =
    firstStringField(record, EDIT_CHANGE_DIFF_KEYS) ??
    findStringFieldDeep(record, "diff") ??
    ""

  if (unifiedDiff) {
    return {
      path,
      oldText,
      newText,
      unifiedDiff,
    }
  }

  if (oldText || newText) {
    return {
      path,
      oldText,
      newText,
    }
  }

  const fallbackStrings = collectLikelyChangeStrings(record)
  if (fallbackStrings.length >= 2) {
    return {
      path,
      oldText: fallbackStrings[0],
      newText: fallbackStrings[1],
    }
  }

  if (fallbackStrings.length === 1) {
    return {
      path,
      oldText: "",
      newText: fallbackStrings[0],
    }
  }

  return {
    path,
    oldText: "",
    newText: "",
  }
}

export function extractEditChangesPayload(
  parsed: Record<string, unknown>
): EditChangePreview[] {
  const changes = findObjectFieldDeep(parsed, "changes")
  if (!changes) return []

  const items: EditChangePreview[] = []
  for (const [path, value] of Object.entries(changes)) {
    const normalizedPath = path.trim()
    if (!normalizedPath) continue
    const parsedItem = parseEditChangeValue(normalizedPath, value)
    if (parsedItem) {
      items.push(parsedItem)
    }
  }

  return items
}

export function extractEditPathsFromChangesPayload(
  input: string,
  parsed: Record<string, unknown> | null
): string[] {
  const changes = findObjectFieldDeep(parsed, "changes")
  if (changes) {
    const paths = Object.keys(changes)
      .map((path) => path.trim())
      .filter((path) => path.length > 0)
    if (paths.length > 0) return paths
  }

  const firstPathMatch = input.match(/"changes"\s*:\s*\{\s*"((?:[^"\\]|\\.)+)"/)
  if (!firstPathMatch?.[1]) return []

  return [decodeJsonEscapedString(firstPathMatch[1])]
}

export function extractPathFromDiffText(
  text: string | null | undefined
): string | null {
  if (!text) return null
  const match = text.match(/^(?:---|\+\+\+)\s+([^\n]+)$/m)
  if (!match?.[1]) return null
  const raw = match[1].trim()
  if (!raw || raw === "/dev/null") return null
  return raw.replace(/^[ab]\//, "")
}

// ── per-file description (activity rows) ──────────────────────────────────

export type EditFileOp = "add" | "update" | "delete" | "move" | "write"

export interface EditFileChange {
  /** The file as it stands after the edit (a move's destination). */
  path: string
  /** A move's source path. */
  fromPath?: string
  op: EditFileOp
  /** Null when the payload does not say (a notebook cell edit, a bare path). */
  additions: number | null
  deletions: number | null
  /**
   * First and last line of the new file the edit changed — only when the
   * payload carried real positions (a unified diff's hunk headers, or the
   * `_start_line` the backend injects). Never estimated.
   */
  lineRange: { start: number; end: number } | null
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * The span of new-file lines a unified diff changed. Walks each hunk with its
 * own numbering, so context lines around the change are excluded: a 3-line
 * context hunk at `+40,7` that adds lines 43–44 reports 43–44, not 40–46. A
 * pure deletion reports the line the removed text used to precede.
 */
export function changedLineRangeFromUnifiedDiff(
  diff: string
): { start: number; end: number } | null {
  let start = Number.POSITIVE_INFINITY
  let end = 0
  let newLine = 0
  let inHunk = false
  let oldRemaining = 0
  let newRemaining = 0
  for (const line of diff.split("\n")) {
    const header = HUNK_HEADER_RE.exec(line)
    if (header) {
      newLine = Number(header[3])
      oldRemaining = header[2] === undefined ? 1 : Number(header[2])
      newRemaining = header[4] === undefined ? 1 : Number(header[4])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (oldRemaining <= 0 && newRemaining <= 0) {
      inHunk = false
      continue
    }
    if (line.startsWith("\\")) continue
    if (line.startsWith("+")) {
      start = Math.min(start, newLine)
      end = Math.max(end, newLine)
      newLine += 1
      newRemaining -= 1
    } else if (line.startsWith("-")) {
      start = Math.min(start, newLine)
      end = Math.max(end, newLine)
      oldRemaining -= 1
    } else {
      newLine += 1
      oldRemaining -= 1
      newRemaining -= 1
    }
  }
  if (!Number.isFinite(start) || start <= 0) return null
  return { start, end: Math.max(start, end) }
}

/**
 * The changed new-file lines of an `old_string → new_string` replacement whose
 * old text starts at `startLine`: common leading lines are not part of the
 * change, so they move the start down.
 */
function changedRangeFromReplacement(
  oldText: string,
  newText: string,
  startLine: number
): { start: number; end: number } | null {
  if (!Number.isInteger(startLine) || startLine <= 0) return null
  const oldLines = splitNormalizedLines(oldText)
  const newLines = splitNormalizedLines(newText)
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const changedNew = newLines.length - prefix - suffix
  const start = startLine + prefix
  return { start, end: start + Math.max(changedNew, 1) - 1 }
}

function unifiedDiffFiles(diff: string): string[] {
  const paths: string[] = []
  for (const match of diff.matchAll(/^\+\+\+ ([^\n]+)$/gm)) {
    const raw = match[1]!.trim()
    if (!raw || raw === "/dev/null") continue
    paths.push(raw.replace(/^[ab]\//, ""))
  }
  return paths
}

function changeFromUnifiedDiff(path: string, diff: string): EditFileChange {
  const stats = countUnifiedDiffLineChanges(diff)
  const removed = /^\+\+\+ \/dev\/null$/m.test(diff)
  const added = /^--- \/dev\/null$/m.test(diff)
  return {
    path,
    op: removed ? "delete" : added ? "add" : "update",
    additions: stats.additions,
    deletions: stats.deletions,
    lineRange: removed ? null : changedLineRangeFromUnifiedDiff(diff),
  }
}

/**
 * Every file an edit-like tool call touched, with its line counts and changed
 * span. `toolName` is the normalized name (`edit`, `write`, `apply_patch`,
 * `notebookedit`); `output` is consulted for the unified diff some parsers put
 * there (Claude Code's history rebuilds one from `structuredPatch`, with real
 * line numbers).
 */
export function describeEditFiles(
  toolName: string,
  input: string | null,
  output: string | null
): EditFileChange[] {
  const raw = input ?? ""
  // OpenCode's live stream spells the arguments in camelCase.
  const parsed = aliasToolInputKeys(raw ? tryParseJson(raw) : null)

  const patchText = raw
    ? extractApplyPatchTextFromUnknownInput(raw, parsed)
    : null
  // The patch may arrive with its newlines still JSON-escaped (a patch string
  // nested in a JSON envelope the extractor could not unwrap), so the
  // unescaped form is tried too — as `parseApplyPatchFilesFromUnknownInput`
  // does for the legacy card title.
  const patchCandidates = patchText
    ? [patchText, unescapeInlineEscapes(patchText)]
    : []
  for (const candidate of patchCandidates) {
    const detailed = parseApplyPatchDetailed(candidate)
    if (detailed.files.length > 0) {
      return detailed.files.map((file) => ({
        path: file.op === "move" && file.to ? file.to : file.path,
        ...(file.op === "move" && file.from ? { fromPath: file.from } : {}),
        op: file.op,
        additions: file.additions,
        deletions: file.deletions,
        lineRange: null,
      }))
    }
  }

  if (parsed) {
    const changes = extractEditChangesPayload(parsed)
    if (changes.length > 0) {
      return changes.map((change) => {
        if (change.unifiedDiff && change.unifiedDiff.trim().length > 0) {
          return changeFromUnifiedDiff(
            change.path,
            unescapeInlineEscapes(change.unifiedDiff)
          )
        }
        const stats = estimateChangedLineStats(change.oldText, change.newText)
        return {
          path: change.path,
          op: change.oldText ? "update" : "add",
          additions: stats.additions,
          deletions: stats.deletions,
          lineRange: null,
        }
      })
    }

    const filePath =
      str(parsed, "file_path") ??
      str(parsed, "path") ??
      str(parsed, "notebook_path") ??
      str(parsed, "filePath")
    if (filePath) {
      const outputDiff = output && /^@@ /m.test(output) ? output : null
      if (toolName === "write") {
        const content = str(parsed, "content") ?? str(parsed, "new_source")
        return [
          {
            path: filePath,
            op: "write",
            additions: content != null ? countLines(content) : null,
            deletions: null,
            lineRange: null,
          },
        ]
      }
      if (toolName === "notebookedit") {
        return [
          {
            path: filePath,
            op: "update",
            additions: null,
            deletions: null,
            lineRange: null,
          },
        ]
      }
      if (outputDiff) {
        return [
          { ...changeFromUnifiedDiff(filePath, outputDiff), path: filePath },
        ]
      }
      const oldText = str(parsed, "old_string") ?? str(parsed, "old_text")
      const newText = str(parsed, "new_string") ?? str(parsed, "new_text")
      if (oldText !== undefined || newText !== undefined) {
        const stats = estimateChangedLineStats(oldText ?? "", newText ?? "")
        const startLine = num(parsed, "_start_line")
        const multi = parsed.replace_all === true
        return [
          {
            path: filePath,
            op: "update",
            additions: stats.additions,
            deletions: stats.deletions,
            lineRange:
              startLine !== undefined && !multi
                ? changedRangeFromReplacement(
                    oldText ?? "",
                    newText ?? "",
                    startLine
                  )
                : null,
          },
        ]
      }
      const diffField =
        findStringFieldDeep(parsed, "unified_diff") ??
        findStringFieldDeep(parsed, "diff")
      if (diffField && looksLikeDiffPayload(diffField)) {
        return [
          {
            ...changeFromUnifiedDiff(
              filePath,
              unescapeInlineEscapes(diffField)
            ),
            path: filePath,
          },
        ]
      }
      return [
        {
          path: filePath,
          op: "update",
          additions: null,
          deletions: null,
          lineRange: null,
        },
      ]
    }
  }

  // A bare unified diff as input (or, for an edit with no readable input, as
  // output): one entry per `+++` file.
  for (const candidate of [raw, output ?? ""]) {
    if (!candidate || !looksLikeDiffPayload(candidate)) continue
    const diff = unescapeInlineEscapes(candidate)
    const paths = unifiedDiffFiles(diff)
    if (paths.length === 1) return [changeFromUnifiedDiff(paths[0]!, diff)]
    if (paths.length > 1) {
      return paths.map((path) => ({
        path,
        op: "update" as const,
        additions: null,
        deletions: null,
        lineRange: null,
      }))
    }
  }

  return []
}
