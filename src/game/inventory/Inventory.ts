import { ITEMS, type ItemId } from "./items";

export const INVENTORY_SIZE = 28;

export interface Slot {
  itemId: ItemId;
  quantity: number;
}

export type Slots = ReadonlyArray<Slot | null>;

export class Inventory {
  private slots: (Slot | null)[] = new Array(INVENTORY_SIZE).fill(null);

  getSlots(): Slots {
    return this.slots.map((s) => (s ? { ...s } : null));
  }

  /** Adds qty of itemId. Fills existing stacks first, then empty slots. Returns leftover qty. */
  add(itemId: ItemId, qty: number): number {
    if (qty <= 0) return 0;
    const def = ITEMS[itemId];
    let remaining = qty;

    if (def.stackable) {
      for (let i = 0; i < this.slots.length && remaining > 0; i++) {
        const s = this.slots[i];
        if (s && s.itemId === itemId && s.quantity < def.maxStack) {
          const space = def.maxStack - s.quantity;
          const take = Math.min(space, remaining);
          s.quantity += take;
          remaining -= take;
        }
      }
    }

    for (let i = 0; i < this.slots.length && remaining > 0; i++) {
      if (this.slots[i] === null) {
        const take = def.stackable ? Math.min(def.maxStack, remaining) : 1;
        this.slots[i] = { itemId, quantity: take };
        remaining -= take;
      }
    }

    return remaining;
  }

  /** Removes up to qty from a slot. Returns the actual amount removed. */
  removeAt(index: number, qty: number): number {
    if (!this.isValidIndex(index)) return 0;
    const s = this.slots[index];
    if (!s) return 0;
    const take = Math.min(s.quantity, qty);
    s.quantity -= take;
    if (s.quantity <= 0) this.slots[index] = null;
    return take;
  }

  /** Moves (or merges) slot contents from → to. */
  move(from: number, to: number): boolean {
    if (!this.isValidIndex(from) || !this.isValidIndex(to) || from === to) return false;
    const src = this.slots[from];
    if (!src) return false;
    const dst = this.slots[to];

    if (dst === null) {
      this.slots[to] = src;
      this.slots[from] = null;
      return true;
    }

    if (dst.itemId === src.itemId) {
      const def = ITEMS[src.itemId];
      if (def.stackable) {
        const space = def.maxStack - dst.quantity;
        if (space > 0) {
          const take = Math.min(space, src.quantity);
          dst.quantity += take;
          src.quantity -= take;
          if (src.quantity <= 0) this.slots[from] = null;
          return true;
        }
      }
    }

    this.slots[from] = dst;
    this.slots[to] = src;
    return true;
  }

  private isValidIndex(i: number): boolean {
    return Number.isInteger(i) && i >= 0 && i < this.slots.length;
  }
}
