import type { ItemId } from "../inventory/items";

/** Lifetime of a player-dropped item on the ground (ms). */
export const DROPPED_ITEM_TTL_MS = 10 * 60 * 1000;

/** String form matches `world:mapEntered` payloads: `"world"` or
 *  `"interior:<key>"`. Stored on each entry so a single store can serve
 *  every gameplay scene; only entries whose `mapId` matches the active
 *  scene render sprites. */
export type DropMapId = string;

export interface DroppedItem {
  uid: string;
  itemId: ItemId;
  quantity: number;
  x: number;
  y: number;
  /** Wall-clock ms (Date.now) at which this drop despawns. */
  expiresAt: number;
  /** Map this drop belongs to. Drops persist across scene transitions and
   *  re-render when the matching scene wakes. */
  mapId: DropMapId;
}

/**
 * Game-scoped runtime + persistent store for items the player has dropped or
 * that have spilled from killed enemies / harvested nodes. Separate from
 * authored `ItemSpawn`s: those use a uid-based pickedUp set; these carry
 * their own position, quantity, expiry, and owning map.
 */
export class DroppedItemsState {
  private items: DroppedItem[] = [];
  private counter = 0;

  list(): readonly DroppedItem[] {
    return this.items;
  }

  listForMap(mapId: DropMapId): DroppedItem[] {
    return this.items.filter((i) => i.mapId === mapId);
  }

  add(
    itemId: ItemId,
    quantity: number,
    x: number,
    y: number,
    mapId: DropMapId,
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
      mapId,
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
