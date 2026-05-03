import type { SceneKey } from "./location";

/** A unidirectional portal edge — stepping onto `fromTile` in `fromSceneKey`
 *  transports the agent to `toTile` in `toSceneKey`. Both sides of a
 *  player-traversable door are registered as separate links so cross-scene
 *  pathing can plan in either direction with a single lookup. */
export interface PortalLink {
  fromSceneKey: SceneKey;
  fromTile: { x: number; y: number };
  toSceneKey: SceneKey;
  toTile: { x: number; y: number };
}

/** Registry of door links populated as scenes load:
 *
 *  - World chunks register their `DoorSpawn`s on chunk-ready, which adds the
 *    chunk → interior direction at the door's tile.
 *  - When an interior scene is built, it registers its `interior_exit` tiles
 *    pointing back to the world door tile that brought the player in (the
 *    most-recent door used for the same `interiorKey`). Until then a
 *    placeholder reverse link is registered alongside the forward link, so
 *    cross-scene `GoTo` planning works even before the interior has been
 *    visited live this session.
 *
 *  No save state — the registry is rebuilt from spawn data on every load. */
export class PortalRegistry {
  private byScene = new Map<SceneKey, PortalLink[]>();

  /** Register a chunk → interior link for a door. Also registers a
   *  placeholder reverse link with `fromTile = (entryTx, entryTy + 1)` (the
   *  conventional one-tile-south exit position) so the interior → world
   *  direction is planable even before the interior has been loaded. The
   *  reverse link is refined to the real `interior_exit` tile when the
   *  interior scene is built (see `registerInteriorExit`). */
  registerDoor(opts: {
    worldSceneKey: SceneKey;
    worldTile: { x: number; y: number };
    interiorKey: string;
    entryTile: { x: number; y: number };
  }): void {
    const interiorScene = `interior:${opts.interiorKey}` as SceneKey;
    this.add({
      fromSceneKey: opts.worldSceneKey,
      fromTile: { ...opts.worldTile },
      toSceneKey: interiorScene,
      toTile: { ...opts.entryTile },
    });
    this.add({
      fromSceneKey: interiorScene,
      // Best-effort default; refined by registerInteriorExit on first load.
      fromTile: { x: opts.entryTile.x, y: opts.entryTile.y + 1 },
      toSceneKey: opts.worldSceneKey,
      toTile: { ...opts.worldTile },
    });
  }

  /** Refine every world → interior link's `toTile` to the interior's real
   *  entry tile (the position of its `interior_entry` Tiled object). Called
   *  by `InteriorScene` on init.
   *
   *  Why this exists: the door object in the world chunk carries its own
   *  `entryTx/entryTy` properties, but those are a legacy authoring field
   *  that the player ignores in favor of the interior's `interior_entry`
   *  object. Without this refinement, agent-driven cross-scene `GoTo`
   *  legs land tourists at the door's stale entry — which can be off the
   *  interior tilemap entirely if the values drifted apart. */
  refineEntry(interiorKey: string, realEntryTile: { x: number; y: number }): void {
    const interiorScene = `interior:${interiorKey}` as SceneKey;
    for (const list of this.byScene.values()) {
      for (const link of list) {
        if (link.toSceneKey !== interiorScene) continue;
        link.toTile = { ...realEntryTile };
      }
    }
  }

  /** Refine the interior → world link's `fromTile` to a real `interior_exit`
   *  tile. Called by `InteriorScene` once `parseInteriorSpawns` has run.
   *  Multiple exits register multiple links so any of them can be used as a
   *  portal source tile (they all map to the same world destination). */
  registerInteriorExit(
    interiorKey: string,
    exits: ReadonlyArray<{ tileX: number; tileY: number }>,
    worldDestSceneKey: SceneKey,
    worldDestTile: { x: number; y: number },
  ): void {
    if (exits.length === 0) return;
    const interiorScene = `interior:${interiorKey}` as SceneKey;
    const list = this.byScene.get(interiorScene);
    if (list) {
      // Drop placeholder reverse links targeting this world dest.
      const filtered = list.filter(
        (l) =>
          !(
            l.toSceneKey === worldDestSceneKey &&
            l.toTile.x === worldDestTile.x &&
            l.toTile.y === worldDestTile.y
          ),
      );
      if (filtered.length > 0) this.byScene.set(interiorScene, filtered);
      else this.byScene.delete(interiorScene);
    }
    for (const e of exits) {
      this.add({
        fromSceneKey: interiorScene,
        fromTile: { x: e.tileX, y: e.tileY },
        toSceneKey: worldDestSceneKey,
        toTile: { ...worldDestTile },
      });
    }
  }

  /** Find a single direct portal `fromSceneKey → toSceneKey`. Returns the
   *  first link if multiple are registered (e.g. multiple doors into the
   *  same interior). Multi-portal routing is out of scope for Phase 4. */
  findPortal(fromSceneKey: SceneKey, toSceneKey: SceneKey): PortalLink | null {
    const list = this.byScene.get(fromSceneKey);
    if (!list) return null;
    for (const l of list) if (l.toSceneKey === toSceneKey) return l;
    return null;
  }

  portalsFrom(sceneKey: SceneKey): readonly PortalLink[] {
    return this.byScene.get(sceneKey) ?? [];
  }

  /** Clear every registered portal. Used when reloading the world from
   *  scratch (new game, full save reload) so chunk-ready doesn't double up. */
  clear(): void {
    this.byScene.clear();
  }

  private add(link: PortalLink): void {
    let arr = this.byScene.get(link.fromSceneKey);
    if (!arr) {
      arr = [];
      this.byScene.set(link.fromSceneKey, arr);
    }
    // Dedupe on (fromTile, toSceneKey, toTile) — chunk-ready can fire twice
    // for the same chunk during streaming reloads.
    for (const existing of arr) {
      if (
        existing.fromTile.x === link.fromTile.x &&
        existing.fromTile.y === link.fromTile.y &&
        existing.toSceneKey === link.toSceneKey &&
        existing.toTile.x === link.toTile.x &&
        existing.toTile.y === link.toTile.y
      ) {
        return;
      }
    }
    arr.push(link);
  }
}

export const portalRegistry = new PortalRegistry();
