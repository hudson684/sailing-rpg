import { entityRegistry } from "./registry";
import { NpcModel } from "./NpcModel";
import type { MapId } from "./mapId";
import type { NpcData, NpcDef, NpcMap } from "./npcTypes";
import { SpawnGateRegistry } from "../world/spawnGating";
import type { PredicateContext } from "../quests/predicates";

/** Convert the NPC data file's `map` field into a global `MapId`. */
export function npcMapToMapId(map: NpcMap | undefined): MapId {
  if (!map || map === "world") return { kind: "world" };
  return { kind: "interior", key: map.interior };
}

function modelIdFor(def: NpcDef): string {
  return `npc:${def.id}`;
}

/** Shared gate registry across bootstrapNpcs calls — so HMR reloads or
 *  `reloadNpcs` correctly tear down the previous subscription before
 *  registering the next one. */
let gateRegistry: SpawnGateRegistry<NpcDef, NpcModel> | null = null;

/** Populate the registry with every NPC in the data file. Safe to call
 *  repeatedly — existing models for the same ids are removed first.
 *
 *  When `ctx` is provided (Phase 7), defs with a `when` predicate are
 *  routed through SpawnGateRegistry so they add/remove live as flags
 *  change. Without a ctx, all NPCs spawn unconditionally (callers
 *  that boot before the quest subsystem skip gating). */
export function bootstrapNpcs(data: NpcData, ctx?: PredicateContext) {
  clearNpcs();
  if (ctx) {
    gateRegistry = new SpawnGateRegistry<NpcDef, NpcModel>({
      ctx,
      factory: (def) => {
        const id = modelIdFor(def);
        if (entityRegistry.get(id)) entityRegistry.remove(id);
        const model = new NpcModel(def, npcMapToMapId(def.map));
        entityRegistry.add(model);
        return model;
      },
      teardown: (model) => entityRegistry.remove(model.id),
    });
    gateRegistry.register(data.npcs);
  } else {
    for (const def of data.npcs) {
      const id = modelIdFor(def);
      if (entityRegistry.get(id)) entityRegistry.remove(id);
      entityRegistry.add(new NpcModel(def, npcMapToMapId(def.map)));
    }
  }
}

/** Remove every NPC currently in the registry. Used by HMR before a reload. */
export function clearNpcs() {
  if (gateRegistry) {
    gateRegistry.destroy();
    gateRegistry = null;
  }
  const ids: string[] = [];
  for (const model of entityRegistry.all()) {
    if (model.kind === "npc") ids.push(model.id);
  }
  for (const id of ids) entityRegistry.remove(id);
}

export function addNpc(def: NpcDef, mapId: MapId = { kind: "world" }): NpcModel {
  const model = new NpcModel(def, mapId);
  if (entityRegistry.get(model.id)) entityRegistry.remove(model.id);
  entityRegistry.add(model);
  return model;
}

export function removeNpcById(npcDefId: string) {
  entityRegistry.remove(`npc:${npcDefId}`);
}
