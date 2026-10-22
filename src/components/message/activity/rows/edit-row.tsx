"use client"

import { memo, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import {
  parseUnifiedDiff,
  type ParsedDiffFile,
} from "@/components/diff/unified-diff-preview"
import { FilePathLink } from "@/components/ai-elements/link-safety"
import { editDiffText } from "@/lib/activity/edit"
import { splitPathForDisplay } from "@/lib/activity/format"
import { cn } from "@/lib/utils"
import { useActivityRender } from "../activity-context"
import { ActivityRow } from "../activity-row"
import { DetailBox } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { RailIcon } from "../rail-icon"
import { ResultBody } from "../result-body"
import {
  DiffFigure,
  ToolFigure,
  toolIcon,
  useStatusText,
} from "../step-visuals"
import { useDisplayPath, type ToolStep } from "./explore-rows"

/** A diff past either bound opens as a preview of its first rows. */
const LARGE_DIFF_ROWS = 600
const LARGE_DIFF_CHARS = 80_000
const PREVIEW_ROWS = 240

/** `agent/src/hvac_agent/` muted, `query_tasks.py` prominent; the directory
 *  is what truncates. */
function PathLabel({ path }: { path: string }) {
  const { dir, name } = splitPathForDisplay(path)
  return (
    <span
      className="flex min-w-0 items-baseline font-mono text-[0.8125rem]"
      dir="ltr"
    >
      {dir ? (
        <span className="min-w-0 truncate text-muted-foreground">{dir}</span>
      ) : null}
      <span className="shrink-0 text-foreground">{name}</span>
    </span>
  )
}

/**
 * `Edited agent/src/hvac_agent/query_tasks.py L44–46   +3 −1`. The verb
 * follows the state (Editing while it runs, Created / Deleted / Moved for
 * those operations), counts appear once it has finished, and the line range
 * only when the payload carried real positions. Folded by default.
 */
export const EditRow = memo(function EditRow({ step }: { step: ToolStep }) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const { recoveredKeys } = useActivityRender()
  const { tool, part } = step
  const files = useMemo(() => tool.files ?? [], [tool.files])
  const single = files.length === 1 ? files[0]! : null
  const displayPath = useDisplayPath(single?.path)
  const failed = tool.status === "failed" || tool.status === "rejected"
  const live = tool.status === "running" || tool.status === "pending"
  const [open, setOpen] = useDisclosure(step.key, {
    defaultOpen: false,
    force:
      (failed && !recoveredKeys.has(step.key)) || tool.status === "awaiting",
  })
  const diff = useMemo(
    () => editDiffText(tool.toolName, part.input, part.output ?? null),
    [tool.toolName, part.input, part.output]
  )
  const errorText = failed ? (part.errorText ?? part.output ?? null) : null
  const expandable = !!diff || !!errorText?.trim()

  const verb = live
    ? t("row.editing")
    : single?.op === "add" || single?.op === "write"
      ? t("row.created")
      : single?.op === "delete"
        ? t("row.deleted")
        : single?.op === "move"
          ? t("row.moved")
          : t("row.edited")

  return (
    <ActivityRow
      stepKey={step.key}
      approval={step.tool.approval}
      status={tool.status}
      marker={
        <RailIcon
          icon={toolIcon(tool)}
          status={tool.status}
          label={`${t("kind.edit")}, ${statusText(tool.status)}`}
        />
      }
      expandable={expandable}
      expanded={open}
      onExpandedChange={setOpen}
      title={single?.path}
      trailing={<ToolFigure tool={tool} />}
      detail={() => (
        <div className="space-y-2">
          {errorText ? (
            <DetailBox tone="danger" anchor="end">
              <ResultBody text={errorText} tone="danger" />
            </DetailBox>
          ) : null}
          {diff ? (
            <EditDiff diffText={diff.text} numbered={diff.numbered} />
          ) : null}
        </div>
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 font-medium",
            live ? "activity-shimmer" : "text-foreground"
          )}
        >
          {single || files.length === 0
            ? verb
            : t("row.editedFiles", { count: files.length })}
        </span>
        {single ? (
          <>
            <PathLabel path={displayPath ?? single.path} />
            {single.lineRange && !live ? (
              <span
                className="shrink-0 font-mono text-[0.8125rem] text-muted-foreground"
                dir="ltr"
              >
                {single.lineRange.start === single.lineRange.end
                  ? t("metric.line", { line: single.lineRange.start })
                  : t("metric.lineRange", {
                      start: single.lineRange.start,
                      end: single.lineRange.end,
                    })}
              </span>
            ) : null}
          </>
        ) : null}
      </span>
    </ActivityRow>
  )
})

