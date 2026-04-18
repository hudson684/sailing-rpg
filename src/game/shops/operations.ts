import type { ShopDef, ShopInstance, ShopStockState } from "./types";
import { BUYBACK_TTL_MS, SHOP_RESTOCK_MS } from "./types";

/** A fresh instance with full stock and restock scheduled. */
export function createInstance(def: ShopDef, now: number): ShopInstance {
  return {
    restockAt: now + SHOP_RESTOCK_MS,
    stock: def.stock.map((s) => ({ itemId: s.itemId, quantity: s.restockQuantity })),
    buyback: [],
  };
}

/**
 * Advance wall-clock state: if `restockAt` has passed, stock refills back
 * to def quantities and the timer is scheduled forward. Expired buyback
 * entries are dropped. Returns a new instance (pure).
 */
export function advanceTimers(
  def: ShopDef,
  inst: ShopInstance,
  now: number,
): ShopInstance {
  let { restockAt, stock } = inst;
  if (now >= restockAt) {
    stock = def.stock.map((s) => ({ itemId: s.itemId, quantity: s.restockQuantity }));
    // If many cycles elapsed (game closed for hours), snap to one cycle ahead.
    const elapsed = now - restockAt;
    const cycles = Math.floor(elapsed / SHOP_RESTOCK_MS) + 1;
    restockAt = restockAt + cycles * SHOP_RESTOCK_MS;
  }
  const buyback = inst.buyback.filter((b) => b.expiresAt > now);
  return { restockAt, stock, buyback };
}

/** Decrement N units from a stock or buyback list. Returns new list + taken. */
function takeFromStock(
  stock: ShopStockState[],
  itemId: string,
  qty: number,
): { next: ShopStockState[]; taken: number } {
  let remaining = qty;
  const next: ShopStockState[] = [];
  for (const s of stock) {
    if (s.itemId !== itemId || remaining <= 0) {
      next.push({ ...s });
      continue;
    }
    const take = Math.min(s.quantity, remaining);
    remaining -= take;
    const left = s.quantity - take;
    if (left > 0) next.push({ itemId: s.itemId, quantity: left });
  }
  return { next, taken: qty - remaining };
}

export function removeStock(
  stock: ShopStockState[],
  itemId: string,
  qty: number,
): ShopStockState[] {
  return takeFromStock(stock, itemId, qty).next;
}

/** Add a buyback entry. Stacks with an existing one for the same itemId. */
export function addBuyback(
  buyback: ShopInstance["buyback"],
  itemId: string,
  qty: number,
  now: number,
): ShopInstance["buyback"] {
  const expiresAt = now + BUYBACK_TTL_MS;
  const next = buyback.map((b) => ({ ...b }));
  const existing = next.find((b) => b.itemId === itemId);
  if (existing) {
    existing.quantity += qty;
    // Refresh TTL so re-sold stacks don't vanish in chunks.
    existing.expiresAt = expiresAt;
    return next;
  }
  next.push({ itemId, quantity: qty, expiresAt });
  return next;
}

export function removeBuyback(
  buyback: ShopInstance["buyback"],
  itemId: string,
  qty: number,
): ShopInstance["buyback"] {
  let remaining = qty;
  const next: ShopInstance["buyback"] = [];
  for (const b of buyback) {
    if (b.itemId !== itemId || remaining <= 0) {
      next.push({ ...b });
      continue;
    }
    const take = Math.min(b.quantity, remaining);
    remaining -= take;
    const left = b.quantity - take;
    if (left > 0) next.push({ ...b, quantity: left });
  }
  return next;
}
