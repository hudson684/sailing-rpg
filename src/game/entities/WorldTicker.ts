import { entityRegistry } from "./registry";
import { mapIdKey, type MapId, type MapIdKey } from "./mapId";
import { NpcModel, type WalkableProbe } from "./NpcModel";

/** Global per-map-frame ticker. Scenes register a walkability probe for
 *  their own map while active; the ticker looks up the probe by the model's
 *  `mapId` each frame. Physics-free behaviors can still tick without a probe. */
export class WorldTicker {
  private providers = new Map<MapIdKey, WalkableProbe>();
  private paused = false;

  registerWalkable(mapId: MapId, probe: WalkableProbe) {
    this.providers.set(mapIdKey(mapId), probe);
  }

  unregisterWalkable(mapId: MapId) {
    this.providers.delete(mapIdKey(mapId));
  }

  /** When true, NPC models stop ticking. Used by edit mode to freeze
   *  NPCs at their spawn positions while authoring. */
  setPaused(paused: boolean) {
    this.paused = paused;
  }

  tick(dtMs: number) {
    if (this.paused) return;
    const fallback: WalkableProbe = () => false;
    for (const model of entityRegistry.all()) {
      if (model.kind === "npc") {
        const probe = this.providers.get(mapIdKey(model.mapId)) ?? fallback;
        (model as NpcModel).tick(dtMs, probe);
      }
    }
  }
}

export const worldTicker = new WorldTicker();
