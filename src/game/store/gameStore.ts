import { create } from "zustand";
import type { ItemId } from "../inventory/items";
import { INVENTORY_SIZE, type Slot } from "../inventory/types";
import {
  addToSlots,
  emptySlots,
  hydrateSlots,
  moveSlot,
  removeFromSlot,
} from "../inventory/operations";

/**
 * Global game store. This owns discrete game state (inventory, and later
 * equipment / jobs / quests). High-frequency simulation state — player
 * position, ship physics, sprite/tween progress — stays on Phaser entities
 * and MUST NOT live here (60fps store writes would be needlessly expensive).
 */

export interface InventorySlice {
  slots: (Slot | null)[];
}

export interface GameState {
  inventory: InventorySlice;

  inventoryAdd: (itemId: ItemId, qty: number) => number;
  inventoryRemoveAt: (index: number, qty: number) => number;
  inventoryMove: (from: number, to: number) => boolean;
  inventoryHydrate: (data: ReadonlyArray<Slot | null>) => void;
  inventoryReset: () => void;
}

export const useGameStore = create<GameState>()((set, get) => ({
  inventory: { slots: emptySlots() },

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
}));

// ── Selectors ────────────────────────────────────────────────────────────
// Keep selectors here so components import once; reference-stable returns
// are important (Zustand re-renders on !== of the selected value).

export const selectInventorySlots = (s: GameState) => s.inventory.slots;

export { INVENTORY_SIZE };
export type { Slot };
