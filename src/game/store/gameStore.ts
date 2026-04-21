import { create } from "zustand";
import type { EquipSlot, ItemId } from "../inventory/items";
import { INVENTORY_SIZE, type Slot } from "../inventory/types";
import {
  addToSlots,
  emptySlots,
  hydrateSlots,
  moveSlot,
  removeFromSlot,
} from "../inventory/operations";
import {
  computeEquippedStats,
  equipFromInventory as equipFromInventoryOp,
  hydrateEquipped,
  unequip as unequipOp,
  type Equipped,
} from "../equipment/operations";
import { ITEMS } from "../inventory/items";
import type { JobId } from "../jobs/jobs";
import { JOBS } from "../jobs/jobs";
import {
  addXp as addXpOp,
  emptyJobXp,
  hydrateJobXp,
  type JobXp,
} from "../jobs/operations";
import { showToast } from "../../ui/store/ui";
import { bus } from "../bus";

/**
 * Global game store. This owns discrete game state (inventory, and later
 * equipment / jobs / quests). High-frequency simulation state — player
 * position, ship physics, sprite/tween progress — stays on Phaser entities
 * and MUST NOT live here (60fps store writes would be needlessly expensive).
 */

export interface InventorySlice {
  slots: (Slot | null)[];
}

export interface EquipmentSlice {
  equipped: Equipped;
}

export interface JobsSlice {
  xp: JobXp;
}

export interface HealthSlice {
  /** Current HP. Max is derived from BASE_MAX_HP + equipped maxHp stats. */
  current: number;
}

/** Base max HP before equipment bonuses. */
export const BASE_MAX_HP = 40;

export type EquipOutcome =
  | { ok: true }
  | { ok: false; reason: "not_equippable" | "inventory_full" | "empty" };

export interface GameState {
  inventory: InventorySlice;
  equipment: EquipmentSlice;
  jobs: JobsSlice;
  health: HealthSlice;

  inventoryAdd: (itemId: ItemId, qty: number) => number;
  inventoryRemoveAt: (index: number, qty: number) => number;
  inventoryMove: (from: number, to: number) => boolean;
  inventoryHydrate: (data: ReadonlyArray<Slot | null>) => void;
  inventoryReset: () => void;

  equipFromInventory: (index: number) => EquipOutcome;
  unequip: (slot: EquipSlot) => EquipOutcome;
  equipmentHydrate: (data: Equipped) => void;
  equipmentReset: () => void;

  jobsAddXp: (jobId: JobId, amount: number) => void;
  jobsHydrate: (data: Partial<Record<string, number>>) => void;
  jobsReset: () => void;

  /** Apply damage. Returns the actual damage taken (clamped to current). */
  healthDamage: (amount: number) => number;
  /** Heal up to maxHp. Returns amount actually restored. */
  healthHeal: (amount: number) => number;
  /** Consume one unit of the item at `index` if it's a consumable. */
  useConsumable: (index: number) => { ok: boolean; reason?: "empty" | "not_consumable" | "no_effect" };
  healthHydrate: (data: { current: number }) => void;
  healthReset: () => void;
}

/** Max HP given the currently equipped items. */
export function computeMaxHp(equipped: Equipped): number {
  return BASE_MAX_HP + computeEquippedStats(equipped).maxHp;
}

