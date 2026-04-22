import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { TileRegistry } from "./tileRegistry";
import {
  parseSpawns,
  type ParsedSpawns,
} from "./spawns";
import { ShapeCollider } from "./shapeCollision";
import { emitLoaderEvent } from "../assets/loaderBus";

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
  /** Per-chunk tileset image paths (same paths as in `tilesetImages`, but
   *  bucketed by chunk key `"<cx>_<cy>"`). Lets the runtime lazy-load a
   *  chunk's tilesets without first fetching the TMJ. Populated by the map
   *  build; not authored by hand. */
  chunkTilesets?: Record<string, string[]>;
  /** Per-chunk entity def ids (NPC / enemy / gathering-node) whose
   *  instances spawn inside that chunk, derived from src/game/data/*.json
   *  at build time. Chunks with no entity refs are absent from the map. */
  chunkSpawnRefs?: Record<string, { npcs: string[]; enemies: string[]; nodes: string[] }>;
  /** Map of interior keys → TMJ path (relative to public/maps/). Populated by
   *  the map build pipeline from maps/interiors/*.tmx. Optional: a world
   *  without any interior buildings will simply omit this. */
  interiors?: Record<string, { path: string }>;
  /** Map of ship keys (e.g. `galleon-n`) → TMJ path. Populated by the build
   *  pipeline from ships/*.tmx. One tmj per (ship def × heading). */
  ships?: Record<string, { path: string }>;
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
  /** Called when a chunk finishes instantiating — i.e. its tilesets are in
   *  the texture cache and its TilemapLayers exist. Fires synchronously from
   *  `initialize()` for chunks whose tilesets were preloaded, and later from
   *  `streamRemainingChunks()` as background loads complete. Use it to
   *  register the chunk's authored spawns with scene-level systems. */
  onChunkReady?: (chunk: Chunk, spawns: ParsedSpawns) => void;
}

/** Phaser cache key for a tileset image, derived from its TMJ-relative path. */
export function tilesetImageKeyFor(imagePath: string): string {
  return `tileset:${imagePath}`;
}

/** Layer names that render above the player. Matched case-insensitively. */
const OVERHEAD_LAYERS = new Set(["props_high", "roof"]);
/** Subset of overhead layers that also fade when the player walks under them.
 *  props_high (e.g. lanterns, signs) renders above the player but shouldn't
 *  dim — you just pass behind it. Only solid coverings like roofs fade. */
const FADABLE_OVERHEAD_LAYERS = new Set(["roof"]);

/** Edge order: [right, left, down, up]. A tile edge is "opaque" if it has any
 *  non-transparent pixels. Two tiles only connect across a shared edge if BOTH
 *  of their facing edges are opaque — this prevents flood fills from crossing
 *  through transparent gutters (e.g. one roof tile's right half is empty and
 *  the next roof tile's left half is empty, even though the cells are adjacent). */
type EdgeOpacity = [boolean, boolean, boolean, boolean];
const edgeCache = new Map<number, EdgeOpacity>(); // key: gid
const tilesetImageData = new WeakMap<Phaser.Tilemaps.Tileset, ImageData | null>();
const ALPHA_THRESHOLD = 32;
const EDGE_OPAQUE_FRACTION = 0.1;

function getTilesetImageData(ts: Phaser.Tilemaps.Tileset): ImageData | null {
  if (tilesetImageData.has(ts)) return tilesetImageData.get(ts) ?? null;
  const img = ts.image?.getSourceImage?.() as
    | HTMLImageElement
    | HTMLCanvasElement
    | undefined;
  if (!img) {
    tilesetImageData.set(ts, null);
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    tilesetImageData.set(ts, null);
    return null;
  }
  ctx.drawImage(img as CanvasImageSource, 0, 0);
  try {
    const data = ctx.getImageData(0, 0, img.width, img.height);
    tilesetImageData.set(ts, data);
    return data;
  } catch {
    tilesetImageData.set(ts, null);
    return null; // CORS — fall back to treating all edges as opaque
  }
}

