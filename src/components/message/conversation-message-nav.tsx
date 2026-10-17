"use client"

import { memo, useCallback, useState } from "react"
import { ChevronRight, FileIcon, Loader2, RotateCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import type { FileChangeStat } from "@/lib/session-files"
import {
  CommitFileAdditions,
  CommitFileDeletions,
} from "@/components/ai-elements/commit"
import {
  fileNameOf,
  isRemovedFileDiff,
  normalizeSlashPath,
  toFolderRelativePath,
} from "@/lib/file-path-display"
import { cn } from "@/lib/utils"

/** One navigable user message. Present for every user turn, even when it made
 *  no file edits (`hasChanges === false`) so the list is a complete index —
 *  including the messages above the loaded window of a long conversation. */
export interface MessageNavEntry {
  /** Index into the rendered `threadItems` array — fed to `scrollToIndex`.
   *  Null for a message above the loaded window. */
  threadIndex: number | null
  /** Global turn index of a message above the loaded window (what paging it
   *  in needs); null for a loaded one. */
  turnIndex: number | null
  turnId: string
  /** 1-based position among the conversation's user messages. */
  ordinal: number
  label: string
  additions: number
  deletions: number
  files: FileChangeStat[]
  hasChanges: boolean
}

interface MessageNavListProps {
  /** Per-message rows, in conversation order. */
  entries: readonly MessageNavEntry[]
  /** Jump to a message: the transcript scrolls to a loaded one, or pages one
   *  above the loaded window in first. */
  onSelect: (entry: MessageNavEntry) => void
  /** The message being paged in for a jump, if any. */
  revealingTurnId?: string | null
  /** The messages above the loaded window aren't listed yet: their outline
   *  is loading, or failed to (offering `onRetryEarlier`). */
  earlier?: "loading" | "error" | null
  onRetryEarlier?: () => void
}

/**
 * The message navigator of a conversation, shown in the Session Details side
 * panel: one row per user message with its `+N/-N` and an expandable list of
 * the files it changed (clicking a file opens its diff in the main editor via
 * `openSessionFileDiff`).
 *
 * A long conversation loads its messages a window at a time; the list still
 * covers all of them, and a message above the window is paged in when it is
 * clicked (`onSelect`). Rows are memoized on their entry, which the insights
 * store keeps by identity while it is unchanged — so a streaming reply that
 * edits no file re-renders none of them.
 */
export const MessageNavList = memo(function MessageNavList({
  entries,
  onSelect,
  revealingTurnId = null,
  earlier = null,
  onRetryEarlier,
}: MessageNavListProps) {
  const t = useTranslations("Folder.chat.messageNav")
  const { openSessionFileDiff } = useWorkspaceActions()
  const { activeFolder: folder } = useActiveFolder()
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const handleFileClick = useCallback(
    (
      filePath: string,
      diff: string | null,
      ordinal: number,
      changeIndex: number
    ) => {
      openSessionFileDiff(
        filePath,
        diff ?? t("noDiffDataAvailable", { filePath }),
        `msg-${ordinal}-chg-${changeIndex + 1}`
      )
    },
    [openSessionFileDiff, t]
  )
  const toggleGroup = useCallback((turnId: string) => {
    setOpenGroups((prev) => ({ ...prev, [turnId]: !(prev[turnId] ?? false) }))
  }, [])

  return (
    <div className="space-y-1.5">
      {earlier === "loading" && (
        <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span className="min-w-0 truncate">{t("loadingEarlier")}</span>
        </div>
      )}
      {earlier === "error" && (
        <button
          type="button"
          onClick={onRetryEarlier}
          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-2 text-start text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        >
          <RotateCw className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{t("loadEarlier")}</span>
        </button>
      )}
      {entries.map((entry) => (
        <MessageNavRow
          key={entry.turnId}
          entry={entry}
          isOpen={openGroups[entry.turnId] ?? false}
          isRevealing={revealingTurnId === entry.turnId}
          folderPath={folder?.path}
          onSelect={onSelect}
          onToggleOpen={toggleGroup}
          onFileClick={handleFileClick}
        />
      ))}
    </div>
  )
})

const MessageNavRow = memo(function MessageNavRow({
  entry,
  isOpen,
  isRevealing,
  folderPath,
  onSelect,
  onToggleOpen,
  onFileClick,
}: {
  entry: MessageNavEntry
  isOpen: boolean
  isRevealing: boolean
  folderPath: string | undefined
  onSelect: (entry: MessageNavEntry) => void
  onToggleOpen: (turnId: string) => void
  onFileClick: (
    filePath: string,
    diff: string | null,
    ordinal: number,
    changeIndex: number
  ) => void
}) {
  const t = useTranslations("Folder.chat.messageNav")
  const uniqueFileCount = new Set(
    entry.files.map((file) => normalizeSlashPath(file.path))
  ).size

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-transparent text-card-foreground">
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => onSelect(entry)}
          aria-busy={isRevealing || undefined}
          className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-2 text-start transition-colors hover:bg-accent/40"
        >
          <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted/40 px-1 text-3xs tabular-nums text-muted-foreground">
            {isRevealing && (
              <Loader2 aria-hidden="true" className="size-2.5 animate-spin" />
            )}
            #{entry.ordinal}
          </span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-xs leading-5 text-foreground">
              {entry.label}
            </span>
            {entry.hasChanges && (
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-3xs text-muted-foreground">
                  {t("fileCount", { count: uniqueFileCount })}
                </span>
                {/* Always render BOTH counts (incl. zeros) so a one-sided
                    change still shows its +N and -N. */}
                <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-3xs">
                  <span className="text-green-600 dark:text-green-400">
                    +{entry.additions}
                  </span>
                  <span className="text-red-600 dark:text-red-400">
                    -{entry.deletions}
                  </span>
                </span>
              </span>
            )}
          </span>
        </button>

        {entry.hasChanges && (
          <button
            type="button"
            aria-label={t("fileCount", { count: uniqueFileCount })}
            aria-expanded={isOpen}
            onClick={() => onToggleOpen(entry.turnId)}
            className="flex w-7 shrink-0 items-center justify-center border-s border-border text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                isOpen ? "rotate-90" : "rtl:rotate-180"
              )}
            />
          </button>
        )}
      </div>

      {entry.hasChanges && isOpen && (
        <ul className="space-y-1 border-t border-border p-2">
          {entry.files.map((file, fileIndex) => {
            const displayPath = toFolderRelativePath(file.path, folderPath)
            const isRemoved = isRemovedFileDiff(file.diff)

            return (
              <li key={file.id}>
                <button
                  type="button"
                  onClick={() =>
                    onFileClick(file.path, file.diff, entry.ordinal, fileIndex)
                  }
                  title={displayPath}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-start transition-colors",
                    isRemoved
                      ? "border-destructive/30 bg-destructive/10 hover:bg-destructive/20"
                      : "border-border bg-transparent hover:bg-accent/40"
                  )}
                >
                  <FileIcon
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      isRemoved ? "text-destructive" : "text-muted-foreground"
                    )}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs",
                      isRemoved ? "text-destructive" : "text-foreground"
                    )}
                  >
                    {fileNameOf(displayPath)}
                  </span>
                  {isRemoved ? (
                    <span className="inline-flex shrink-0 items-center rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 font-mono text-3xs text-destructive">
                      {t("remove")}
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-3xs text-foreground">
                      <CommitFileAdditions
                        count={file.additions}
                        className="text-3xs"
                      />
                      <CommitFileDeletions
                        count={file.deletions}
                        className="text-3xs"
                      />
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
})
