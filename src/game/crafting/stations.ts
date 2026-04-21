import { createRegistry } from "../data/createRegistry";
import stationsData from "../data/craftingStations.json";
import type {
  CraftingStationDef,
  CraftingStationInstanceData,
  CraftingStationsFile,
} from "./types";

/**
 * Crafting stations are world objects (like gathering nodes) that open a
 * crafting modal when interacted with. Defs + placements are authored in
 * `src/game/data/craftingStations.json` and loaded once at module init.
 */

const FILE = stationsData as unknown as CraftingStationsFile;

export const craftingStations = createRegistry<CraftingStationDef>(FILE.defs, {
  label: "craftingStation",
});

export const craftingStationInstances: ReadonlyArray<CraftingStationInstanceData> =
  FILE.instances;
