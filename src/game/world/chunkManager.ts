import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { TileRegistry } from "./tileRegistry";
import { parseSpawns, type ParsedSpawns, type ShipSpawn, type DockSpawn, type ItemSpawn } from "./spawns";
import { ShapeCollider } from "./shapeCollision";

export interface WorldManifest {
  chunkSize: number;
  tileWidth: number;
  tileHeight: number;
  oceanGid: number;
  tilesetSource: string;
  startChunk: { cx: number; cy: number };
  authoredChunks: string[];
  /** Runtime-only: all tileset image paths referenced by any chunk, relative to
   *  public/maps/. Populated by the map build; not authored by hand. */
  tilesetImages?: string[];
}

export interface Chunk {
  cx: number;
  cy: number;
  tilemap: Phaser.Tilemaps.Tilemap;
  registry: TileRegistry;
  layers: Phaser.Tilemaps.TilemapLayer[];
  shapes: ShapeCollider;
}

export interface ChunkManagerOptions {
  scene: Phaser.Scene;
  manifest: WorldManifest;
  /** Phaser cache key prefix for each chunk's cached TMJ (e.g. "chunk_1_0"). */
  chunkKeyPrefix: string;
}

/** Phaser cache key for a tileset image, derived from its TMJ-relative path. */
export function tilesetImageKeyFor(imagePath: string): string {
  return `tileset:${imagePath}`;
}

/** Layer names that render above the player. Matched case-insensitively. */
const OVERHEAD_LAYERS = new Set(["props_high", "roof"]);
/** Base depth for overhead layers. Player is at 50; this comfortably clears it
 *  while preserving the TMJ-index ordering among overhead layers themselves. */
const OVERHEAD_DEPTH_BASE = 100;

/**
 * Owns all loaded authored chunks. Global tile queries dispatch to the chunk
 * containing (gtx, gty); tiles outside any loaded/authored chunk default to
 * open ocean — water, not blocked.
 */
interface AnimatedCell {
  layer: Phaser.Tilemaps.TilemapLayer;
  tileX: number;
  tileY: number;
  frames: number[]; // global gids
  durations: number[];
  totalMs: number;
  lastFrame: number;
}

export class ChunkManager {
  readonly manifest: WorldManifest;
  private readonly scene: Phaser.Scene;
  private readonly chunkKeyPrefix: string;
  private readonly chunks = new Map<string, Chunk>();
  private readonly animatedCells: AnimatedCell[] = [];
  private readonly overheadLayers: Phaser.Tilemaps.TilemapLayer[] = [];
  /** Function that applies a filter (e.g. an inverted mask) to an overhead
   *  layer. Stored so chunks loaded AFTER registration also get the effect. */
  private overheadFilter: ((layer: Phaser.Tilemaps.TilemapLayer) => void) | null = null;
  private elapsedMs = 0;

  /** Register a filter setup callback that's applied to every overhead layer
   *  (current and future). Typical use: attach an inverted mask filter so
   *  the roof cuts a hole around the player. */
  setOverheadFilter(apply: ((layer: Phaser.Tilemaps.TilemapLayer) => void) | null): void {
    this.overheadFilter = apply;
    if (!apply) return;
    for (const layer of this.overheadLayers) apply(layer);
  }

  constructor(opts: ChunkManagerOptions) {
    this.scene = opts.scene;
    this.manifest = opts.manifest;
    this.chunkKeyPrefix = opts.chunkKeyPrefix;
  }

  /** Advance animated tile frames. Call from the scene's update(). */
  tick(dtMs: number): void {
    this.elapsedMs += dtMs;
    for (const a of this.animatedCells) {
      const t = this.elapsedMs % a.totalMs;
      let acc = 0;
      let idx = 0;
      for (let i = 0; i < a.durations.length; i++) {
        acc += a.durations[i];
        if (t < acc) {
          idx = i;
          break;
        }
      }
      if (idx === a.lastFrame) continue;
      a.lastFrame = idx;
      const tile = a.layer.getTileAt(a.tileX, a.tileY);
      if (tile) tile.index = a.frames[idx];
    }
  }

