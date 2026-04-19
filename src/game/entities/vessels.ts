// Vessel templates. Each vessel ships as four per-heading Tiled tilemaps
// (`<tmjPrefix>-{n,e,s,w}.tmj`), each with two tile layers: `moving` (played
// while sailing) and `idle` (played while docked/anchoring). The ship's
// visual is a pair of `Phaser.Tilemaps.TilemapLayer` instances repositioned
// each frame to follow the ship container.

import shipsDataRaw from "../data/ships.json";
import type { Heading } from "./Ship";

export const SHIP_HEADINGS = ["n", "e", "s", "w"] as const;
export type ShipHeadingKey = (typeof SHIP_HEADINGS)[number];

export interface VesselTemplate {
  /** Stable id. */
  id: string;
  /** Prefix under `public/maps/ships/`. Loader composes `${tmjPrefix}-${heading}.tmj`. */
  tmjPrefix: string;
  /** Logical footprint in tiles when bow faces north. bow/stern axis = tilesLong. */
  tilesLong: number;
  tilesWide: number;
}

export interface ShipInstanceData {
  id: string;
  defId: string;
  tileX: number;
  tileY: number;
  heading: Heading;
}

interface ShipsFileRaw {
  defs: VesselTemplate[];
  instances: Array<{
    id: string;
    defId: string;
    tileX: number;
    tileY: number;
    heading: string;
  }>;
}

const HEADING_FROM_STRING: Record<string, Heading> = { N: 0, E: 1, S: 2, W: 3 };

export interface ShipsFile {
  defs: Map<string, VesselTemplate>;
  instances: ShipInstanceData[];
}

export function loadShipsFile(): ShipsFile {
  const raw = shipsDataRaw as ShipsFileRaw;
  const defs = new Map<string, VesselTemplate>();
  for (const d of raw.defs) defs.set(d.id, d);
  const instances: ShipInstanceData[] = raw.instances.map((inst) => {
    const headingStr = inst.heading.toUpperCase();
    const heading = HEADING_FROM_STRING[headingStr];
    if (heading === undefined) {
      throw new Error(`Ship instance ${inst.id} has invalid heading '${inst.heading}'.`);
    }
    return { id: inst.id, defId: inst.defId, tileX: inst.tileX, tileY: inst.tileY, heading };
  });
  return { defs, instances };
}

export function headingToShipKey(heading: Heading): ShipHeadingKey {
  return SHIP_HEADINGS[heading];
}

/** Tilemap cache key for a given ship def + heading. Matches BootScene preload. */
export function shipTilemapKey(vessel: VesselTemplate, heading: Heading): string {
  return `ship_${vessel.tmjPrefix}_${headingToShipKey(heading)}`;
}
