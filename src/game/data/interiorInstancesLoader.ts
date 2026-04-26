import rawData from "./interiorInstances.json";
import type { EnemyInstanceData } from "../entities/enemyTypes";
import type { NodeInstanceData } from "../world/GatheringNode";
import type { CraftingStationInstanceData } from "../crafting/types";
import type { ItemId } from "../inventory/items";

/**
 * Per-interior instance data authored via the /editor route. World maps keep
 * their own JSON files (enemies.json, nodes.json, etc.); interiors share a
 * single file keyed by interior key.
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
