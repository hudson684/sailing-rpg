import * as Phaser from "phaser";
import type { ItemId } from "../inventory/items";

export interface ItemSpawn {
  kind: "item_spawn";
  /** Stable cross-session identity. Stamped into source TMX by the map
   *  build pipeline — never reassign. */
  uid: string;
  tileX: number;
  tileY: number;
  itemId: ItemId;
  quantity: number;
}

/** A door painted in a world chunk. Pressing E (or stepping on, depending on
 *  variant) enters the named interior, placing the player at (entryTx, entryTy)
 *  in interior-local tile coords. The door's own tile is the player's
 *  return spot when leaving the interior. */
export interface DoorSpawn {
  kind: "door";
  uid: string;
  tileX: number;
  tileY: number;
  interiorKey: string;
  entryTx: number;
  entryTy: number;
}

/** A tile in an interior map that, when stepped on (or interacted with), exits
 *  back to the world at the door's saved return position. */
export interface InteriorExitSpawn {
  kind: "interior_exit";
  uid: string;
  tileX: number;
  tileY: number;
  /** When true, requires E-press instead of auto-triggering on step. */
  promptOnly: boolean;
}

/** A tile in an interior map where the player is placed when entering through
 *  any door that links to this interior. Authored in the interior's `objects`
 *  layer as a Tiled object of type `interior_entry`. */
export interface InteriorEntrySpawn {
  kind: "interior_entry";
  uid: string;
  tileX: number;
  tileY: number;
}

export type Spawn = ItemSpawn | DoorSpawn | InteriorExitSpawn | InteriorEntrySpawn;

export interface ParsedSpawns {
  items: ItemSpawn[];
  doors: DoorSpawn[];
}

/** Spawns parsed from a standalone interior map. */
export interface InteriorParsedSpawns {
  exits: InteriorExitSpawn[];
  entries: InteriorEntrySpawn[];
  items: ItemSpawn[];
}

export interface ParseSpawnsOptions {
  /** Global tile X of the chunk's top-left — added to each object's local tile. */
  offsetTx?: number;
  offsetTy?: number;
}

interface TiledObjectLike {
  x?: number;
  y?: number;
  type?: string;
  properties?: TiledProperty[];
}

function collectSpawns(
  objects: TiledObjectLike[],
  tw: number,
  th: number,
  offsetTx: number,
  offsetTy: number,
): ParsedSpawns {
  const items: ItemSpawn[] = [];
  const doors: DoorSpawn[] = [];

  for (const raw of objects) {
    const props = propMap(raw.properties);
    const tileX = Math.floor((raw.x ?? 0) / tw) + offsetTx;
    const tileY = Math.floor((raw.y ?? 0) / th) + offsetTy;
    switch (raw.type) {
      case "item_spawn": {
        const itemId = String(props.itemId ?? "") as ItemId;
        const quantity = Number(props.quantity ?? 1);
        const uid = String(props.uid ?? "");
        if (!itemId) throw new Error(`item_spawn at (${tileX},${tileY}) missing itemId`);
        if (!uid) {
          throw new Error(
            `item_spawn at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
          );
        }
        items.push({ kind: "item_spawn", uid, tileX, tileY, itemId, quantity });
        break;
      }
      case "door": {
        const interiorKey = String(props.interiorKey ?? "");
        const uid = String(props.uid ?? "");
        if (!interiorKey) {
          throw new Error(`door at (${tileX},${tileY}) missing interiorKey property.`);
        }
        if (!uid) {
          throw new Error(
            `door at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
          );
        }
        const entryTx = Number(props.entryTx ?? 0);
        const entryTy = Number(props.entryTy ?? 0);
        doors.push({
          kind: "door",
          uid,
          tileX,
          tileY,
          interiorKey,
          entryTx,
          entryTy,
        });
        break;
      }
      default:
        break;
    }
  }

  return { items, doors };
}

/** Parse the `objects` layer of a (chunk) tilemap into typed, global-tile spawns. */
export function parseSpawns(
  tilemap: Phaser.Tilemaps.Tilemap,
  opts: ParseSpawnsOptions = {},
): ParsedSpawns {
  const { offsetTx = 0, offsetTy = 0 } = opts;
  const layer = tilemap.getObjectLayer("objects");
  if (!layer) return { items: [], doors: [] };
  return collectSpawns(
    layer.objects as TiledObjectLike[],
    tilemap.tileWidth,
    tilemap.tileHeight,
    offsetTx,
    offsetTy,
  );
}

/** Parse the `objects` layer of an interior tilemap. Interior maps live in
 *  their own coordinate space (no global offset) and are loaded one at a time. */
export function parseInteriorSpawns(
  tilemap: Phaser.Tilemaps.Tilemap,
): InteriorParsedSpawns {
  const layer = tilemap.getObjectLayer("objects");
  const tw = tilemap.tileWidth;
  const th = tilemap.tileHeight;
  const exits: InteriorExitSpawn[] = [];
  const entries: InteriorEntrySpawn[] = [];
  const items: ItemSpawn[] = [];
  if (!layer) return { exits, entries, items };

  for (const raw of layer.objects) {
    const props = propMap(raw.properties as TiledProperty[] | undefined);
    const tileX = Math.floor((raw.x ?? 0) / tw);
    const tileY = Math.floor((raw.y ?? 0) / th);
    if (raw.type === "interior_exit") {
      const uid = String(props.uid ?? "");
      if (!uid) {
        throw new Error(
          `interior_exit at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
        );
      }
      exits.push({
        kind: "interior_exit",
        uid,
        tileX,
        tileY,
        promptOnly: Boolean(props.promptOnly ?? false),
      });
    } else if (raw.type === "interior_entry") {
      const uid = String(props.uid ?? "");
      if (!uid) {
        throw new Error(
          `interior_entry at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
        );
      }
      entries.push({
        kind: "interior_entry",
        uid,
        tileX,
        tileY,
      });
    } else if (raw.type === "item_spawn") {
      const itemId = String(props.itemId ?? "") as ItemId;
      const quantity = Number(props.quantity ?? 1);
      const uid = String(props.uid ?? "");
      if (!itemId) throw new Error(`interior item_spawn at (${tileX},${tileY}) missing itemId`);
      if (!uid) {
        throw new Error(
          `interior item_spawn at (${tileX},${tileY}) missing uid — run \`npm run maps\` to stamp.`,
        );
      }
      items.push({ kind: "item_spawn", uid, tileX, tileY, itemId, quantity });
    }
  }

  return { exits, entries, items };
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
