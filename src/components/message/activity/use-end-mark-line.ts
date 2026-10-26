"use client"

import { useLayoutEffect, type RefObject } from "react"

/** Set on a finished list's last row: how far above its bottom edge the end
 *  mark is centred (globals.css falls back to a footer's 0.875rem). */
const END_LINE = "--activity-end-line"

/**
 * Levels a finished list's end mark with the last line beside it. Where that
 * line is depends on how the last row draws its body — a panel's footer, a
 * group's last member, the end of a paragraph, a padded card or panel with no
 * footer — so it is measured: once the list is done (`reached`), on its last
 * row only, whenever the list changes size. A ResizeObserver reports after
 * layout, so the read forces none, and observing from a layout effect has the
 * first report land before the first paint, so the mark never jumps; where
 * nothing can be measured (no observer, no text to go by) the stylesheet's
 * offset stands.
 */
export function useEndMarkLine(
  listRef: RefObject<HTMLElement | null>,
  reached: boolean
) {
  useLayoutEffect(() => {
    const list = listRef.current
    if (!reached || !list || typeof ResizeObserver === "undefined") return
    let row: HTMLElement | null = null
    const measure = () => {
      const last = list.lastElementChild as HTMLElement | null
      if (row && row !== last) row.style.removeProperty(END_LINE)
      row = last
      if (!last) return
      const offset = last.hasAttribute("data-body")
        ? lastLineOffset(last)
        : null
      if (offset === null) {
        last.style.removeProperty(END_LINE)
        return
      }
      const value = `${Math.round(offset * 4) / 4}px`
      if (last.style.getPropertyValue(END_LINE) !== value) {
        last.style.setProperty(END_LINE, value)
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => {
      observer.disconnect()
      row?.style.removeProperty(END_LINE)
    }
  }, [listRef, reached])
}

/**
 * How far above `row`'s bottom edge the centre of the last line of its body
 * sits — the last text in document order that is drawn, which is the bottom
 * line of a footer, a member row or a paragraph — or null when the body has
 * no text to go by. A line a scroll box has cut off counts as the line at
 * that box's edge, wherever the box is scrolled to.
 */
export function lastLineOffset(row: HTMLElement): number | null {
  const range = document.createRange()
  // jsdom lays nothing out.
  if (typeof range.getClientRects !== "function") return null
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  for (let node = walker.lastChild(); node; node = walker.previousNode()) {
    const parent = node.parentElement
    if (!node.textContent?.trim() || !parent || !inBody(parent, row)) {
      continue
    }
    range.selectNodeContents(node)
    const rects = range.getClientRects()
    const rect = rects[rects.length - 1]
    // Collapsed, hidden, or visually hidden (an `sr-only` label).
    if (!rect || rect.height < 4) continue
    const edge = clipBottom(parent, row)
    const centre =
      edge !== null && rect.bottom > edge + 0.5
        ? edge - rect.height / 2
        : (rect.top + rect.bottom) / 2
    return Math.max(0, row.getBoundingClientRect().bottom - centre)
  }
  return null
}

/** Whether `el` is in the row's body: not its rail marker (the row's first
 *  child) nor its header line. */
function inBody(el: HTMLElement, row: HTMLElement): boolean {
  let child = el
  while (child.parentElement && child.parentElement !== row) {
    child = child.parentElement
  }
  return (
    child !== row.firstElementChild && !child.classList.contains("group/row")
  )
}

const CLIPS = new Set(["hidden", "clip", "auto", "scroll", "overlay"])

/** The highest bottom edge among the boxes between `el` and `row` that clip
 *  their content vertically, or null when none does. */
function clipBottom(el: HTMLElement, row: HTMLElement): number | null {
  let edge: number | null = null
  for (let box: HTMLElement | null = el; box && box !== row; ) {
    if (CLIPS.has(getComputedStyle(box).overflowY)) {
      const bottom = box.getBoundingClientRect().bottom
      if (edge === null || bottom < edge) edge = bottom
    }
    box = box.parentElement
  }
  return edge
}
