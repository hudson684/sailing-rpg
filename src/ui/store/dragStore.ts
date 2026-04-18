import { create } from "zustand";

/**
 * Shared drag state for inventory slots. Used so the HUD hotbar, the
 * inventory's embedded hotbar, and the backpack grid all see the same drag
 * source — allowing drops across those components.
 *
 * `source` is the absolute slot index (0..INVENTORY_SIZE). null when no drag.
 */
interface DragState {
  source: number | null;
  setSource: (n: number | null) => void;
}

export const useDragStore = create<DragState>((set) => ({
  source: null,
  setSource: (source) => set({ source }),
}));

export const selectDragSource = (s: DragState) => s.source;
