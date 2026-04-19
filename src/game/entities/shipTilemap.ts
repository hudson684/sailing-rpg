import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { tilesetImageKeyFor } from "../world/chunkManager";
import { shipTilemapKey, type VesselTemplate } from "./vessels";
import type { Heading } from "./Ship";

export interface ShipVisualLayers {
  tilemap: Phaser.Tilemaps.Tilemap;
  moving: Phaser.Tilemaps.TilemapLayer;
  idle: Phaser.Tilemaps.TilemapLayer;
  /** Pixel width of the tilemap (widthInTiles × TILE_SIZE). */
  widthPx: number;
  /** Pixel height of the tilemap (heightInTiles × TILE_SIZE). */
  heightPx: number;
}

/** Instantiate a ship's per-heading tilemap and both layers ("moving" + "idle").
 *  Layers live at scene-level (TilemapLayers cannot be Container children) and
 *  the caller is responsible for positioning, depth, and visibility. */
export function createShipVisual(
  scene: Phaser.Scene,
  vessel: VesselTemplate,
  heading: Heading,
): ShipVisualLayers {
  const cacheKey = shipTilemapKey(vessel, heading);
  const tilemap = scene.make.tilemap({ key: cacheKey });

  const cached = scene.cache.tilemap.get(cacheKey) as
    | { data?: { tilesets?: Array<{ name: string; image: string }> } }
    | undefined;
  const rawTilesets = cached?.data?.tilesets ?? [];
  if (rawTilesets.length !== tilemap.tilesets.length) {
    throw new Error(
      `Ship tileset count mismatch for ${cacheKey}: raw=${rawTilesets.length} parsed=${tilemap.tilesets.length}`,
    );
  }

  const textureManager = scene.sys.textures;
  const bound: Phaser.Tilemaps.Tileset[] = [];
  for (let i = 0; i < tilemap.tilesets.length; i++) {
    const tileset = tilemap.tilesets[i];
    const imagePath = rawTilesets[i]?.image ?? "";
    if (!imagePath) {
      throw new Error(`No image path for tileset '${tileset.name}' in ${cacheKey}`);
    }
    const imageKey = tilesetImageKeyFor(imagePath);
    if (!textureManager.exists(imageKey)) {
      throw new Error(
        `Texture '${imageKey}' not loaded for tileset '${tileset.name}' in ${cacheKey}`,
      );
    }
    tileset.setImage(textureManager.get(imageKey));
    bound.push(tileset);
  }

  const moving = tilemap.createLayer("moving", bound, 0, 0) as Phaser.Tilemaps.TilemapLayer | null;
  const idle = tilemap.createLayer("idle", bound, 0, 0) as Phaser.Tilemaps.TilemapLayer | null;
  if (!moving || !idle) {
    throw new Error(`Ship tilemap ${cacheKey} is missing a 'moving' or 'idle' layer.`);
  }

  const renderScale = TILE_SIZE / tilemap.tileWidth;
  if (renderScale !== 1) {
    moving.setScale(renderScale);
    idle.setScale(renderScale);
  }

  return {
    tilemap,
    moving,
    idle,
    widthPx: tilemap.widthInPixels * renderScale,
    heightPx: tilemap.heightInPixels * renderScale,
  };
}
