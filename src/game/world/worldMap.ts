import { Tile, type TileId } from "./tiles";
import type { ItemId } from "../inventory/items";

export const MAP_W = 64;
export const MAP_H = 48;

export interface GroundItemSpawn {
  id: string;
  itemId: ItemId;
  quantity: number;
  tileX: number;
  tileY: number;
}

export interface WorldMap {
  width: number;
  height: number;
  tiles: TileId[][];
  dockTile: { x: number; y: number };
  shipSpawn: { tx: number; ty: number; heading: 0 | 1 | 2 | 3 };
  groundItems: GroundItemSpawn[];
}

/** Generate a hand-crafted island with a dock extending into water. */
export function generateWorld(): WorldMap {
  const tiles: TileId[][] = [];
  for (let y = 0; y < MAP_H; y++) {
    const row: TileId[] = [];
    for (let x = 0; x < MAP_W; x++) row.push(Tile.Water);
    tiles.push(row);
  }

  // Island: rounded blob centered at (22, 24), radius ~11 sand, inner grass.
  const cx = 22;
  const cy = 24;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      // ellipse with a touch of noise for organic edge
      const noise = Math.sin(x * 0.9) * 0.8 + Math.cos(y * 0.7) * 0.8;
      const d = Math.sqrt(dx * dx + dy * dy * 1.15) + noise * 0.3;
      if (d < 8) tiles[y][x] = Tile.Grass;
      else if (d < 11) tiles[y][x] = Tile.Sand;
    }
  }

  // A few rocks scattered on the island
  const rocks: [number, number][] = [
    [18, 20],
    [26, 22],
    [24, 28],
    [19, 27],
  ];
  for (const [x, y] of rocks) tiles[y][x] = Tile.Rock;

  // Dock: runs east from sand edge into water
  const dockY = cy;
  let dockStartX = cx;
  // walk east until we leave sand
  while (dockStartX < MAP_W - 1 && tiles[dockY][dockStartX] !== Tile.Water) dockStartX++;
  const dockLen = 4;
  for (let i = 0; i < dockLen; i++) {
    const x = dockStartX + i;
    if (x < MAP_W) tiles[dockY][x] = Tile.Dock;
  }

  const dockTile = { x: dockStartX + dockLen - 1, y: dockY };

  // Ship sits immediately east of the dock, facing east (heading 1).
  // Docked bbox is 3 wide × 2 tall with top-left at (tx, ty). Stern-top tile
  // (tx, ty) is the gangplank, adjacent to the dock's east edge.
  const shipSpawn = {
    tx: dockTile.x + 1,
    ty: dockTile.y,
    heading: 1 as 0 | 1 | 2 | 3,
  };

  // Ensure ship footprint tiles are open water (guard against any overlap).
  for (let dx = 0; dx < 3; dx++) {
    for (let dy = 0; dy < 2; dy++) {
      const x = shipSpawn.tx + dx;
      const y = shipSpawn.ty + dy;
      if (tiles[y]?.[x] !== undefined && tiles[y][x] !== Tile.Dock) {
        tiles[y][x] = Tile.Water;
      }
    }
  }

  const groundItems = scatterItems(tiles, shipSpawn);

  return { width: MAP_W, height: MAP_H, tiles, dockTile, shipSpawn, groundItems };
}

const ITEM_SPAWNS: Array<{ itemId: ItemId; quantity: number }> = [
  { itemId: "rope", quantity: 1 },
  { itemId: "rope", quantity: 2 },
  { itemId: "plank", quantity: 1 },
  { itemId: "plank", quantity: 3 },
  { itemId: "fish", quantity: 1 },
  { itemId: "coin", quantity: 5 },
  { itemId: "coin", quantity: 12 },
  { itemId: "compass", quantity: 1 },
];

function scatterItems(
  tiles: TileId[][],
  shipSpawn: { tx: number; ty: number },
): GroundItemSpawn[] {
  // Deterministic PRNG so items land in the same spots every load.
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const shipTiles = new Set<string>();
  for (let dx = 0; dx < 3; dx++) {
    for (let dy = 0; dy < 2; dy++) {
      shipTiles.add(`${shipSpawn.tx + dx},${shipSpawn.ty + dy}`);
    }
  }

  const candidates: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const t = tiles[y][x];
      if (t !== Tile.Grass && t !== Tile.Sand) continue;
      if (shipTiles.has(`${x},${y}`)) continue;
      candidates.push({ x, y });
    }
  }

  const results: GroundItemSpawn[] = [];
  const used = new Set<string>();
  for (let i = 0; i < ITEM_SPAWNS.length && candidates.length > 0; i++) {
    let pick: { x: number; y: number } | null = null;
    for (let tries = 0; tries < 20; tries++) {
      const idx = Math.floor(rand() * candidates.length);
      const c = candidates[idx];
      if (!used.has(`${c.x},${c.y}`)) {
        pick = c;
        break;
      }
    }
    if (!pick) continue;
    used.add(`${pick.x},${pick.y}`);
    const spawn = ITEM_SPAWNS[i];
    results.push({
      id: `gi_${i}`,
      itemId: spawn.itemId,
      quantity: spawn.quantity,
      tileX: pick.x,
      tileY: pick.y,
    });
  }
  return results;
}
