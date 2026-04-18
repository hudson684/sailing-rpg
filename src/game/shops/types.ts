import type { ItemId } from "../inventory/items";

/** Authored entry — how much of this item the shop stocks at each restock. */
export interface ShopStockDef {
  itemId: ItemId;
  restockQuantity: number;
}

export interface ShopDef {
  id: string;
  name: string;
  greeting?: string;
  stock: ShopStockDef[];
}

/** Current per-item count available for sale right now. */
export interface ShopStockState {
  itemId: ItemId;
  quantity: number;
}

/** Items the player sold back. Expires at `expiresAt` (ms since epoch). */
export interface BuybackEntry {
  itemId: ItemId;
  quantity: number;
  expiresAt: number;
}

/** Runtime state for a single shop instance. */
export interface ShopInstance {
  /** Next wall-clock time (ms since epoch) at which stock refills to full. */
  restockAt: number;
  stock: ShopStockState[];
  buyback: BuybackEntry[];
}

export const SHOP_RESTOCK_MS = 5 * 60 * 1000;
export const BUYBACK_TTL_MS = 60 * 60 * 1000;
