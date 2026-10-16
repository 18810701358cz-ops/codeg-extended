import { beforeEach, describe, expect, it } from "vitest"
import {
  GLOBAL_COMMANDS_STORAGE_KEY,
  createGlobalCommand,
  deleteGlobalCommand,
  isGlobalCommandId,
  listGlobalCommands,
  reorderGlobalCommands,
  updateGlobalCommand,
  withoutGlobalIds,
} from "./global-commands"
import type { FolderCommand } from "./types"

const summary = () =>
  listGlobalCommands().map(({ id, name, command }) => ({ id, name, command }))

describe("global commands", () => {
  beforeEach(() => localStorage.clear())

  it("hands out negative ids, apart from folder commands' primary keys", () => {
    const a = createGlobalCommand("zed", "local: zed .")
    const b = createGlobalCommand("open", "local: open .")
    expect(a.id).toBe(-1)
    expect(b.id).toBe(-2)
    expect(isGlobalCommandId(a.id)).toBe(true)
    expect(isGlobalCommandId(5)).toBe(false)
  })

  it("does not reuse the id of a deleted command", () => {
    createGlobalCommand("a", "a")
    const b = createGlobalCommand("b", "b")
    deleteGlobalCommand(-1)
    expect(createGlobalCommand("c", "c").id).toBe(b.id - 1)
  })

  it("does not reuse the id of the newest command once it is deleted", () => {
    // A folder's remembered selection, or a terminal it still runs in, would
    // otherwise pass to the next command created.
    createGlobalCommand("a", "a")
    const b = createGlobalCommand("b", "b")
    deleteGlobalCommand(b.id)
    expect(createGlobalCommand("c", "c").id).toBe(b.id - 1)
    deleteGlobalCommand(-1)
    deleteGlobalCommand(-3)
    expect(createGlobalCommand("d", "d").id).toBe(-4)
  })

  it("reads the bare list earlier builds stored, and counts on below it", () => {
    localStorage.setItem(
      GLOBAL_COMMANDS_STORAGE_KEY,
      JSON.stringify([{ id: -4, name: "old", command: "x" }])
    )
    expect(summary()).toEqual([{ id: -4, name: "old", command: "x" }])
    expect(createGlobalCommand("new", "y").id).toBe(-5)
  })

  it("never hands out an id at or above one in use, whatever the mark says", () => {
    localStorage.setItem(
      GLOBAL_COMMANDS_STORAGE_KEY,
      JSON.stringify({
        lastId: -1,
        commands: [{ id: -5, name: "a", command: "a" }],
      })
    )
    expect(createGlobalCommand("b", "b").id).toBe(-6)
  })

  it("updates, deletes and reorders", () => {
    createGlobalCommand("a", "a")
    createGlobalCommand("b", "b")
    createGlobalCommand("c", "c")
    updateGlobalCommand(-2, "B", "bb")
    reorderGlobalCommands([-3, -1])
    expect(summary()).toEqual([
      { id: -3, name: "c", command: "c" },
      { id: -1, name: "a", command: "a" },
      { id: -2, name: "B", command: "bb" },
    ])
    deleteGlobalCommand(-3)
    expect(summary().map((c) => c.id)).toEqual([-1, -2])
  })

  it("throws when updating a command that is gone", () => {
    expect(() => updateGlobalCommand(-9, "x", "x")).toThrow()
  })

  it("ignores malformed storage", () => {
    localStorage.setItem(
      GLOBAL_COMMANDS_STORAGE_KEY,
      JSON.stringify([
        { id: 3, name: "positive", command: "x" },
        { id: -1, name: "ok", command: "y" },
        { id: -1, name: "duplicate", command: "z" },
        { id: -2, name: 7, command: "w" },
        null,
      ])
    )
    expect(summary()).toEqual([{ id: -1, name: "ok", command: "y" }])
    localStorage.setItem(GLOBAL_COMMANDS_STORAGE_KEY, "{not json")
    expect(listGlobalCommands()).toEqual([])
    localStorage.setItem(
      GLOBAL_COMMANDS_STORAGE_KEY,
      JSON.stringify({ lastId: -3, commands: "nope" })
    )
    expect(listGlobalCommands()).toEqual([])
  })
})

describe("withoutGlobalIds", () => {
  const command = (id: number): FolderCommand => ({
    id,
    folder_id: 1,
    name: `c${id}`,
    command: "x",
    sort_order: 0,
    created_at: "",
    updated_at: "",
  })

  it("drops host entries that claim a global command's id", () => {
    expect(
      withoutGlobalIds([command(3), command(-1), command(7)]).map((c) => c.id)
    ).toEqual([3, 7])
  })
})
