"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn, copyTextToClipboard } from "@/lib/utils"

/**
 * The one container every row's detail goes in: a tinted, rounded panel whose
 * body scrolls past a fixed height (fading out at an edge with more beyond
 * it), with an optional footer — a line count on the start side, copy actions
 * on the end side.
 *
 * `anchor="end"` opens scrolled to the bottom and stays there while content
 * streams in (a failing test run's summary is at the end); the default opens
 * at the top.
 */
export function DetailBox({
  children,
  tone = "neutral",
  anchor = "start",
  footer,
  actions,
  className,
  bodyClassName,
  unbounded = false,
}: {
  children: ReactNode
  tone?: "neutral" | "danger" | "plain"
  anchor?: "start" | "end"
  /** Start-side footer text, e.g. "12 lines". */
  footer?: ReactNode
  /** End-side footer actions (copy buttons). */
  actions?: ReactNode
  className?: string
  bodyClassName?: string
  /** No height cap — for content that manages its own (a diff). */
  unbounded?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [overflow, setOverflow] = useState<"none" | "start" | "end" | "both">(
    "none"
  )

  const measure = useCallback(() => {
    const node = scrollRef.current
    if (!node) return
    const above = node.scrollTop > 1
    const below = node.scrollTop + node.clientHeight < node.scrollHeight - 1
    setOverflow(
      above && below ? "both" : above ? "start" : below ? "end" : "none"
    )
  }, [])

  // Only the open panel is mounted, so only it pays for observing its size.
  useEffect(() => {
    const node = scrollRef.current
    if (!node || unbounded || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (node.firstElementChild) observer.observe(node.firstElementChild)
    return () => observer.disconnect()
  }, [measure, unbounded])

  const stickToEnd = useRef(anchor === "end")
  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node || !stickToEnd.current) return
    node.scrollTop = node.scrollHeight
  })

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[0.625rem]",
        tone === "neutral" && "bg-activity-surface ws-msg-card",
        tone === "danger" && "bg-tone-danger-surface",
        tone === "plain" && "border border-border bg-background ws-msg-card",
        className
      )}
    >
      <div
        ref={scrollRef}
        className={cn(
          "activity-detail-scroll overflow-auto",
          !unbounded && "max-h-72",
          bodyClassName
        )}
        data-overflow={overflow === "none" ? undefined : overflow}
        onScroll={() => {
          const node = scrollRef.current
          if (node && anchor === "end") {
            stickToEnd.current =
              node.scrollTop + node.clientHeight >= node.scrollHeight - 4
          }
          measure()
        }}
      >
        <div>{children}</div>
      </div>
      {footer || actions ? (
        <div
          className={cn(
            "activity-mono flex min-h-7 items-center gap-3 border-t px-4 text-xs text-muted-foreground",
            tone === "danger" ? "border-tone-danger/15" : "border-foreground/5"
          )}
        >
          <span className="min-w-0 truncate tabular-nums">{footer}</span>
          {actions ? (
            <span className="ms-auto flex shrink-0 items-center gap-3">
              {actions}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A footer action that copies text and briefly confirms it. */
export function CopyAction({
  text,
  label,
}: {
  text: string | (() => string)
  label: string
}) {
  const t = useTranslations("Folder.chat.activity")
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={async () => {
        const ok = await copyTextToClipboard(
          typeof text === "function" ? text() : text
        )
        if (!ok) return
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-3" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-3" />
      )}
      {copied ? t("detail.copied") : label}
    </button>
  )
}
