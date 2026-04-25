import { create } from "zustand";
import type { ItemId } from "../inventory/items";

export interface ChestUiContents {
  itemId: ItemId;
  qty: number;
}

export interface ChestUiState {
  /** Open chest's instance id (null = no chest panel showing). */
  openChestId: string | null;
  /** Display name for the panel header. */
  openChestName: string;
  /** Remaining loot, indexed positionally so the UI's per-row "Take" buttons
   *  can reference entries by index even after some have been removed
   *  (taken entries are spliced out, indices renumber). */
  loot: ChestUiContents[];
  open: (chestId: string, chestName: string, loot: ChestUiContents[]) => void;
  close: () => void;
  removeAt: (index: number) => void;
  clear: () => void;
}

export const useChestStore = create<ChestUiState>((set) => ({
  openChestId: null,
  openChestName: "",
  loot: [],
  open: (chestId, chestName, loot) =>
    set({ openChestId: chestId, openChestName: chestName, loot: [...loot] }),
  close: () => set({ openChestId: null, openChestName: "", loot: [] }),
  removeAt: (index) =>
    set((s) => ({ loot: s.loot.filter((_, i) => i !== index) })),
  clear: () => set({ loot: [] }),
}));

export const selectOpenChestId = (s: ChestUiState) => s.openChestId;
export const selectOpenChestName = (s: ChestUiState) => s.openChestName;
export const selectChestLoot = (s: ChestUiState) => s.loot;
