import { create } from "zustand";
import {
  CURRENCY_ITEM_ID,
  ITEMS,
  itemBuyLot,
  itemBuyPriceFor,
  itemIsSellable,
  itemSellLot,
  itemSellPriceFor,
  type ItemId,
} from "../inventory/items";
import {
  addBuyback,
  advanceTimers,
  createInstance,
  removeBuyback,
  removeStock,
} from "../shops/operations";
import { shops } from "../shops/shops";
import type { ShopInstance } from "../shops/types";
import { useGameStore } from "./gameStore";
import { addToSlots, removeFromSlot } from "../inventory/operations";
import { bus } from "../bus";

export type ShopOutcome =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "unknown_shop"
        | "unknown_item"
        | "out_of_stock"
        | "not_enough_coins"
        | "inventory_full"
        | "not_owned"
        | "not_sellable";
    };

export interface ShopsState {
  /** Runtime instances keyed by shopId. Lazily created on first access. */
  instances: Record<string, ShopInstance>;
  /** Which shop the UI is currently showing (null = closed). */
  openShopId: string | null;

  openShop: (shopId: string) => void;
  closeShop: () => void;
  /** Nudge timers (restock / buyback TTL) for a specific shop. */
  touchShop: (shopId: string, now?: number) => ShopInstance | null;

  buy: (shopId: string, itemId: ItemId, qty: number) => ShopOutcome;
  sell: (shopId: string, inventoryIndex: number, qty: number) => ShopOutcome;
  buybackBuy: (shopId: string, itemId: ItemId, qty: number) => ShopOutcome;

  hydrate: (data: Record<string, ShopInstance>) => void;
  reset: () => void;
}

function countCurrency(slots: ReadonlyArray<{ itemId: string; quantity: number } | null>): number {
  let total = 0;
  for (const s of slots) if (s && s.itemId === CURRENCY_ITEM_ID) total += s.quantity;
  return total;
}

type Slots = ReadonlyArray<{ itemId: string; quantity: number } | null>;

function removeCurrency(slots: Slots, amount: number): { slots: Slots; removed: number } {
  let working: Slots = slots;
  let remaining = amount;
  for (let i = 0; i < working.length && remaining > 0; i++) {
    const s = working[i];
    if (!s || s.itemId !== CURRENCY_ITEM_ID) continue;
    const r = removeFromSlot(working as never, i, Math.min(s.quantity, remaining));
    working = r.slots;
    remaining -= r.removed;
    if (r.removed === 0) break;
  }
  return { slots: working, removed: amount - remaining };
}