function computeEdgeOpacity(
  tilemap: Phaser.Tilemaps.Tilemap,
  gid: number,
): EdgeOpacity | null {
  const cached = edgeCache.get(gid);
  if (cached) return cached;
  for (const ts of tilemap.tilesets) {
    if (gid < ts.firstgid || gid >= ts.firstgid + ts.total) continue;
    const imgData = getTilesetImageData(ts);
    if (!imgData) return null;
    const coords = ts.getTileTextureCoordinates(gid) as
      | { x: number; y: number }
      | null;
    if (!coords) return null;
    const tw = ts.tileWidth;
    const th = ts.tileHeight;
    const W = imgData.width;
    const data = imgData.data;
    let right = 0;
    let left = 0;
    let down = 0;
    let up = 0;
    for (let i = 0; i < th; i++) {
      const y = coords.y + i;
      const aL = data[(y * W + coords.x) * 4 + 3];
      const aR = data[(y * W + coords.x + tw - 1) * 4 + 3];
      if (aL >= ALPHA_THRESHOLD) left++;
      if (aR >= ALPHA_THRESHOLD) right++;
    }
    for (let j = 0; j < tw; j++) {
      const x = coords.x + j;
      const aU = data[(coords.y * W + x) * 4 + 3];
      const aD = data[((coords.y + th - 1) * W + x) * 4 + 3];
      if (aU >= ALPHA_THRESHOLD) up++;
      if (aD >= ALPHA_THRESHOLD) down++;
    }
    const minH = Math.max(1, Math.floor(tw * EDGE_OPAQUE_FRACTION));
    const minV = Math.max(1, Math.floor(th * EDGE_OPAQUE_FRACTION));
    const edges: EdgeOpacity = [
      right >= minV,
      left >= minV,
      down >= minH,
      up >= minH,
    ];
    edgeCache.set(gid, edges);
    return edges;
  }
  return null;
}

/** 4-connected BFS across non-empty cells of `layer`, starting at (sx, sy).
 *  Only crosses a shared edge if both tiles have opaque pixels along it.
 *  Capped to avoid pathological layer-spanning fills. */
function floodFillLayer(
  layer: Phaser.Tilemaps.TilemapLayer,
  sx: number,
  sy: number,
  cap: number,
): Set<string> {
  const out = new Set<string>();
  const start = layer.getTileAt(sx, sy);
  if (!start) return out;
  out.add(`${sx},${sy}`);
  const queue: Array<[number, number]> = [[sx, sy]];
  // [dx, dy, currentEdgeIdx, neighborEdgeIdx] — indices into EdgeOpacity.
  const dirs: Array<[number, number, number, number]> = [
    [1, 0, 0, 1], // move right: need current.right AND neighbor.left
    [-1, 0, 1, 0], // move left:  need current.left  AND neighbor.right
    [0, 1, 2, 3], // move down:  need current.down  AND neighbor.up
    [0, -1, 3, 2], // move up:    need current.up    AND neighbor.down
  ];
  while (queue.length > 0 && out.size < cap) {
    const [x, y] = queue.shift()!;
    const current = layer.getTileAt(x, y);
    if (!current) continue;
    const curEdges = computeEdgeOpacity(layer.tilemap, current.index);
    for (const [dx, dy, ce, ne] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (out.has(key)) continue;
      const neighbor = layer.getTileAt(nx, ny);
      if (!neighbor) continue;
      const neighborEdges = computeEdgeOpacity(layer.tilemap, neighbor.index);
      // If edge data is unavailable (CORS, missing source), fall back to
      // treating the connection as valid so we don't break existing maps.
      if (curEdges && !curEdges[ce]) continue;
      if (neighborEdges && !neighborEdges[ne]) continue;
      out.add(key);
      queue.push([nx, ny]);
    }
  }
  return out;
}
/** Base depth for overhead layers. Entities y-sort by their world y (pixels),
 *  so this sits well above any plausible y to keep roofs/canopies on top. */
