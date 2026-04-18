import type { ItemId } from "./items";

export const INVENTORY_SIZE = 28;

export interface Slot {
  itemId: ItemId;
  quantity: number;
}

export type Slots = ReadonlyArray<Slot | null>;