  initialize(): ParsedSpawns {
    let ship: ShipSpawn | null = null;
    let dock: DockSpawn | null = null;
    const items: ItemSpawn[] = [];

    for (const key of this.manifest.authoredChunks) {
      const [cxStr, cyStr] = key.split("_");
      const cx = parseInt(cxStr, 10);
      const cy = parseInt(cyStr, 10);
      const chunk = this.instantiateChunk(cx, cy);

      const spawns = parseSpawns(chunk.tilemap, {
        offsetTx: cx * this.manifest.chunkSize,
        offsetTy: cy * this.manifest.chunkSize,
        requireShip: false,
        requireDock: false,
      });
      if (spawns.ship) {
        if (ship) throw new Error(`Multiple ship_spawn objects: chunks ${key} and prior`);
        ship = spawns.ship;
      }
      if (spawns.dock) {
        if (dock) throw new Error(`Multiple dock objects: chunks ${key} and prior`);
        dock = spawns.dock;
      }
      items.push(...spawns.items);
    }

    if (!ship) throw new Error("No ship_spawn object in any authored chunk.");
    if (!dock) throw new Error("No dock object in any authored chunk.");
    return { ship, dock, items };
  }

  isWater(gtx: number, gty: number): boolean {
    const chunk = this.chunkAtGlobalTile(gtx, gty);
    if (!chunk) return true;
    const s = this.manifest.chunkSize;
    return chunk.registry.isWater(gtx - chunk.cx * s, gty - chunk.cy * s);
  }

  isBlocked(gtx: number, gty: number): boolean {
    const chunk = this.chunkAtGlobalTile(gtx, gty);
    if (!chunk) return false;
    const s = this.manifest.chunkSize;
    return chunk.registry.isBlocked(gtx - chunk.cx * s, gty - chunk.cy * s);
  }

  isAnchorable(gtx: number, gty: number): boolean {
    const chunk = this.chunkAtGlobalTile(gtx, gty);
    if (!chunk) return true;
    const s = this.manifest.chunkSize;
    return chunk.registry.isAnchorable(gtx - chunk.cx * s, gty - chunk.cy * s);
  }

  isLandWalkable(gtx: number, gty: number): boolean {
    return !this.isWater(gtx, gty) && !this.isBlocked(gtx, gty);
  }

  /**
   * Pixel-precise blocking test. True if the tile at (gpx, gpy) has
   * `collides: true`, OR any per-tile / chunk-level collision shape covers
   * this pixel. Water is not considered here — walkability wraps both.
   */
  isBlockedPx(gpx: number, gpy: number): boolean {
    const gtx = Math.floor(gpx / TILE_SIZE);
    const gty = Math.floor(gpy / TILE_SIZE);
    const chunk = this.chunkAtGlobalTile(gtx, gty);
    if (!chunk) return false;
    const s = this.manifest.chunkSize;
    if (chunk.registry.isBlocked(gtx - chunk.cx * s, gty - chunk.cy * s)) return true;
    const chunkPxX = chunk.cx * s * TILE_SIZE;
    const chunkPxY = chunk.cy * s * TILE_SIZE;
    return chunk.shapes.isBlockedAtLocalPx(gpx - chunkPxX, gpy - chunkPxY);
  }

  authoredBoundsTiles(): { minTx: number; minTy: number; maxTx: number; maxTy: number } {
    let minCx = Infinity;
    let minCy = Infinity;
    let maxCx = -Infinity;
    let maxCy = -Infinity;
    for (const key of this.manifest.authoredChunks) {
      const [cxStr, cyStr] = key.split("_");
      const cx = parseInt(cxStr, 10);
      const cy = parseInt(cyStr, 10);
      if (cx < minCx) minCx = cx;
      if (cy < minCy) minCy = cy;
      if (cx > maxCx) maxCx = cx;
      if (cy > maxCy) maxCy = cy;
    }
    const s = this.manifest.chunkSize;
    return { minTx: minCx * s, minTy: minCy * s, maxTx: (maxCx + 1) * s, maxTy: (maxCy + 1) * s };
  }

