import type { ItemId } from "../inventory/items";

/** Lifetime of a player-dropped item on the ground (ms). */
export const DROPPED_ITEM_TTL_MS = 10 * 60 * 1000;

export interface DroppedItem {
  uid: string;
  itemId: ItemId;
  quantity: number;
  x: number;
  y: number;
  /** Wall-clock ms (Date.now) at which this drop despawns. */
  expiresAt: number;
}

/**
 * Runtime + persistent store for items the player has dropped. Separate from
 * authored `ItemSpawn`s: those use a uid-based pickedUp set; these carry their
 * own position, quantity, and expiry.
 */
export class DroppedItemsState {
  private items: DroppedItem[] = [];
  private counter = 0;

  list(): readonly DroppedItem[] {
    return this.items;
  }

  add(
    itemId: ItemId,
    quantity: number,
    x: number,
    y: number,
    now: number = Date.now(),
  ): DroppedItem {
    const uid = `dropped:${now.toString(36)}:${this.counter++}`;
    const entry: DroppedItem = {
      uid,
      itemId,
      quantity,
      x,
      y,
      expiresAt: now + DROPPED_ITEM_TTL_MS,
    };
    this.items.push(entry);
    return entry;
  }

  remove(uid: string): void {
    this.items = this.items.filter((i) => i.uid !== uid);
  }

  /** Returns the items that expired at `now`, and drops them from state. */
  pruneExpired(now: number): DroppedItem[] {
    const expired: DroppedItem[] = [];
    const kept: DroppedItem[] = [];
    for (const it of this.items) {
      if (it.expiresAt <= now) expired.push(it);
      else kept.push(it);
    }
    if (expired.length) this.items = kept;
    return expired;
  }

  reset(): void {
    this.items = [];
    this.counter = 0;
  }

  serialize(): DroppedItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  hydrate(list: readonly DroppedItem[]): void {
    this.items = list.map((i) => ({ ...i }));
    this.counter = this.items.length;
  }
}
