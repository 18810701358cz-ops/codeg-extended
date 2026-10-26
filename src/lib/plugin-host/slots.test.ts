import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearAllSlots,
  getSlotContributions,
  registerSlotContribution,
  subscribeSlot,
  unregisterAllPluginSlotContributions,
  unregisterSlotContribution,
} from "./slots"
import type { SlotContribution } from "./types"

describe("slots", () => {
  beforeEach(() => {
    clearAllSlots()
  })

  it("registers and retrieves slot contributions sorted by order", () => {
    const c1: SlotContribution = {
      id: "contrib-1",
      order: 10,
      mount: vi.fn(),
    }
    const c2: SlotContribution = {
      id: "contrib-2",
      order: 5,
      mount: vi.fn(),
    }
    const c3: SlotContribution = {
      id: "contrib-3",
      mount: vi.fn(), // order defaults to 0
    }

    registerSlotContribution("plugin-a", "statusbar.left", c1)
    registerSlotContribution("plugin-b", "statusbar.left", c2)
    registerSlotContribution("plugin-c", "statusbar.left", c3)

    const list = getSlotContributions("statusbar.left")
    expect(list.map((c) => c.id)).toEqual([
      "contrib-3",
      "contrib-2",
      "contrib-1",
    ])
    expect(list[0].pluginId).toBe("plugin-c")
  })

  it("notifies subscribers when contributions change", () => {
    const listener = vi.fn()
    const unsub = subscribeSlot("statusbar.right", listener)

    const unreg = registerSlotContribution("plugin-a", "statusbar.right", {
      id: "btn-1",
      mount: vi.fn(),
    })

    expect(listener).toHaveBeenCalledTimes(1)

    unreg()
    expect(listener).toHaveBeenCalledTimes(2)

    unsub()
    registerSlotContribution("plugin-b", "statusbar.right", {
      id: "btn-2",
      mount: vi.fn(),
    })
    expect(listener).toHaveBeenCalledTimes(2) // No longer called
  })

  it("unregisters specific contribution and all contributions of a plugin", () => {
    registerSlotContribution("plugin-a", "statusbar.left", {
      id: "c-1",
      mount: vi.fn(),
    })
    registerSlotContribution("plugin-a", "workspace.overlay", {
      id: "c-2",
      mount: vi.fn(),
    })
    registerSlotContribution("plugin-b", "statusbar.left", {
      id: "c-3",
      mount: vi.fn(),
    })

    expect(getSlotContributions("statusbar.left")).toHaveLength(2)
    expect(getSlotContributions("workspace.overlay")).toHaveLength(1)

    unregisterSlotContribution("plugin-a", "statusbar.left", "c-1")
    expect(getSlotContributions("statusbar.left")).toHaveLength(1)
    expect(getSlotContributions("statusbar.left")[0].id).toBe("c-3")

    unregisterAllPluginSlotContributions("plugin-a")
    expect(getSlotContributions("workspace.overlay")).toHaveLength(0)
  })
})
