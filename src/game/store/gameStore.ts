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
  equipFromInventory as equipFromInventoryOp,
  hydrateEquipped,
  unequip as unequipOp,
  type Equipped,
} from "../equipment/operations";
import type { JobId } from "../jobs/jobs";
import { JOBS } from "../jobs/jobs";
import {
  addXp as addXpOp,
  emptyJobXp,
  hydrateJobXp,
  type JobXp,
} from "../jobs/operations";
import { showToast } from "../../ui/store/ui";

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

export type EquipOutcome =
  | { ok: true }
  | { ok: false; reason: "not_equippable" | "inventory_full" | "empty" };

export interface GameState {
  inventory: InventorySlice;
  equipment: EquipmentSlice;
  jobs: JobsSlice;

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
}

export const useGameStore = create<GameState>()((set, get) => ({
  inventory: { slots: emptySlots() },
  equipment: { equipped: {} },
  jobs: { xp: emptyJobXp() },

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
    return { ok: true };
  },

  equipmentHydrate: (data) => set({ equipment: { equipped: hydrateEquipped(data) } }),

  equipmentReset: () => set({ equipment: { equipped: {} } }),

  jobsAddXp: (jobId, amount) => {
    if (amount <= 0) return;
    const { xp } = get().jobs;
    const { xp: nextXp, prevLevel, nextLevel } = addXpOp(xp, jobId, amount);
    set({ jobs: { xp: nextXp } });
    if (nextLevel > prevLevel) {
      const def = JOBS[jobId];
      showToast(`${def.icon} ${def.name} level ${nextLevel}!`, 2500, "success");
    }
  },

  jobsHydrate: (data) => set({ jobs: { xp: hydrateJobXp(data) } }),

  jobsReset: () => set({ jobs: { xp: emptyJobXp() } }),
}));

// ── Selectors ────────────────────────────────────────────────────────────
// Keep selectors here so components import once; reference-stable returns
// are important (Zustand re-renders on !== of the selected value).

export const selectInventorySlots = (s: GameState) => s.inventory.slots;
export const selectEquipped = (s: GameState) => s.equipment.equipped;
export const selectJobXp = (s: GameState) => s.jobs.xp;

export { INVENTORY_SIZE };
export type { Slot, Equipped };
