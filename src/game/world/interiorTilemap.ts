import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { interiorTilemapKey } from "../scenes/BootScene";
import { tilesetImageKeyFor } from "./chunkManager";
import { parseInteriorSpawns, type InteriorExitSpawn } from "./spawns";
import { TileRegistry } from "./tileRegistry";

const INTERIOR_OVERHEAD_LAYERS = new Set(["props_high", "roof"]);
const INTERIOR_OVERHEAD_DEPTH_BASE = 1_000_000;

export interface InteriorTilemap {
  key: string;
  tilemap: Phaser.Tilemaps.Tilemap;
  layers: Phaser.Tilemaps.TilemapLayer[];
  registry: TileRegistry;
  exits: InteriorExitSpawn[];
}

/** Build an interior tilemap from a cached TMJ. Shared by WorldScene (legacy
 *  load path pre-scene-split) and InteriorScene. */
export function buildInteriorTilemap(
  scene: Phaser.Scene,
  key: string,
): InteriorTilemap | null {
  const cacheKey = interiorTilemapKey(key);
  if (!scene.cache.tilemap.exists(cacheKey)) {
    console.error(`No cached interior tilemap '${cacheKey}'.`);
    return null;
  }
  const tilemap = scene.make.tilemap({ key: cacheKey });
  const cached = scene.cache.tilemap.get(cacheKey) as
    | { data?: { tilesets?: Array<{ name: string; image: string }> } }
    | undefined;
  const rawTilesets = cached?.data?.tilesets ?? [];
  const imageByName = new Map(rawTilesets.map((t) => [t.name, t.image]));

  const boundTilesets: Phaser.Tilemaps.Tileset[] = [];
  for (const tsDef of tilemap.tilesets) {
    const imagePath = imageByName.get(tsDef.name);
    if (!imagePath) {
      throw new Error(`Interior '${key}': no image path for tileset '${tsDef.name}'.`);
    }
    const bound = tilemap.addTilesetImage(tsDef.name, tilesetImageKeyFor(imagePath));
    if (!bound) {
      throw new Error(`Interior '${key}': failed to bind tileset '${tsDef.name}'.`);
    }
    boundTilesets.push(bound);
  }

  const renderScale = TILE_SIZE / tilemap.tileWidth;
  const layers: Phaser.Tilemaps.TilemapLayer[] = [];
  tilemap.layers.forEach((layerData, idx) => {
    const layer = tilemap.createLayer(layerData.name, boundTilesets, 0, 0) as
      | Phaser.Tilemaps.TilemapLayer
      | null;
    if (!layer) return;
    if (renderScale !== 1) layer.setScale(renderScale);
    const overhead = INTERIOR_OVERHEAD_LAYERS.has(layerData.name.toLowerCase());
    layer.setDepth(overhead ? INTERIOR_OVERHEAD_DEPTH_BASE + idx : idx);
    layers.push(layer);
  });

  const registry = new TileRegistry(tilemap);
  const { exits } = parseInteriorSpawns(tilemap);

  return { key, tilemap, layers, registry, exits };
}

export function destroyInteriorTilemap(t: InteriorTilemap): void {
  for (const layer of t.layers) layer.destroy();
  t.tilemap.destroy();
}

export function interiorPixelSize(t: InteriorTilemap): { w: number; h: number } {
  return {
    w: t.tilemap.width * TILE_SIZE,
    h: t.tilemap.height * TILE_SIZE,
  };
}
