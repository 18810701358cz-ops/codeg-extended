import { fsSeparator } from "@/lib/path-utils"

/**
 * Shorten an absolute path to its last 2 segments. Agents running on Windows
 * report backslash paths (`C:\work\repo\src\a.ts`), so both separators have to
 * split — otherwise the tool title fell back to the whole path — and the
 * shortened form is rejoined with the path's own separator rather than mixing
 * the two.
 */
export function shortPath(p: string): string {
  const segments = p.split(/[\\/]/)
  if (segments.length <= 2) return p
  return segments.slice(-2).join(fsSeparator(p))
}

/** Truncate text to maxLen, appending "…" if truncated. */
export function ellipsis(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s
}

/**
 * A path split for display as a muted directory and a prominent file name:
 * `agent/src/hvac_agent/query_tasks.py` → `{ dir: "agent/src/hvac_agent/",
 * name: "query_tasks.py" }`. The directory keeps its trailing separator so the
 * two halves concatenate back to the input. Either separator splits, for the
 * same Windows reason as `shortPath`.
 */
export function splitPathForDisplay(path: string): {
  dir: string
  name: string
} {
  const trimmed = path.replace(/[\\/]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  if (index < 0) return { dir: "", name: trimmed }
  return { dir: trimmed.slice(0, index + 1), name: trimmed.slice(index + 1) }
}

/** Number of lines in a block of text, not counting one trailing newline. */
export function countLines(text: string): number {
  if (!text) return 0
  let count = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++
  }
  return text.endsWith("\n") ? count - 1 : count
}
