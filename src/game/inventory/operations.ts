import { ITEMS, type ItemId } from "./items";
import { INVENTORY_SIZE, type Slot } from "./types";

export function emptySlots(): (Slot | null)[] {
  return new Array(INVENTORY_SIZE).fill(null);
}

function cloneSlots(slots: ReadonlyArray<Slot | null>): (Slot | null)[] {
  return slots.map((s) => (s ? { ...s } : null));
}

export interface AddResult {
  slots: (Slot | null)[];
  leftover: number;
}

/** Add qty of itemId — fills existing stacks, then empty slots. */
export function addToSlots(
  slots: ReadonlyArray<Slot | null>,
  itemId: ItemId,
  qty: number,
): AddResult {
  if (qty <= 0) return { slots: cloneSlots(slots), leftover: 0 };
  const def = ITEMS[itemId];
  const next = cloneSlots(slots);
  let remaining = qty;

  if (def.stackable) {
    for (let i = 0; i < next.length && remaining > 0; i++) {
      const s = next[i];
      if (s && s.itemId === itemId && s.quantity < def.maxStack) {
        const space = def.maxStack - s.quantity;
        const take = Math.min(space, remaining);
        s.quantity += take;
        remaining -= take;
      }
    }
  }

  for (let i = 0; i < next.length && remaining > 0; i++) {
    if (next[i] === null) {
      const take = def.stackable ? Math.min(def.maxStack, remaining) : 1;
      next[i] = { itemId, quantity: take };
      remaining -= take;
    }
  }

  return { slots: next, leftover: remaining };
}

export interface RemoveResult {
  slots: (Slot | null)[];
  removed: number;
}

export function removeFromSlot(
  slots: ReadonlyArray<Slot | null>,
  index: number,
  qty: number,
): RemoveResult {
  if (!isValidIndex(slots, index)) return { slots: cloneSlots(slots), removed: 0 };
  const s = slots[index];
  if (!s) return { slots: cloneSlots(slots), removed: 0 };
  const take = Math.min(s.quantity, qty);
  const next = cloneSlots(slots);
  const target = next[index]!;
  target.quantity -= take;
  if (target.quantity <= 0) next[index] = null;
  return { slots: next, removed: take };
}

export interface MoveResult {
  slots: (Slot | null)[];
  moved: boolean;
}

export function moveSlot(
  slots: ReadonlyArray<Slot | null>,
  from: number,
  to: number,
): MoveResult {
  if (!isValidIndex(slots, from) || !isValidIndex(slots, to) || from === to) {
    return { slots: cloneSlots(slots), moved: false };
  }
  const src = slots[from];
  if (!src) return { slots: cloneSlots(slots), moved: false };
  const dst = slots[to];
  const next = cloneSlots(slots);

  if (dst === null) {
    next[to] = { ...src };
    next[from] = null;
    return { slots: next, moved: true };
  }

  if (dst.itemId === src.itemId) {
    const def = ITEMS[src.itemId];
    if (def.stackable) {
      const space = def.maxStack - dst.quantity;
      if (space > 0) {
        const take = Math.min(space, src.quantity);
        next[to] = { ...dst, quantity: dst.quantity + take };
        const leftover = src.quantity - take;
        next[from] = leftover > 0 ? { ...src, quantity: leftover } : null;
        return { slots: next, moved: true };
      }
    }
  }

  // Swap.
  next[from] = { ...dst };
  next[to] = { ...src };
  return { slots: next, moved: true };
}

/** Clean-hydrate from persisted data — drops unknown ids and non-positive quantities. */
export function hydrateSlots(data: ReadonlyArray<Slot | null>): (Slot | null)[] {
  const next = emptySlots();
  const len = Math.min(data.length, INVENTORY_SIZE);
  for (let i = 0; i < len; i++) {
    const s = data[i];
    if (s && s.quantity > 0 && ITEMS[s.itemId]) {
      next[i] = { itemId: s.itemId, quantity: s.quantity };
    }
  }
  return next;
}

function isValidIndex(slots: ReadonlyArray<Slot | null>, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < slots.length;
}
