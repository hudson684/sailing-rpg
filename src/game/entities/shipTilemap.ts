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
  /** Sailing collision rect, in ship-center-relative world pixels. Sourced from
   *  the `boat-hitbox` object layer in the per-heading tmj. */
  hitbox: HitboxRect;
  /** Helm interaction / player-placement rect, in ship-center-relative world
   *  pixels. Sourced from the `helm` object layer in the per-heading tmj. */
  helm: HelmRect;
}

export interface HitboxRect {
  offX: number;
  offY: number;
  w: number;
  h: number;
}

/** Shape identical to HitboxRect; named separately for call-site clarity. */
export type HelmRect = HitboxRect;

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
    | {
        data?: {
          tilesets?: Array<{ name: string; image: string }>;
          layers?: Array<{
            name: string;
            type: string;
            objects?: Array<{
              x: number;
              y: number;
              width?: number;
              height?: number;
              polygon?: Array<{ x: number; y: number }>;
            }>;
          }>;
        };
      }
    | undefined;
  const rawTilesets = cached?.data?.tilesets ?? [];
  const rawLayers = cached?.data?.layers ?? [];
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

  const widthPx = tilemap.widthInPixels * renderScale;
  const heightPx = tilemap.heightInPixels * renderScale;
  const hitbox = extractRectLayer(cacheKey, rawLayers, "boat-hitbox", renderScale, widthPx, heightPx);
  const helm = extractRectLayer(cacheKey, rawLayers, "helm", renderScale, widthPx, heightPx);

  return { tilemap, moving, idle, widthPx, heightPx, hitbox, helm };
}

function extractRectLayer(
  cacheKey: string,
  rawLayers: Array<{
    name: string;
    type: string;
    objects?: Array<{
      x: number;
      y: number;
      width?: number;
      height?: number;
      polygon?: Array<{ x: number; y: number }>;
    }>;
  }>,
  layerName: string,
  renderScale: number,
  widthPx: number,
  heightPx: number,
): HitboxRect {
  const layer = rawLayers.find(
    (l) => l.type === "objectgroup" && l.name === layerName,
  );
  const obj = layer?.objects?.[0];
  if (!layer || !obj) {
    throw new Error(`Ship tilemap ${cacheKey} is missing a '${layerName}' object.`);
  }
  let ox = obj.x;
  let oy = obj.y;
  let ow = obj.width ?? 0;
  let oh = obj.height ?? 0;
  if (Array.isArray(obj.polygon) && obj.polygon.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of obj.polygon) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    ox = obj.x + minX;
    oy = obj.y + minY;
    ow = maxX - minX;
    oh = maxY - minY;
  }
  if (ow <= 0 || oh <= 0) {
    throw new Error(`Ship tilemap ${cacheKey} has a zero-size '${layerName}' object.`);
  }
  return {
    offX: ox * renderScale - widthPx / 2,
    offY: oy * renderScale - heightPx / 2,
    w: ow * renderScale,
    h: oh * renderScale,
  };
}