export const useGameStore = create<GameState>()((set, get) => ({
  inventory: { slots: emptySlots() },
  equipment: { equipped: {} },
  jobs: { xp: emptyJobXp() },
  health: { current: BASE_MAX_HP },

  inventoryAdd: (itemId, qty) => {
    const { slots, leftover } = addToSlots(get().inventory.slots, itemId, qty);
    set({ inventory: { slots } });
    return leftover;
  },

  inventoryRemoveAt: (index, qty) => {
    const { slots, removed } = removeFromSlot(get().inventory.slots, index, qty);
    if (removed > 0) set({ inventory: { slots } });
    return removed;
  },

  inventoryMove: (from, to) => {
    const { slots, moved } = moveSlot(get().inventory.slots, from, to);
    if (moved) set({ inventory: { slots } });
    return moved;
  },

  inventoryHydrate: (data) => set({ inventory: { slots: hydrateSlots(data) } }),

  inventoryReset: () => set({ inventory: { slots: emptySlots() } }),

  equipFromInventory: (index) => {
    const { inventory, equipment } = get();
    const result = equipFromInventoryOp(inventory.slots, equipment.equipped, index);
    if (!result.ok) return { ok: false, reason: result.reason! };
    set({
      inventory: { slots: result.inventory },
      equipment: { equipped: result.equipped },
    });
    // Equipment changed → max HP may have shrunk; clamp current.
    const maxHp = computeMaxHp(result.equipped);
    if (get().health.current > maxHp) set({ health: { current: maxHp } });
    return { ok: true };
  },

  unequip: (slot) => {
    const { inventory, equipment } = get();
    const result = unequipOp(inventory.slots, equipment.equipped, slot);
    if (!result.ok) return { ok: false, reason: result.reason! };
    set({
      inventory: { slots: result.inventory },
      equipment: { equipped: result.equipped },
    });
    const maxHp = computeMaxHp(result.equipped);
    if (get().health.current > maxHp) set({ health: { current: maxHp } });
    return { ok: true };
  },

  equipmentHydrate: (data) => set({ equipment: { equipped: hydrateEquipped(data) } }),

  equipmentReset: () => set({ equipment: { equipped: {} } }),

  jobsAddXp: (jobId, amount) => {
    if (amount <= 0) return;
    const { xp } = get().jobs;
    const { xp: nextXp, prevLevel, nextLevel } = addXpOp(xp, jobId, amount);
    set({ jobs: { xp: nextXp } });
    bus.emitTyped("jobs:xpGained", { jobId, amount: Math.max(0, Math.floor(amount)) });
    if (nextLevel > prevLevel) {
      const def = JOBS[jobId];
      showToast(`${def.name} level ${nextLevel}!`, 2500, "success");
    }
  },

  jobsHydrate: (data) => set({ jobs: { xp: hydrateJobXp(data) } }),

  jobsReset: () => set({ jobs: { xp: emptyJobXp() } }),

  healthDamage: (amount) => {
    if (amount <= 0) return 0;
    const cur = get().health.current;
    const next = Math.max(0, cur - amount);
    set({ health: { current: next } });
    return cur - next;
  },

  healthHeal: (amount) => {
    if (amount <= 0) return 0;
    const cur = get().health.current;
    const max = computeMaxHp(get().equipment.equipped);
    const next = Math.min(max, cur + amount);
    set({ health: { current: next } });
    return next - cur;
  },

  useConsumable: (index) => {
    const slot = get().inventory.slots[index];
    if (!slot) return { ok: false, reason: "empty" };
    const def = ITEMS[slot.itemId];
    if (!def?.consumable) return { ok: false, reason: "not_consumable" };
    const heal = def.consumable.healHp ?? 0;
    if (heal > 0) {
      const max = computeMaxHp(get().equipment.equipped);
      if (get().health.current >= max) return { ok: false, reason: "no_effect" };
      get().healthHeal(heal);
    }
    const removed = removeFromSlot(get().inventory.slots, index, 1);
    if (removed.removed > 0) set({ inventory: { slots: removed.slots } });
    return { ok: true };
  },

  healthHydrate: (data) => {
    const max = computeMaxHp(get().equipment.equipped);
    const current = Math.max(0, Math.min(max, Math.floor(data.current)));
    set({ health: { current } });
  },

  healthReset: () => set({ health: { current: computeMaxHp(get().equipment.equipped) } }),
}));

// ── Selectors ────────────────────────────────────────────────────────────
// Keep selectors here so components import once; reference-stable returns
// are important (Zustand re-renders on !== of the selected value).

export const selectInventorySlots = (s: GameState) => s.inventory.slots;
export const selectEquipped = (s: GameState) => s.equipment.equipped;
export const selectJobXp = (s: GameState) => s.jobs.xp;
export const selectHealth = (s: GameState) => ({
  current: s.health.current,
  max: computeMaxHp(s.equipment.equipped),
});

export { INVENTORY_SIZE };
export type { Slot, Equipped };
