import * as Phaser from "phaser";

/**
 * Sub-tile collision shapes. Two sources are supported:
 *
 *  1. Per-tile shapes authored in the Tiled Tile Collision Editor. These live
 *     on the tileset and apply wherever that tile is painted (e.g. a small
 *     rect around a dock pole). Phaser surfaces them via `Tileset.tileData`.
 *
 *  2. Map-level shapes authored as objects on a TMJ object layer named
 *     `collision`. These are one-off obstacles for a given map (e.g. a cliff
 *     edge polyline in a world chunk, or an interior wall). Read directly
 *     from the cached TMJ JSON.
 *
 * All shapes are stored in the map's local pixel space (origin at the map's
 * top-left), scaled by `renderScale = TILE_SIZE / tilemap.tileWidth` so
 * authored coords stay authoring-tool-native and match world rendering.
 *
 * The any-shape-wins rule mirrors the tile-property rule: if any shape from
 * any layer covers the query point, it's blocked.
 */

export type CollisionShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "polygon"; points: Array<{ x: number; y: number }> }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number };

/** Per-GID template list, in tile-local pixels (unscaled, authored-tile space). */
export type TileShapeMap = Map<number, CollisionShape[]>;

/** Raw TMJ object shape as serialized by Tiled. */
interface RawTiledObject {
  x: number;
  y: number;
  width?: number;
  height?: number;
  ellipse?: boolean;
  polygon?: Array<{ x: number; y: number }>;
  polyline?: Array<{ x: number; y: number }>;
}

interface RawTileDef {
  id?: number;
  objectgroup?: { objects?: RawTiledObject[] };
}

interface RawTmjData {
  tilesets?: Array<{ firstgid: number; tiles?: RawTileDef[] }>;
  layers?: Array<{
    name: string;
    type: string;
    objects?: RawTiledObject[];
  }>;
}

function parseObjects(raw: RawTiledObject[] | undefined): CollisionShape[] {
  if (!raw) return [];
  const out: CollisionShape[] = [];
  for (const o of raw) {
    if (o.polygon && o.polygon.length >= 3) {
      out.push({
        kind: "polygon",
        points: o.polygon.map((p) => ({ x: o.x + p.x, y: o.y + p.y })),
      });
    } else if (o.ellipse && o.width && o.height) {
      out.push({
        kind: "ellipse",
        cx: o.x + o.width / 2,
        cy: o.y + o.height / 2,
        rx: o.width / 2,
        ry: o.height / 2,
      });
    } else if (o.width && o.height) {
      out.push({ kind: "rect", x: o.x, y: o.y, w: o.width, h: o.height });
      // polylines are treated as non-blocking (open shapes); ignore.
    }
  }
  return out;
}

/**
 * Build a GID → shape-templates map from a Phaser tilemap's tilesets. Shapes
 * are returned in tile-local authored pixels; callers scale to world units.
 */
export function buildTileShapeMap(tilemap: Phaser.Tilemaps.Tilemap): TileShapeMap {
  const map: TileShapeMap = new Map();
  type TileData = Record<number, RawTileDef>;
  for (const ts of tilemap.tilesets) {
    const tileData = (ts as unknown as { tileData?: TileData }).tileData;
    if (!tileData) continue;
    for (const localIdStr of Object.keys(tileData)) {
      const localId = parseInt(localIdStr, 10);
      const shapes = parseObjects(tileData[localId]?.objectgroup?.objects);
      if (shapes.length > 0) map.set(ts.firstgid + localId, shapes);
    }
  }
  return map;
}

/**
 * Collect shapes from a TMJ object layer named `collision`. Returns [] if the
 * layer is absent. Shapes are in map-local authored pixels.
 */
export function parseObjectLayerShapes(raw: RawTmjData | undefined): CollisionShape[] {
  if (!raw?.layers) return [];
  const layer = raw.layers.find(
    (l) => l.type === "objectgroup" && l.name.toLowerCase() === "collision",
  );
  return parseObjects(layer?.objects);
}

function pointInRect(px: number, py: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

function pointInEllipse(
  px: number,
  py: number,
  e: { cx: number; cy: number; rx: number; ry: number },
): boolean {
  if (e.rx <= 0 || e.ry <= 0) return false;
  const dx = (px - e.cx) / e.rx;
  const dy = (py - e.cy) / e.ry;
  return dx * dx + dy * dy <= 1;
}

function pointInPolygon(px: number, py: number, pts: Array<{ x: number; y: number }>): boolean {
  // Ray casting.
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const intersects =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInShape(px: number, py: number, s: CollisionShape): boolean {
  switch (s.kind) {
    case "rect": return pointInRect(px, py, s);
    case "ellipse": return pointInEllipse(px, py, s);
    case "polygon": return pointInPolygon(px, py, s.points);
  }
}

/**
 * Per-map shape collider. Aggregates per-tile shapes (resolved per painted
 * tile position) and map-level object-layer shapes. Queried by map-local
 * pixel coordinates, scaled to the rendered world. Used for both world
 * chunks and interior tilemaps.
 */
export class ShapeCollider {
  private readonly tileLayers: Phaser.Tilemaps.TilemapLayer[];
  private readonly tileShapes: TileShapeMap;
  private readonly mapShapes: CollisionShape[];
  private readonly authoredTileSize: number;
  private readonly renderScale: number;

  constructor(params: {
    tilemap: Phaser.Tilemaps.Tilemap;
    tileLayers: Phaser.Tilemaps.TilemapLayer[];
    /** Cached TMJ JSON for the map (or undefined). Typed loosely — we only
     *  read `layers[]` here and guard every field. */
    rawTmj: unknown;
    renderScale: number;
  }) {
    this.tileLayers = params.tileLayers;
    this.tileShapes = buildTileShapeMap(params.tilemap);
    this.mapShapes = parseObjectLayerShapes(params.rawTmj as RawTmjData | undefined);
    this.authoredTileSize = params.tilemap.tileWidth;
    this.renderScale = params.renderScale;
  }

  /** True if any shape (per-tile or map-level) covers this map-local px. */
  isBlockedAtLocalPx(lx: number, ly: number): boolean {
    // Authored-space coordinates for shape tests.
    const ax = lx / this.renderScale;
    const ay = ly / this.renderScale;

    // Map-level shapes (authored as objects on the `collision` layer).
    for (const s of this.mapShapes) {
      if (pointInShape(ax, ay, s)) return true;
    }

    // Per-tile shapes: look up the tile at this position on each tile layer.
    if (this.tileShapes.size > 0) {
      const ts = this.authoredTileSize;
      const tx = Math.floor(ax / ts);
      const ty = Math.floor(ay / ts);
      const localX = ax - tx * ts;
      const localY = ay - ty * ts;
      for (const layer of this.tileLayers) {
        const tile = layer.getTileAt(tx, ty);
        if (!tile) continue;
        const shapes = this.tileShapes.get(tile.index);
        if (!shapes) continue;
        for (const s of shapes) {
          if (pointInShape(localX, localY, s)) return true;
        }
      }
    }

    return false;
  }

  /** Read-only access for debug overlays. Coords are authored-tile-local. */
  debugTileShapes(): TileShapeMap {
    return this.tileShapes;
  }

  /** Read-only access for debug overlays. Coords are map-local authored px. */
  debugMapShapes(): readonly CollisionShape[] {
    return this.mapShapes;
  }

  get authoredTileSizePx(): number {
    return this.authoredTileSize;
  }

  get renderScaleFactor(): number {
    return this.renderScale;
  }
}
