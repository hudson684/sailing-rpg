import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { interiorTilemapKey } from "../assets/keys";
import { tilesetImageKeyFor } from "./chunkManager";
import { ShapeCollider } from "./shapeCollision";
import { parseInteriorSpawns, type InteriorExitSpawn } from "./spawns";
import { TileRegistry } from "./tileRegistry";

const INTERIOR_OVERHEAD_LAYERS = new Set(["props_high", "roof"]);
const INTERIOR_OVERHEAD_DEPTH_BASE = 1_000_000;

export interface InteriorTilemap {
  key: string;
  tilemap: Phaser.Tilemaps.Tilemap;
  layers: Phaser.Tilemaps.TilemapLayer[];
  registry: TileRegistry;
  shapes: ShapeCollider;
  exits: InteriorExitSpawn[];
  /** Per-tile images extracted from layers flagged with the `y-sort` custom
   *  property — each one gets its own depth so it sorts against the player
   *  (and other entities) by world y. */
  ySortImages: Phaser.GameObjects.Image[];
}

function layerHasYSort(layerData: Phaser.Tilemaps.LayerData): boolean {
  const props = layerData.properties as unknown;
  if (!props) return false;
  if (Array.isArray(props)) {
    for (const p of props as Array<{ name?: string; value?: unknown }>) {
      if (p?.name === "y-sort" && p.value === true) return true;
    }
    return false;
  }
  if (typeof props === "object") {
    return (props as Record<string, unknown>)["y-sort"] === true;
  }
  return false;
}

/** Replace a tilemap layer's visible render with per-tile Image game objects
 *  whose depth = the tile's bottom world y. The underlying tilemap layer is
 *  kept (for collision/registry queries) but hidden. */
function extractYSortImages(
  scene: Phaser.Scene,
  layer: Phaser.Tilemaps.TilemapLayer,
  renderScale: number,
): Phaser.GameObjects.Image[] {
  const out: Phaser.GameObjects.Image[] = [];
  const tmap = layer.tilemap;
  for (let ty = 0; ty < tmap.height; ty++) {
    for (let tx = 0; tx < tmap.width; tx++) {
      const tile = layer.getTileAt(tx, ty);
      if (!tile || tile.index < 0) continue;
      const tileset = tile.tileset;
      if (!tileset) continue;
      const coords = tileset.getTileTextureCoordinates(tile.index) as
        | { x: number; y: number }
        | null;
      if (!coords) continue;
      const imageKey = tileset.image?.key;
      if (!imageKey) continue;
      const tw = tileset.tileWidth;
      const th = tileset.tileHeight;
      const frameName = `ysort:${tile.index}`;
      const texture = scene.textures.get(imageKey);
      if (!texture.has(frameName)) {
        texture.add(frameName, 0, coords.x, coords.y, tw, th);
      }
      const wx = tx * tmap.tileWidth * renderScale;
      const wy = ty * tmap.tileHeight * renderScale;
      const img = scene.add
        .image(wx, wy, imageKey, frameName)
        .setOrigin(0, 0)
        .setScale(renderScale)
        .setDepth(wy + th * renderScale);
      out.push(img);
    }
  }
  layer.setVisible(false);
  return out;
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
    | { data?: unknown & { tilesets?: Array<{ name: string; image: string }> } }
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
  const ySortImages: Phaser.GameObjects.Image[] = [];
  tilemap.layers.forEach((layerData, idx) => {
    const layer = tilemap.createLayer(layerData.name, boundTilesets, 0, 0) as
      | Phaser.Tilemaps.TilemapLayer
      | null;
    if (!layer) return;
    if (renderScale !== 1) layer.setScale(renderScale);
    const overhead = INTERIOR_OVERHEAD_LAYERS.has(layerData.name.toLowerCase());
    layer.setDepth(overhead ? INTERIOR_OVERHEAD_DEPTH_BASE + idx : idx);
    layers.push(layer);
    if (layerHasYSort(layerData)) {
      const imgs = extractYSortImages(scene, layer, renderScale);
      for (const img of imgs) ySortImages.push(img);
    }
  });

  const registry = new TileRegistry(tilemap);
  const shapes = new ShapeCollider({
    tilemap,
    tileLayers: layers,
    rawTmj: cached?.data,
    renderScale,
  });
  const { exits } = parseInteriorSpawns(tilemap);

  return { key, tilemap, layers, registry, shapes, exits, ySortImages };
}

export function destroyInteriorTilemap(t: InteriorTilemap): void {
  for (const img of t.ySortImages) img.destroy();
  for (const layer of t.layers) layer.destroy();
  t.tilemap.destroy();
}

export function interiorPixelSize(t: InteriorTilemap): { w: number; h: number } {
  return {
    w: t.tilemap.width * TILE_SIZE,
    h: t.tilemap.height * TILE_SIZE,
  };
}
