import type { WorldLocation } from "../location";

/** Named-location registry shared by the planner and spawn dispatcher.
 *
 *  Schedule templates address destinations symbolically (`spawnPoint`,
 *  `businessArrival:rusty_anchor`, `namedTile:town_square`) so that authoring
 *  doesn't need to embed concrete tile coordinates that may shift if the
 *  Tiled maps are edited. Anchors are populated by:
 *
 *  - The spawn pipeline, which registers the world tile of each
 *    `npcSpawnPoint` Tiled object as a per-spawn-group anchor.
 *  - Door registration, which records each interior's entry tile under
 *    `businessArrival:<interiorKey>` (the inside-the-shop tile a patron walks
 *    onto when entering through the door).
 *  - Authored named tiles (e.g. `town_square`), declared once in JSON and
 *    seeded at world load.
 *
 *  No save state — fully rebuilt from world data on every load. */
export class WorldAnchorRegistry {
  private readonly byKey = new Map<string, WorldLocation>();

  set(key: string, loc: WorldLocation): void {
    this.byKey.set(key, { ...loc });
  }

  get(key: string): WorldLocation | null {
    const v = this.byKey.get(key);
    return v ? { ...v } : null;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  clear(): void {
    this.byKey.clear();
  }

  /** Snapshot of every registered anchor — used by the dev console for
   *  debugging schedule misses. */
  list(): ReadonlyArray<{ key: string; loc: WorldLocation }> {
    return [...this.byKey.entries()].map(([key, loc]) => ({ key, loc: { ...loc } }));
  }
}

export const worldAnchors = new WorldAnchorRegistry();

export const ANCHOR_SPAWN_POINT_PREFIX = "spawnPoint:";
export const ANCHOR_BUSINESS_ARRIVAL_PREFIX = "businessArrival:";
export const ANCHOR_NAMED_TILE_PREFIX = "namedTile:";

export function spawnPointAnchorKey(spawnGroupId: string): string {
  return `${ANCHOR_SPAWN_POINT_PREFIX}${spawnGroupId}`;
}

export function businessArrivalAnchorKey(interiorOrBusinessId: string): string {
  return `${ANCHOR_BUSINESS_ARRIVAL_PREFIX}${interiorOrBusinessId}`;
}

export function namedTileAnchorKey(name: string): string {
  return `${ANCHOR_NAMED_TILE_PREFIX}${name}`;
}
