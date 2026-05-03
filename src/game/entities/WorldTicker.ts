import { entityRegistry } from "./registry";
import { mapIdKey, type MapId, type MapIdKey } from "./mapId";
import { NpcModel, type WalkableProbe } from "./NpcModel";
import { npcRegistry } from "../sim/npcRegistry";

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
        // Phase 3: agent-managed NPCs are driven by SceneNpcBinder via the
        // sim registry's per-frame tick. Skip them here so the legacy and
        // new movement paths don't both write to the model in one frame.
        // customerSim/staff NPCs without an agent fall through to the
        // legacy AI until Phases 5/8 migrate them.
        if (npcRegistry.get(model.id)) continue;
        const probe = this.providers.get(mapIdKey(model.mapId)) ?? fallback;
        (model as NpcModel).tick(dtMs, probe);
      }
    }
  }
}

export const worldTicker = new WorldTicker();
