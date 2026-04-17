import * as Phaser from "phaser";
import type { Heading } from "../entities/Ship";
import type { ItemId } from "../inventory/items";

export interface ShipSpawn {
  kind: "ship_spawn";
  tileX: number;
  tileY: number;
  heading: Heading;
}

export interface DockSpawn {
  kind: "dock";
  tileX: number;
  tileY: number;
}

export interface ItemSpawn {
  kind: "item_spawn";
  id: string;
  tileX: number;
  tileY: number;
  itemId: ItemId;
  quantity: number;
}

export type Spawn = ShipSpawn | DockSpawn | ItemSpawn;

export interface ParsedSpawns {
  ship: ShipSpawn;
  dock: DockSpawn;
  items: ItemSpawn[];
}

/** Lenient variant: ship/dock may be absent when parsing a single chunk. */
export interface ChunkParsedSpawns {
  ship: ShipSpawn | null;
  dock: DockSpawn | null;
  items: ItemSpawn[];
}

export interface ParseSpawnsOptions {
  /** Global tile X of the chunk's top-left — added to each object's local tile. */
  offsetTx?: number;
  offsetTy?: number;
  requireShip?: boolean;
  requireDock?: boolean;
}

const HEADING_FROM_STRING: Record<string, Heading> = { N: 0, E: 1, S: 2, W: 3 };

/** Parse the `objects` layer of a (chunk) tilemap into typed, global-tile spawns. */
export function parseSpawns(
  tilemap: Phaser.Tilemaps.Tilemap,
  opts: ParseSpawnsOptions = {},
): ChunkParsedSpawns {
  const { offsetTx = 0, offsetTy = 0, requireShip = true, requireDock = true } = opts;
  const layer = tilemap.getObjectLayer("objects");
  const tw = tilemap.tileWidth;
  const th = tilemap.tileHeight;

  let ship: ShipSpawn | null = null;
  let dock: DockSpawn | null = null;
  const items: ItemSpawn[] = [];

  if (layer) {
    for (const raw of layer.objects) {
      const props = propMap(raw.properties as TiledProperty[] | undefined);
      const tileX = Math.floor((raw.x ?? 0) / tw) + offsetTx;
      const tileY = Math.floor((raw.y ?? 0) / th) + offsetTy;
      switch (raw.type) {
        case "ship_spawn": {
          const headingStr = String(props.heading ?? "E").toUpperCase();
          const heading = HEADING_FROM_STRING[headingStr];
          if (heading === undefined) throw new Error(`ship_spawn has invalid heading ${headingStr}`);
          ship = { kind: "ship_spawn", tileX, tileY, heading };
          break;
        }
        case "dock":
          dock = { kind: "dock", tileX, tileY };
          break;
        case "item_spawn": {
          const itemId = String(props.itemId ?? "") as ItemId;
          const quantity = Number(props.quantity ?? 1);
          if (!itemId) throw new Error(`item_spawn at (${tileX},${tileY}) missing itemId`);
          items.push({
            kind: "item_spawn",
            id: `obj_${offsetTx}_${offsetTy}_${raw.id}`,
            tileX,
            tileY,
            itemId,
            quantity,
          });
          break;
        }
        default:
          break;
      }
    }
  }

  if (requireShip && !ship) throw new Error('Map is missing a ship_spawn object.');
  if (requireDock && !dock) throw new Error('Map is missing a dock object.');

  return { ship, dock, items };
}

interface TiledProperty {
  name: string;
  type?: string;
  value: unknown;
}

function propMap(props: TiledProperty[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const p of props) out[p.name] = p.value;
  return out;
}
