import rawData from "../data/interiorInstances.json";
import type { EnemyInstanceData } from "../entities/enemyTypes";
import type { NodeInstanceData } from "../world/GatheringNode";
import type { CraftingStationInstanceData } from "../crafting/types";
import type { ItemId } from "../inventory/items";

/**
 * Editor-placed entities for interior maps. World maps keep their own JSON
 * files (enemies.json, nodes.json, craftingStations.json, itemInstances.json);
 * interiors share a single file keyed by interior key so adding a new room
 * doesn't require creating another data file.
 *
 * Only entities placed via the edit overlay live here — authored TMJ
 * `item_spawn` objects are still parsed directly from the .tmj and are
 * immutable from in-game edit mode.
 */

export interface InteriorEditorItem {
  id: string;
  itemId: ItemId;
  quantity: number;
  tileX: number;
  tileY: number;
}

export interface InteriorInstances {
  enemies: EnemyInstanceData[];
  nodes: NodeInstanceData[];
  stations: CraftingStationInstanceData[];
  items: InteriorEditorItem[];
}

export interface InteriorInstancesFile {
  interiors: Record<string, InteriorInstances>;
}

const FILE = rawData as InteriorInstancesFile;

/** Return a fresh copy of the instance lists for `interiorKey`. Missing keys
 *  return empty lists so callers don't have to gate on presence. */
export function loadInteriorInstances(interiorKey: string): InteriorInstances {
  const e = FILE.interiors[interiorKey];
  if (!e) return { enemies: [], nodes: [], stations: [], items: [] };
  return {
    enemies: e.enemies.map((x) => ({ ...x })),
    nodes: e.nodes.map((x) => ({ ...x })),
    stations: e.stations.map((x) => ({ ...x })),
    items: e.items.map((x) => ({ ...x })),
  };
}

export function serializeInteriorInstancesFile(
  map: Map<string, InteriorInstances>,
): string {
  const out: InteriorInstancesFile = { interiors: {} };
  const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, inst] of sorted) {
    out.interiors[key] = inst;
  }
  return JSON.stringify(out, null, 2) + "\n";
}

/** Merge an updated entry for one interior into the base file contents so a
 *  partial save from a single interior scene doesn't overwrite other
 *  interiors' data. Returns the combined file as JSON text. */
export function mergeInteriorInstances(
  interiorKey: string,
  instances: InteriorInstances,
): string {
  const merged = new Map<string, InteriorInstances>();
  for (const [k, v] of Object.entries(FILE.interiors)) {
    merged.set(k, {
      enemies: v.enemies.map((x) => ({ ...x })),
      nodes: v.nodes.map((x) => ({ ...x })),
      stations: v.stations.map((x) => ({ ...x })),
      items: v.items.map((x) => ({ ...x })),
    });
  }
  merged.set(interiorKey, instances);
  return serializeInteriorInstancesFile(merged);
}
