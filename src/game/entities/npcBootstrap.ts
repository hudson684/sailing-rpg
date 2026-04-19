import { entityRegistry } from "./registry";
import { NpcModel } from "./NpcModel";
import type { MapId } from "./mapId";
import type { NpcData, NpcDef, NpcMap } from "./npcTypes";

/** Convert the NPC data file's `map` field into a global `MapId`. */
export function npcMapToMapId(map: NpcMap | undefined): MapId {
  if (!map || map === "world") return { kind: "world" };
  return { kind: "interior", key: map.interior };
}

function modelIdFor(def: NpcDef): string {
  return `npc:${def.id}`;
}

/** Populate the registry with every NPC in the data file. Safe to call
 *  repeatedly — existing models for the same ids are removed first. */
export function bootstrapNpcs(data: NpcData) {
  for (const def of data.npcs) {
    const id = modelIdFor(def);
    if (entityRegistry.get(id)) entityRegistry.remove(id);
    entityRegistry.add(new NpcModel(def, npcMapToMapId(def.map)));
  }
}

/** Remove every NPC currently in the registry. Used by HMR before a reload. */
export function clearNpcs() {
  const ids: string[] = [];
  for (const model of entityRegistry.all()) {
    if (model.kind === "npc") ids.push(model.id);
  }
  for (const id of ids) entityRegistry.remove(id);
}

export function addNpc(def: NpcDef, mapId: MapId = { kind: "world" }): NpcModel {
  const model = new NpcModel(def, mapId);
  // If a model with this id already exists (edit-mode duplicates use
  // `${id}-copy`; plain duplicates would be caller error), remove first.
  if (entityRegistry.get(model.id)) entityRegistry.remove(model.id);
  entityRegistry.add(model);
  return model;
}

export function removeNpcById(npcDefId: string) {
  entityRegistry.remove(`npc:${npcDefId}`);
}
