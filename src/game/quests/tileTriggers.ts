/** Registry of `(mapId, tileX, tileY)` triples that the scene should
 *  watch for. Scenes call `shouldEmitOn` each frame with the player's
 *  integer tile; if the return is true AND the tile changed since
 *  last frame, the scene emits `player:tileEntered`. This keeps
 *  per-frame work to a single Map lookup regardless of how many
 *  triggers are registered.
 *
 *  Quest authors register triggers by supplying a predicate with
 *  `{kind: "event", event: "player:tileEntered", match.tile}`; the
 *  QuestManager walks active steps after each bind / step-change and
 *  adds every referenced tile (expanded by radius) to this registry.
 *  Phase 1 ships the registry + scene plumbing; QuestManager-driven
 *  auto-registration lands in Phase 6 alongside the editor. Until
 *  then, scenes/debug code can populate it manually — any tile that's
 *  not in the registry is cheap to move across. */
export class TileTriggerRegistry {
  /** Key: `${mapId}|${x}|${y}`. Value: count (so multiple quests
   *  registering the same tile can individually unregister). */
  private readonly tiles = new Map<string, number>();

  add(mapId: string, tileX: number, tileY: number, radius = 0): void {
    for (const [x, y] of expand(tileX, tileY, radius)) {
      const k = key(mapId, x, y);
      this.tiles.set(k, (this.tiles.get(k) ?? 0) + 1);
    }
  }

  remove(mapId: string, tileX: number, tileY: number, radius = 0): void {
    for (const [x, y] of expand(tileX, tileY, radius)) {
      const k = key(mapId, x, y);
      const n = this.tiles.get(k) ?? 0;
      if (n <= 1) this.tiles.delete(k);
      else this.tiles.set(k, n - 1);
    }
  }

  has(mapId: string, tileX: number, tileY: number): boolean {
    return this.tiles.has(key(mapId, tileX, tileY));
  }

  /** True if the registry has anything for this map. Scenes use this
   *  to skip the per-frame tile lookup when no quest needs it. */
  hasAnyOn(mapId: string): boolean {
    for (const k of this.tiles.keys()) {
      if (k.startsWith(`${mapId}|`)) return true;
    }
    return false;
  }

  clear(): void {
    this.tiles.clear();
  }
}

function key(mapId: string, x: number, y: number): string {
  return `${mapId}|${x}|${y}`;
}

function* expand(
  cx: number,
  cy: number,
  radius: number,
): Iterable<[number, number]> {
  if (radius <= 0) {
    yield [cx, cy];
    return;
  }
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) yield [cx + dx, cy + dy];
    }
  }
}

/** Singleton tile-trigger registry shared by QuestManager and scenes.
 *  Populated from quest content at registration time (Phase 6) and
 *  polled by scenes on the player-tile-change path. Lives at module
 *  scope so scenes don't need to plumb a reference through their
 *  constructors. */
export const tileTriggers = new TileTriggerRegistry();
