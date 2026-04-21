import { create } from "zustand";

/**
 * Transient UI state for crafting. Like `shopStore.openShopId`, this tracks
 * which crafting station's modal is currently showing. Deliberately minimal —
 * recipe data and inventory live elsewhere; this only decides modal visibility
 * and which station def to show.
 *
 * Not persisted (nothing here is part of a save).
 */

export interface CraftingUIState {
  /** Station def id currently opened in the modal (null = closed). */
  openStationDefId: string | null;
  openStation: (defId: string) => void;
  closeStation: () => void;
}

export const useCraftingStore = create<CraftingUIState>()((set) => ({
  openStationDefId: null,
  openStation: (defId) => set({ openStationDefId: defId }),
  closeStation: () => set({ openStationDefId: null }),
}));

export const selectOpenStationDefId = (s: CraftingUIState) => s.openStationDefId;