const OVERHEAD_DEPTH_BASE = 1_000_000;

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
  /** Per-layer fade bookkeeping. `targetKeys` = tiles that should be faded this
   *  frame (the connected region under the player). `trackedKeys` = all tiles
   *  we're currently easing (target ∪ tiles easing back to 1). Anchor caches
   *  the last flood-fill root so we don't recompute while the player stands
   *  still on the same roof tile. */
  private readonly overheadFade = new WeakMap<
    Phaser.Tilemaps.TilemapLayer,
    {
      anchor: { lx: number; ly: number } | null;
      targetKeys: Set<string>;
      trackedKeys: Set<string>;
    }
  >();
  private elapsedMs = 0;

  /** Per-frame: for each overhead layer, fade only the connected region of
   *  tiles under the player (BFS from the player's cell on that layer).
   *  Tiles outside the region ease back to full opacity. */
  updateOverheadFade(playerGtx: number, playerGty: number, dtMs: number): void {
    const FADED_ALPHA = 0.3;
    const FADE_RATE = 8; // e-folds per second
    const t = 1 - Math.exp(-FADE_RATE * (dtMs / 1000));
    const s = this.manifest.chunkSize;
    const cx = Math.floor(playerGtx / s);
    const cy = Math.floor(playerGty / s);
    const ownerChunk = this.chunks.get(`${cx}_${cy}`) ?? null;
    const lx = playerGtx - cx * s;
    const ly = playerGty - cy * s;

    for (const layer of this.overheadLayers) {
      let state = this.overheadFade.get(layer);
      if (!state) {
        state = { anchor: null, targetKeys: new Set(), trackedKeys: new Set() };
        this.overheadFade.set(layer, state);
      }

      const onThisLayer =
        ownerChunk != null &&
        layer.tilemap === ownerChunk.tilemap &&
        !!layer.getTileAt(lx, ly);

      if (!onThisLayer) {
        state.anchor = null;
        state.targetKeys = new Set();
      } else if (
        !state.anchor ||
        state.anchor.lx !== lx ||
        state.anchor.ly !== ly
      ) {
        state.anchor = { lx, ly };
        state.targetKeys = floodFillLayer(layer, lx, ly, 600);
      }

      // Union target into tracked so newly entered tiles get eased.
      for (const k of state.targetKeys) state.trackedKeys.add(k);

      if (state.trackedKeys.size === 0) continue;

      const done: string[] = [];
      for (const key of state.trackedKeys) {
        const target = state.targetKeys.has(key) ? FADED_ALPHA : 1;
        const [txStr, tyStr] = key.split(",");
        const tile = layer.getTileAt(parseInt(txStr, 10), parseInt(tyStr, 10));
        if (!tile) {
          done.push(key);
          continue;
        }
        const next = tile.alpha + (target - tile.alpha) * t;
        const settled = Math.abs(next - target) < 0.002;
        tile.setAlpha(settled ? target : next);
        if (settled && target === 1) done.push(key);
      }
      for (const k of done) state.trackedKeys.delete(k);
    }
  }

  private readonly onChunkReady?: (chunk: Chunk, spawns: ParsedSpawns) => void;

  constructor(opts: ChunkManagerOptions) {
    this.scene = opts.scene;
    this.manifest = opts.manifest;
    this.chunkKeyPrefix = opts.chunkKeyPrefix;
    this.onChunkReady = opts.onChunkReady;
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

  /** Authored chunks whose tilesets aren't loaded yet. They don't render
   *  and their spawns aren't parsed until `streamRemainingChunks` pulls
   *  their tilesets in and `instantiateChunk` runs. */
  private readonly pending = new Map<string, { cx: number; cy: number }>();
  private streamingStarted = false;

  initialize(): void {
    for (const key of this.manifest.authoredChunks) {
      const [cxStr, cyStr] = key.split("_");
      const cx = parseInt(cxStr, 10);
      const cy = parseInt(cyStr, 10);

      if (this.tilesetsLoaded(cx, cy)) {
        // Fires `onChunkReady` with parsed spawns once layers exist.
        this.instantiateChunk(cx, cy);
      } else {
        // Spawns for pending chunks are parsed when the chunk streams in —
        // see `instantiateChunk`. Pending chunks read as ocean in the
        // meantime, so their items/doors aren't reachable anyway.
        this.pending.set(key, { cx, cy });
      }
    }
  }

  /** Kick off background loads for every tileset image referenced by a
   *  pending chunk, then instantiate each chunk as soon as all of its
   *  tilesets are available. Idempotent — safe to call once after
   *  WorldScene.create() finishes. */
  streamRemainingChunks(): void {
    if (this.streamingStarted || this.pending.size === 0) return;
    this.streamingStarted = true;

    const needed = new Set<string>();
    for (const { cx, cy } of this.pending.values()) {
      const paths = this.manifest.chunkTilesets?.[`${cx}_${cy}`] ?? [];
      for (const path of paths) {
        if (!this.scene.sys.textures.exists(tilesetImageKeyFor(path))) {
          needed.add(path);
        }
      }
    }
    if (needed.size === 0) {
      // Tilesets already cached (e.g. shared with start chunk) — flush now.
      this.flushReadyPending();
      return;
    }

    for (const path of needed) {
      this.scene.load.image(tilesetImageKeyFor(path), `maps/${path}`);
    }
    const total = needed.size;
    let loaded = 0;
    emitLoaderEvent(this.scene, {
      kind: "stream-start",
      reason: "chunk-tilesets",
      total,
    });
    // Re-check pending whenever a tileset image finishes so chunks whose deps
    // are all in cache pop in as soon as they're ready, instead of waiting for
    // the entire batch. Phaser's catch-all `filecomplete` event fires for
    // every loaded file; filter by type + our key prefix.
    const onFile = (key: string, type: string) => {
      if (type !== "image" || !key.startsWith("tileset:")) return;
      loaded++;
      emitLoaderEvent(this.scene, {
        kind: "stream-progress",
        progress: total === 0 ? 1 : loaded / total,
      });
      this.flushReadyPending();
    };
    this.scene.load.on("filecomplete", onFile);
    this.scene.load.once("complete", () => {
      this.flushReadyPending();
      this.scene.load.off("filecomplete", onFile);
      emitLoaderEvent(this.scene, {
        kind: "stream-complete",
        reason: "chunk-tilesets",
      });
    });
    this.scene.load.start();
  }

  private flushReadyPending(): void {
    if (this.pending.size === 0) return;
    for (const [key, { cx, cy }] of [...this.pending]) {
      if (!this.tilesetsLoaded(cx, cy)) continue;
      this.instantiateChunk(cx, cy);
      this.pending.delete(key);
    }
  }

  private tilesetsLoaded(cx: number, cy: number): boolean {
    const paths = this.manifest.chunkTilesets?.[`${cx}_${cy}`];
    if (!paths) {
      // No per-chunk metadata — assume the legacy global preload was used.
      return true;
    }
    const textures = this.scene.sys.textures;
    for (const path of paths) {
      if (!textures.exists(tilesetImageKeyFor(path))) return false;
    }
    return true;
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

  shipTileState(gtx: number, gty: number): "water" | "beach" | "blocked" {
    const chunk = this.chunkAtGlobalTile(gtx, gty);
    if (!chunk) return "water";
    const s = this.manifest.chunkSize;
    return chunk.registry.shipTileState(gtx - chunk.cx * s, gty - chunk.cy * s);
  }

  isLandWalkable(gtx: number, gty: number): boolean {
    return !this.isWater(gtx, gty) && !this.isBlocked(gtx, gty);
  }

  fishingSurface(gtx: number, gty: number): string | null {
    const chunk = this.chunkAtGlobalTile(gtx, gty);
    if (!chunk) return "ocean"; // unloaded area beyond authored chunks is open sea
    const s = this.manifest.chunkSize;
    return chunk.registry.fishingSurface(gtx - chunk.cx * s, gty - chunk.cy * s);
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

  /** Iterate every loaded chunk. Used by callers that need to bulk-toggle
   *  visibility (e.g. hiding the world while inside a building). */
  loadedChunks(): Iterable<Chunk> {
    return this.chunks.values();
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
    // read image paths from the cached TMJ JSON. We pair by index (not by name)
    // because some chunks embed two tilesets that share a `name` — e.g. the
    // Grass-Land and Sea-Adventures packs both ship a tsx named
    // "beach - with thick foam". Phaser's addTilesetImage() looks up by name
    // and only ever matches the first, so calling it for each duplicate would
    // rebind the same Tileset twice and leave the other untextured.
    const cached = this.scene.cache.tilemap.get(cacheKey) as
      | { data?: { tilesets?: Array<{ name: string; image: string }> } }
      | undefined;
    const rawTilesets = cached?.data?.tilesets ?? [];
    if (rawTilesets.length !== tilemap.tilesets.length) {
      throw new Error(
        `Tileset count mismatch for chunk ${cx},${cy}: raw=${rawTilesets.length} parsed=${tilemap.tilesets.length}`,
      );
    }

    const textureManager = this.scene.sys.textures;
    const boundTilesets: Phaser.Tilemaps.Tileset[] = [];
    for (let i = 0; i < tilemap.tilesets.length; i++) {
      const tileset = tilemap.tilesets[i];
      const imagePath = rawTilesets[i]?.image ?? "";
      if (!imagePath) {
        throw new Error(
          `No image path for tileset '${tileset.name}' in chunk ${cx},${cy}`,
        );
      }
      const imageKey = tilesetImageKeyFor(imagePath);
      if (!textureManager.exists(imageKey)) {
        throw new Error(
          `Texture '${imageKey}' not loaded for tileset '${tileset.name}' in chunk ${cx},${cy}`,
        );
      }
      tileset.setImage(textureManager.get(imageKey));
      boundTilesets.push(tileset);
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
      if (overhead && FADABLE_OVERHEAD_LAYERS.has(layerData.name.toLowerCase())) {
        this.overheadLayers.push(layer);
      }
      layers.push(layer);
    });

    const shapes = new ShapeCollider({
      tilemap,
      tileLayers: layers,
      rawTmj: cached?.data,
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

    if (this.onChunkReady) {
      const spawns = parseSpawns(tilemap, {
        offsetTx: cx * this.manifest.chunkSize,
        offsetTy: cy * this.manifest.chunkSize,
      });
      this.onChunkReady(chunk, spawns);
    }

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
