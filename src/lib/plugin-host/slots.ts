import type { SlotContribution, SlotName } from "./types"

export interface RegisteredSlotContribution extends SlotContribution {
  pluginId: string
}

type SlotListener = () => void

// In-memory slot registry
const slotRegistry = new Map<
  SlotName,
  Map<string, RegisteredSlotContribution>
>()
const slotListeners = new Map<SlotName, Set<SlotListener>>()
const slotCache = new Map<SlotName, RegisteredSlotContribution[]>()

function notifySlotChanged(slotName: SlotName) {
  slotCache.delete(slotName)
  const listeners = slotListeners.get(slotName)
  if (listeners) {
    listeners.forEach((fn) => {
      try {
        fn()
      } catch (err) {
        console.error(
          `[plugin-host] Error in slot listener for "${slotName}":`,
          err
        )
      }
    })
  }
}

/**
 * Registers a slot contribution from a plugin.
 * Returns an unregister function.
 */
export function registerSlotContribution(
  pluginId: string,
  slotName: SlotName,
  contribution: SlotContribution
): () => void {
  let slotMap = slotRegistry.get(slotName)
  if (!slotMap) {
    slotMap = new Map()
    slotRegistry.set(slotName, slotMap)
  }

  const key = `${pluginId}:${contribution.id}`
  slotMap.set(key, { ...contribution, pluginId })
  notifySlotChanged(slotName)

  return () => {
    unregisterSlotContribution(pluginId, slotName, contribution.id)
  }
}

/**
 * Unregisters a specific contribution.
 */
export function unregisterSlotContribution(
  pluginId: string,
  slotName: SlotName,
  contributionId: string
): void {
  const slotMap = slotRegistry.get(slotName)
  if (!slotMap) return

  const key = `${pluginId}:${contributionId}`
  if (slotMap.delete(key)) {
    notifySlotChanged(slotName)
  }
}

/**
 * Unregisters all slot contributions registered by a specific plugin across all slots.
 */
export function unregisterAllPluginSlotContributions(pluginId: string): void {
  slotRegistry.forEach((slotMap, slotName) => {
    let changed = false
    for (const [key, item] of Array.from(slotMap.entries())) {
      if (item.pluginId === pluginId) {
        slotMap.delete(key)
        changed = true
      }
    }
    if (changed) {
      notifySlotChanged(slotName)
    }
  })
}

const emptyContributions: RegisteredSlotContribution[] = []

/**
 * Retrieves all registered contributions for a slot, sorted by `order` ascending (default 0).
 * Caches results per slot until invalidated by registry changes to maintain referential stability.
 */
export function getSlotContributions(
  slotName: SlotName
): RegisteredSlotContribution[] {
  const cached = slotCache.get(slotName)
  if (cached) return cached

  const slotMap = slotRegistry.get(slotName)
  let result: RegisteredSlotContribution[]
  if (!slotMap || slotMap.size === 0) {
    result = emptyContributions
  } else {
    result = Array.from(slotMap.values()).sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0)
    )
  }

  slotCache.set(slotName, result)
  return result
}

/**
 * Subscribes to changes in contributions for a given slot.
 */
export function subscribeSlot(
  slotName: SlotName,
  listener: SlotListener
): () => void {
  let listeners = slotListeners.get(slotName)
  if (!listeners) {
    listeners = new Set()
    slotListeners.set(slotName, listeners)
  }
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

/**
 * Clears all slot registrations and listeners (mainly for testing).
 */
export function clearAllSlots(): void {
  slotRegistry.clear()
  slotListeners.clear()
  slotCache.clear()
}