export const useShopStore = create<ShopsState>()((set, get) => ({
  instances: {},
  openShopId: null,

  openShop: (shopId) => {
    get().touchShop(shopId);
    set({ openShopId: shopId });
  },

  closeShop: () => set({ openShopId: null }),

  touchShop: (shopId, now = Date.now()) => {
    const def = shops.tryGet(shopId);
    if (!def) return null;
    const { instances } = get();
    const existing = instances[shopId];
    const inst = existing
      ? advanceTimers(def, existing, now)
      : createInstance(def, now);
    if (inst !== existing) {
      set({ instances: { ...instances, [shopId]: inst } });
    }
    return inst;
  },

  buy: (shopId, itemId, qty) => {
    if (qty <= 0) return { ok: false, reason: "out_of_stock" };
    const def = shops.tryGet(shopId);
    if (!def) return { ok: false, reason: "unknown_shop" };
    const itemDef = ITEMS[itemId];
    if (!itemDef) return { ok: false, reason: "unknown_item" };
    const lot = itemBuyLot(itemId);
    if (qty % lot !== 0) return { ok: false, reason: "out_of_stock" };

    const now = Date.now();
    const current = get().touchShop(shopId, now);
    if (!current) return { ok: false, reason: "unknown_shop" };

    const haveStock = current.stock
      .filter((s) => s.itemId === itemId)
      .reduce((t, s) => t + s.quantity, 0);
    if (haveStock < qty) return { ok: false, reason: "out_of_stock" };

    const price = itemBuyPriceFor(itemId, qty);
    const store = useGameStore.getState();
    const slots = store.inventory.slots;
    if (countCurrency(slots) < price) return { ok: false, reason: "not_enough_coins" };

    // Tentatively deduct currency from a clone, then add the purchased item.
    const afterPay = removeCurrency(slots, price).slots;
    const { slots: afterAdd, leftover } = addToSlots(afterPay, itemId, qty);
    if (leftover > 0) return { ok: false, reason: "inventory_full" };

    store.inventoryHydrate(afterAdd as never);

    const nextInstances = {
      ...get().instances,
      [shopId]: {
        ...current,
        stock: removeStock(current.stock, itemId, qty),
      },
    };
    set({ instances: nextInstances });
    bus.emitTyped("shop:purchased", { shopId, itemId, quantity: qty });
    return { ok: true };
  },

  sell: (shopId, inventoryIndex, qty) => {
    if (qty <= 0) return { ok: false, reason: "not_sellable" };
    const def = shops.tryGet(shopId);
    if (!def) return { ok: false, reason: "unknown_shop" };

    const store = useGameStore.getState();
    const slot = store.inventory.slots[inventoryIndex];
    if (!slot) return { ok: false, reason: "not_owned" };
    if (slot.itemId === CURRENCY_ITEM_ID) return { ok: false, reason: "not_sellable" };
    const itemDef = ITEMS[slot.itemId];
    if (!itemDef) return { ok: false, reason: "unknown_item" };
    if (!itemIsSellable(slot.itemId)) return { ok: false, reason: "not_sellable" };

    const lot = itemSellLot(slot.itemId);
    // Snap to the largest whole lot the player can actually deliver.
    const takeQty = Math.min(qty, slot.quantity) - (Math.min(qty, slot.quantity) % lot);
    if (takeQty <= 0) return { ok: false, reason: "not_sellable" };
    const { slots: afterRemove, removed } = removeFromSlot(
      store.inventory.slots,
      inventoryIndex,
      takeQty,
    );
    if (removed <= 0) return { ok: false, reason: "not_owned" };

    const payout = itemSellPriceFor(slot.itemId, removed);
    const { slots: afterPay, leftover } = addToSlots(afterRemove, CURRENCY_ITEM_ID, payout);
    // Unlikely, but if coins can't fit at all, bail without mutating state.
    if (leftover === payout) return { ok: false, reason: "inventory_full" };

    store.inventoryHydrate(afterPay as never);

    const now = Date.now();
    const current = get().touchShop(shopId, now);
    if (!current) return { ok: true };
    const nextInstances = {
      ...get().instances,
      [shopId]: {
        ...current,
        buyback: addBuyback(current.buyback, slot.itemId, removed, now),
      },
    };
    set({ instances: nextInstances });
    return { ok: true };
  },

  buybackBuy: (shopId, itemId, qty) => {
    if (qty <= 0) return { ok: false, reason: "out_of_stock" };
    const def = shops.tryGet(shopId);
    if (!def) return { ok: false, reason: "unknown_shop" };
    const itemDef = ITEMS[itemId];
    if (!itemDef) return { ok: false, reason: "unknown_item" };
    const lot = itemSellLot(itemId);
    if (qty % lot !== 0) return { ok: false, reason: "out_of_stock" };

    const now = Date.now();
    const current = get().touchShop(shopId, now);
    if (!current) return { ok: false, reason: "unknown_shop" };
    const available = current.buyback
      .filter((b) => b.itemId === itemId)
      .reduce((t, b) => t + b.quantity, 0);
    if (available < qty) return { ok: false, reason: "out_of_stock" };

    // Buyback price = the original sell price — same amount the player got back.
    const price = itemSellPriceFor(itemId, qty);
    const store = useGameStore.getState();
    const slots = store.inventory.slots;
    if (countCurrency(slots) < price) return { ok: false, reason: "not_enough_coins" };

    const afterPay = removeCurrency(slots, price).slots;
    const { slots: afterAdd, leftover } = addToSlots(afterPay, itemId, qty);
    if (leftover > 0) return { ok: false, reason: "inventory_full" };

    store.inventoryHydrate(afterAdd as never);

    const nextInstances = {
      ...get().instances,
      [shopId]: {
        ...current,
        buyback: removeBuyback(current.buyback, itemId, qty),
      },
    };
    set({ instances: nextInstances });
    return { ok: true };
  },

  hydrate: (data) => set({ instances: { ...data } }),
  reset: () => set({ instances: {}, openShopId: null }),
}));

export const selectOpenShopId = (s: ShopsState) => s.openShopId;
export const selectShopInstances = (s: ShopsState) => s.instances;
