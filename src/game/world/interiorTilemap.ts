import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { interiorTilemapKey } from "../assets/keys";
import { tilesetImageKeyFor } from "./chunkManager";
import { ShapeCollider } from "./shapeCollision";
import {
  parseInteriorSpawns,
  type InteriorEntrySpawn,
  type InteriorExitSpawn,
  type RepairTargetSpawn,
  type SeatSpawn,
  type WorkstationSpawn,
} from "./spawns";
import { TileRegistry } from "./tileRegistry";
import { businessIdForInteriorKey } from "../business/registry";
import { useBusinessStore } from "../business/businessStore";

const INTERIOR_OVERHEAD_LAYERS = new Set(["props_high", "roof"]);
const INTERIOR_OVERHEAD_DEPTH_BASE = 1_000_000;

export interface InteriorTilemap {
  key: string;
  tilemap: Phaser.Tilemaps.Tilemap;
  layers: Phaser.Tilemaps.TilemapLayer[];
  registry: TileRegistry;
  shapes: ShapeCollider;
  exits: InteriorExitSpawn[];
  entries: InteriorEntrySpawn[];
  repairTargets: RepairTargetSpawn[];
  workstations: WorkstationSpawn[];
  seats: SeatSpawn[];
  /** Per-tile images extracted from layers flagged with the `y-sort` custom
   *  property — each one gets its own depth so it sorts against the player
   *  (and other entities) by world y. */
  ySortImages: Phaser.GameObjects.Image[];
  /** Unsubscribes the visibility-gating subscription from `useBusinessStore`.
   *  Called by `destroyInteriorTilemap`. */
  unsubscribe: () => void;
}

/** Parse a layer name following the `<base>@tier:<nodeId>` convention. Layers
 *  without the suffix gate on nothing (always visible). */
export function parseGatedLayerName(name: string): {
  base: string;
  gateNodeId: string | null;
} {
  const m = /^(.+)@tier:([A-Za-z0-9_]+)$/.exec(name);
  if (!m) return { base: name, gateNodeId: null };
  return { base: m[1], gateNodeId: m[2] };
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
  /** Tile + ysort-image pairs keyed by gateNodeId, for live visibility flips. */
  const gatedTileLayers = new Map<string, Phaser.Tilemaps.TilemapLayer[]>();
  const gatedYSortImages = new Map<string, Phaser.GameObjects.Image[]>();

  tilemap.layers.forEach((layerData, idx) => {
    const { gateNodeId } = parseGatedLayerName(layerData.name);
    const layer = tilemap.createLayer(layerData.name, boundTilesets, 0, 0) as
      | Phaser.Tilemaps.TilemapLayer
      | null;
    if (!layer) return;
    if (renderScale !== 1) layer.setScale(renderScale);
    const overhead = INTERIOR_OVERHEAD_LAYERS.has(layerData.name.toLowerCase());
    layer.setDepth(overhead ? INTERIOR_OVERHEAD_DEPTH_BASE + idx : idx);
    layers.push(layer);
    if (gateNodeId) {
      const list = gatedTileLayers.get(gateNodeId) ?? [];
      list.push(layer);
      gatedTileLayers.set(gateNodeId, list);
    }
    if (layerHasYSort(layerData)) {
      const imgs = extractYSortImages(scene, layer, renderScale);
      for (const img of imgs) ySortImages.push(img);
      if (gateNodeId) {
        const list = gatedYSortImages.get(gateNodeId) ?? [];
        list.push(...imgs);
        gatedYSortImages.set(gateNodeId, list);
      }
    }
  });

  // Object-layer gating (Tiled object layers can also carry @tier:). The
  // tilemap doesn't materialize them as game objects; gameplay code that
  // reads object layers should additionally filter using
  // `objectLayerGateNodeId(name)` (see helper below).

  const registry = new TileRegistry(tilemap);
  const shapes = new ShapeCollider({
    tilemap,
    tileLayers: layers,
    rawTmj: cached?.data,
    renderScale,
  });
  const { exits, entries, repairTargets, workstations, seats } = parseInteriorSpawns(tilemap);

  // ─── Visibility gating ──────────────────────────────────────────────────
  // Look up the business that "owns" this interior. If none, every gated
  // layer stays hidden — no business → no unlocks possible.
  const ownerId = businessIdForInteriorKey(key);

  const applyVisibility = (unlocked: ReadonlySet<string>) => {
    for (const [nodeId, lyrs] of gatedTileLayers) {
      const visible = unlocked.has(nodeId);
      for (const l of lyrs) l.setVisible(visible);
    }
    for (const [nodeId, imgs] of gatedYSortImages) {
      const visible = unlocked.has(nodeId);
      for (const img of imgs) img.setVisible(visible);
    }
  };

  const initialUnlocked = ownerId
    ? new Set(useBusinessStore.getState().get(ownerId)?.unlockedNodes ?? [])
    : new Set<string>();
  applyVisibility(initialUnlocked);

  let lastSig = serializeUnlocked(initialUnlocked);
  const unsubscribe = ownerId
    ? useBusinessStore.subscribe((s) => {
        const cur = s.byId[ownerId]?.unlockedNodes ?? [];
        const set = new Set(cur);
        const sig = serializeUnlocked(set);
        if (sig === lastSig) return;
        lastSig = sig;
        applyVisibility(set);
      })
    : () => {};

  return {
    key,
    tilemap,
    layers,
    registry,
    shapes,
    exits,
    entries,
    repairTargets,
    workstations,
    seats,
    ySortImages,
    unsubscribe,
  };
}

function serializeUnlocked(set: ReadonlySet<string>): string {
  return [...set].sort().join("|");
}

export function destroyInteriorTilemap(t: InteriorTilemap): void {
  t.unsubscribe();
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
