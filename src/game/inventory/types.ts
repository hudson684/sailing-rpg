import type { ItemId } from "./items";

/** Slots 0..4 are the hotbar (shown in HUD); 5..29 are the backpack grid. */
export const HOTBAR_SIZE = 5;
export const BACKPACK_SIZE = 25;
export const INVENTORY_SIZE = HOTBAR_SIZE + BACKPACK_SIZE;

export interface Slot {
  itemId: ItemId;
  quantity: number;
}

export type Slots = ReadonlyArray<Slot | null>;