/**
 * The edit's diff in a bordered box: one line-number column (the old number
 * for a removed line, the new one otherwise — left blank where the payload
 * had no real positions), a sign column, and the code. Multi-file edits get a
 * header per file. Big diffs open as a preview.
 */
export const EditDiff = memo(function EditDiff({
  diffText,
  numbered,
}: {
  diffText: string
  numbered: boolean
}) {
  const t = useTranslations("Folder.chat.activity")
  const files = useMemo(() => parseUnifiedDiff(diffText), [diffText])
  const totalRows = useMemo(
    () =>
      files.reduce(
        (sum, file) =>
          sum + file.hunks.reduce((n, hunk) => n + hunk.rows.length, 0),
        0
      ),
    [files]
  )
  const large =
    totalRows > LARGE_DIFF_ROWS || diffText.length > LARGE_DIFF_CHARS
  const [showAll, setShowAll] = useState(false)
  const visibleFiles = useMemo(
    () => (large && !showAll ? limitDiffRows(files, PREVIEW_ROWS) : files),
    [files, large, showAll]
  )

  if (files.length === 0) {
    return (
      <DetailBox tone="plain">
        <ResultBody text={diffText} />
      </DetailBox>
    )
  }

  return (
    <DetailBox
      tone="plain"
      footer={
        large && !showAll ? t("detail.lines", { count: totalRows }) : null
      }
      actions={
        large && !showAll ? (
          <button
            type="button"
            className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setShowAll(true)}
          >
            {t("detail.showAll", { count: totalRows })}
          </button>
        ) : null
      }
    >
      <div
        className="min-w-full py-1 font-mono text-[0.78125rem] leading-relaxed"
        dir="ltr"
      >
        {visibleFiles.map((file) => (
          <DiffFileBlock
            key={file.key}
            file={file}
            showHeader={files.length > 1}
            numbered={numbered}
          />
        ))}
      </div>
    </DetailBox>
  )
})

/** The first `budget` rows of a diff, cut at hunk and file boundaries. */
function limitDiffRows(
  files: ParsedDiffFile[],
  budget: number
): ParsedDiffFile[] {
  const out: ParsedDiffFile[] = []
  let remaining = budget
  for (const file of files) {
    if (remaining <= 0) break
    const hunks: ParsedDiffFile["hunks"] = []
    for (const hunk of file.hunks) {
      if (remaining <= 0) break
      const rows = hunk.rows.slice(0, remaining)
      remaining -= rows.length
      hunks.push({ ...hunk, rows })
    }
    out.push({ ...file, hunks })
  }
  return out
}

function DiffFileBlock({
  file,
  showHeader,
  numbered,
}: {
  file: ParsedDiffFile
  showHeader: boolean
  numbered: boolean
}) {
  return (
    <div>
      {showHeader ? (
        <div className="flex items-center gap-2 border-y border-foreground/5 bg-muted/40 px-3 py-1 first:border-t-0">
          <FilePathLink
            filePath={file.path}
            className="min-w-0 truncate text-foreground"
          >
            {file.path}
          </FilePathLink>
          <DiffFigure
            additions={file.additions}
            deletions={file.deletions}
            className="ms-auto shrink-0 text-2xs"
          />
        </div>
      ) : null}
      {file.hunks.map((hunk, hunkIndex) => (
        <div
          key={hunk.key}
          className={cn(
            hunkIndex > 0 && "border-t border-dashed border-foreground/10"
          )}
        >
          {hunk.rows.map((row, index) => (
            <div
              key={index}
              className={cn(
                "flex",
                row.type === "added" && "bg-diff-added",
                row.type === "deleted" && "bg-diff-deleted"
              )}
            >
              <span className="w-11 shrink-0 select-none pe-2 text-end tabular-nums text-muted-foreground">
                {numbered
                  ? ((row.type === "deleted" ? row.oldLine : row.newLine) ?? "")
                  : ""}
              </span>
              <span
                className={cn(
                  "w-4 shrink-0 select-none text-center",
                  row.sign === "+" && "text-diff-added-fg",
                  row.sign === "-" && "text-diff-deleted-fg"
                )}
              >
                {row.sign === " " ? "" : row.sign === "-" ? "−" : row.sign}
              </span>
              <span className="flex-1 whitespace-pre pe-4">{row.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