  /** Chunks overlapping the given global-tile rectangle, with precomputed
   *  top-left world-pixel offsets. Used by debug overlays. */
  chunksInTileRect(
    tx0: number,
    ty0: number,
    tx1: number,
    ty1: number,
  ): Array<{ chunk: Chunk; chunkPxX: number; chunkPxY: number }> {
    const s = this.manifest.chunkSize;
    const cx0 = Math.floor(tx0 / s);
    const cy0 = Math.floor(ty0 / s);
    const cx1 = Math.floor((tx1 - 1) / s);
    const cy1 = Math.floor((ty1 - 1) / s);
    const out: Array<{ chunk: Chunk; chunkPxX: number; chunkPxY: number }> = [];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const chunk = this.chunks.get(`${cx}_${cy}`);
        if (!chunk) continue;
        out.push({
          chunk,
          chunkPxX: cx * s * TILE_SIZE,
          chunkPxY: cy * s * TILE_SIZE,
        });
      }
    }
    return out;
  }

  private chunkAtGlobalTile(gtx: number, gty: number): Chunk | null {
    const s = this.manifest.chunkSize;
    const cx = Math.floor(gtx / s);
    const cy = Math.floor(gty / s);
    return this.chunks.get(`${cx}_${cy}`) ?? null;
  }

  private instantiateChunk(cx: number, cy: number): Chunk {
    const cacheKey = `${this.chunkKeyPrefix}${cx}_${cy}`;
    const tilemap = this.scene.make.tilemap({ key: cacheKey });

    // Phaser's Tileset instances don't carry the raw `image` path string, so we
    // read the image path for each tileset from the cached TMJ JSON, matching
    // by tileset name.
    const cached = this.scene.cache.tilemap.get(cacheKey) as
      | { data?: { tilesets?: Array<{ name: string; image: string }> } }
      | undefined;
    const rawTilesets = cached?.data?.tilesets ?? [];
    const imageByName = new Map(rawTilesets.map((t) => [t.name, t.image]));

    // Bind every tileset declared in the chunk's TMJ to its preloaded image.
    const boundTilesets: Phaser.Tilemaps.Tileset[] = [];
    for (const tsDef of tilemap.tilesets) {
      const imagePath = imageByName.get(tsDef.name) ?? "";
      if (!imagePath) {
        throw new Error(
          `No image path for tileset '${tsDef.name}' in chunk ${cx},${cy}`,
        );
      }
      const imageKey = tilesetImageKeyFor(imagePath);
      const bound = tilemap.addTilesetImage(tsDef.name, imageKey);
      if (!bound) {
        throw new Error(
          `Failed to bind tileset '${tsDef.name}' (image '${imagePath}', key '${imageKey}') for chunk ${cx},${cy}`,
        );
      }
      boundTilesets.push(bound);
    }

    const renderScale = TILE_SIZE / tilemap.tileWidth;
    const chunkPxX = cx * this.manifest.chunkSize * TILE_SIZE;
    const chunkPxY = cy * this.manifest.chunkSize * TILE_SIZE;

    const layers: Phaser.Tilemaps.TilemapLayer[] = [];
    tilemap.layers.forEach((layerData, idx) => {
      const layer = tilemap.createLayer(layerData.name, boundTilesets, chunkPxX, chunkPxY) as
        | Phaser.Tilemaps.TilemapLayer
        | null;
      if (!layer) return;
      if (renderScale !== 1) layer.setScale(renderScale);
      // Overhead layers render above the player (depth 50 in Player.ts) so the
      // character passes under roofs, tree canopies, etc. All other layers keep
      // their TMJ index as depth.
      const overhead = OVERHEAD_LAYERS.has(layerData.name.toLowerCase());
      layer.setDepth(overhead ? OVERHEAD_DEPTH_BASE + idx : idx);
      if (overhead) {
        this.overheadLayers.push(layer);
        if (this.overheadFilter) this.overheadFilter(layer);
      }
      layers.push(layer);
    });

    const shapes = new ShapeCollider({
      tilemap,
      tileLayers: layers,
      chunkRawTmj: cached?.data,
      renderScale,
    });
    const chunk: Chunk = {
      cx,
      cy,
      tilemap,
      registry: new TileRegistry(tilemap),
      layers,
      shapes,
    };
    this.chunks.set(`${cx}_${cy}`, chunk);
    this.collectAnimations(chunk);
    return chunk;
  }

  /** Read per-tileset animation data and index every painted cell that uses
   *  an animated tile's base frame, so tick() can advance them cheaply. */
  private collectAnimations(chunk: Chunk): void {
    type TileData = Record<
      number,
      { animation?: Array<{ tileid: number; duration: number }> }
    >;
    for (const ts of chunk.tilemap.tilesets) {
      const tileData = (ts as unknown as { tileData?: TileData }).tileData;
      if (!tileData) continue;
      const firstgid = ts.firstgid;
      for (const localIdStr of Object.keys(tileData)) {
        const anim = tileData[parseInt(localIdStr, 10)]?.animation;
        if (!anim || anim.length < 2) continue;
        const frames = anim.map((a) => firstgid + a.tileid);
        const durations = anim.map((a) => a.duration);
        const totalMs = durations.reduce((a, b) => a + b, 0);
        // Find every cell across every layer whose index matches any frame in
        // this animation (author may have painted any frame as the "base").
        const frameSet = new Set(frames);
        for (const layer of chunk.layers) {
          layer.forEachTile((tile) => {
            if (frameSet.has(tile.index)) {
              this.animatedCells.push({
                layer,
                tileX: tile.x,
                tileY: tile.y,
                frames,
                durations,
                totalMs,
                lastFrame: -1,
              });
            }
          });
        }
      }
    }
  }
}
