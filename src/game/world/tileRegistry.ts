import * as Phaser from "phaser";

/** Unit vector along a ramp surface. Sign of the vector doesn't matter — the
 *  projection used to deflect motion is symmetric. */
export interface Slope {
  ux: number;
  uy: number;
}

const INV_SQRT2 = 1 / Math.SQRT2;
export const SLOPE_FORWARD_SLASH: Slope = { ux: INV_SQRT2, uy: -INV_SQRT2 };
export const SLOPE_BACK_SLASH: Slope = { ux: INV_SQRT2, uy: INV_SQRT2 };

/**
 * Deflect a movement vector onto a slope. Decomposes (dx, dy) into a
 * component parallel to the slope (kept) and perpendicular to the slope
 * (attenuated by `bleed`). Output magnitude is always ≤ input magnitude, so
 * the player can never move faster on a slope than on flat ground.
 *
 * `bleed` controls how much off-axis input survives: 0 = strict projection
 * (player can only slide along the ramp, no sideways exit), 1 = no deflection
 * at all (passthrough). The default ~0.25 lets you walk along the ramp at full
 * speed while still being able to step off sideways onto adjacent tiles.
 */
export function applySlopeDeflection(
  dx: number,
  dy: number,
  slope: Slope,
  bleed = 0.25,
): { dx: number; dy: number } {
  const dot = dx * slope.ux + dy * slope.uy;
  const parX = dot * slope.ux;
  const parY = dot * slope.uy;
  const perpX = dx - parX;
  const perpY = dy - parY;
  return {
    dx: parX + perpX * bleed,
    dy: parY + perpY * bleed,
  };
}

/**
 * Per-tile property lookup derived from Tiled tileset custom properties.
 * Callers query by tile coordinate (indices into the tilemap, not pixels).
 *
 * The registry reads a union of properties across every tile layer at a
 * coordinate — so a water tile on `ground` plus a decoration tile on `overlay`
 * still reports `water: true`, and a walkable floor tile plus a wall tile on
 * `props_low` reports `collides: true`. This is the "any layer wins" rule.
 */
export class TileRegistry {
  private readonly tilemap: Phaser.Tilemaps.Tilemap;
  private readonly tileLayerNames: string[];

  /**
   * Tile custom properties, keyed by GID (global tile id = firstgid + local id).
   * Parsed once at construction for O(1) lookup.
   */
  private readonly propsByGid = new Map<number, Record<string, unknown>>();

  constructor(tilemap: Phaser.Tilemaps.Tilemap) {
    this.tilemap = tilemap;
    this.tileLayerNames = tilemap.layers.map((l) => l.name);

    for (const ts of tilemap.tilesets) {
      const base = ts.firstgid;
      const raw = ts.tileProperties as unknown as Record<string, Record<string, unknown>>;
      if (!raw) continue;
      for (const key of Object.keys(raw)) {
        const localId = parseInt(key, 10);
        if (Number.isNaN(localId)) continue;
        this.propsByGid.set(base + localId, raw[key]);
      }
    }
  }

  isWater(tileX: number, tileY: number): boolean {
    // "Deep water" — blocks on-foot movement. The `ocean` layer is the base of
    // every authored chunk. A cell is deep water iff ocean is present AND
    // nothing *other than shallow water* is painted above it. Shallow water
    // buried under ocean must not make the cell walkable — ocean wins.
    // Wadeable shallow water is a cell with shallow water painted and no
    // ocean covering it. Outside authored chunks, callers (ChunkManager)
    // default to open ocean anyway.
    if (this.tilemap.getTileAt(tileX, tileY, false, "ocean")) {
      for (const layerName of this.tileLayerNames) {
        if (layerName === "ocean" || layerName === "shallow water") continue;
        if (this.tilemap.getTileAt(tileX, tileY, false, layerName)) return false;
      }
      return true;
    }
    // No ocean tile here — fall back to per-tile `water: true` property for
    // explicit water tiles painted above non-ocean terrain (e.g. inland pools).
    return this.anyLayerHasProp(tileX, tileY, "water");
  }

  /**
   * Can a ship sit here? True if `ocean` or `shallow water` is painted AND
   * nothing else (land, dock, props) is stacked above. Shallow water is both
   * anchorable AND walkable — the player can wade around the hull.
   */
  isAnchorable(tileX: number, tileY: number): boolean {
    const hasOcean = !!this.tilemap.getTileAt(tileX, tileY, false, "ocean");
    const hasShallow = !!this.tilemap.getTileAt(tileX, tileY, false, "shallow water");
    if (!hasOcean && !hasShallow) return false;
    for (const layerName of this.tileLayerNames) {
      if (layerName === "ocean" || layerName === "shallow water") continue;
      if (this.tilemap.getTileAt(tileX, tileY, false, layerName)) return false;
    }
    return true;
  }

  isBlocked(tileX: number, tileY: number): boolean {
    return this.anyLayerHasProp(tileX, tileY, "collides");
  }

  /**
   * Slope orientation for a tile, or null if it isn't a slope. Returned as a
   * unit vector along the ramp surface — direction sign is irrelevant (the
   * projection in `applySlopeDeflection` is symmetric).
   *
   * Tiles are flagged in Tiled with a `slope` string property:
   * `"ne" | "sw"` → `/` diagonal, `"nw" | "se"` → `\` diagonal. The four
   * compass names map to two physical orientations; map authors pick whichever
   * matches the art.
   */
  slopeAt(tileX: number, tileY: number): Slope | null {
    const dir = this.firstLayerProp(tileX, tileY, "slope");
    if (typeof dir !== "string") return null;
    switch (dir) {
      case "ne":
      case "sw":
        return SLOPE_FORWARD_SLASH;
      case "nw":
      case "se":
        return SLOPE_BACK_SLASH;
      default:
        return null;
    }
  }

  /**
   * Classify a tile for fishing purposes. Returns `"ocean"` for deep water,
   * `"shallow"` for wadeable shallow water / inland pools, or `null` if the
   * tile isn't a fishable water surface. Extensible: a tile property
   * `fishingSurface: "river" | "void" | "lava" | ...` on the topmost layer
   * wins over the ocean/shallow classification for special tiles.
   */
  fishingSurface(tileX: number, tileY: number): string | null {
    const explicit = this.firstLayerProp(tileX, tileY, "fishingSurface");
    if (typeof explicit === "string" && explicit.length > 0) return explicit;
    if (this.tilemap.getTileAt(tileX, tileY, false, "ocean")) {
      for (const layerName of this.tileLayerNames) {
        if (layerName === "ocean" || layerName === "shallow water") continue;
        if (this.tilemap.getTileAt(tileX, tileY, false, layerName)) return null;
      }
      return "ocean";
    }
    if (this.tilemap.getTileAt(tileX, tileY, false, "shallow water")) {
      for (const layerName of this.tileLayerNames) {
        if (layerName === "shallow water") continue;
        if (this.tilemap.getTileAt(tileX, tileY, false, layerName)) return null;
      }
      return "shallow";
    }
    if (this.anyLayerHasProp(tileX, tileY, "water")) return "shallow";
    return null;
  }

  private firstLayerProp(tileX: number, tileY: number, prop: string): unknown {
    for (const layerName of this.tileLayerNames) {
      const tile = this.tilemap.getTileAt(tileX, tileY, false, layerName);
      if (!tile) continue;
      const props = this.propsByGid.get(tile.index);
      if (props && prop in props) return props[prop];
    }
    return undefined;
  }

  /**
   * Sailing collision classifier:
   * - "water"   → ocean/shallow water with nothing else painted (anchorable).
   * - "beach"   → ocean/shallow water/nothing, plus a `beach` tile, and no
   *               other land/prop layers. Soft-grounding: hull stops but can
   *               reverse off.
   * - "blocked" → anything else (grass, walls, docks, props, collides...).
   *               Hard stop.
   */
  shipTileState(tileX: number, tileY: number): "water" | "beach" | "blocked" {
    const hasOcean = !!this.tilemap.getTileAt(tileX, tileY, false, "ocean");
    const hasShallow = !!this.tilemap.getTileAt(tileX, tileY, false, "shallow water");
    const hasBeach = !!this.tilemap.getTileAt(tileX, tileY, false, "beach");
    for (const layerName of this.tileLayerNames) {
      // `beach_walk` is a runtime-painted footprint layer over beach tiles —
      // it must not flip a beach tile to "blocked" when a footprint is present.
      if (
        layerName === "ocean" ||
        layerName === "shallow water" ||
        layerName === "beach" ||
        layerName === "beach_walk"
      ) continue;
      if (this.tilemap.getTileAt(tileX, tileY, false, layerName)) return "blocked";
    }
    if (hasBeach) return "beach";
    if (hasOcean || hasShallow) return "water";
    return "blocked";
  }

  /** Does any tile stacked at (tx, ty) carry a given boolean property? */
  private anyLayerHasProp(tileX: number, tileY: number, prop: string): boolean {
    for (const layerName of this.tileLayerNames) {
      const tile = this.tilemap.getTileAt(tileX, tileY, false, layerName);
      if (!tile) continue;
      const props = this.propsByGid.get(tile.index);
      if (props && props[prop]) return true;
    }
    return false;
  }

  /** Land-walkable = inside the map, not water, not collides. */
  isLandWalkable(tileX: number, tileY: number): boolean {
    if (tileX < 0 || tileY < 0 || tileX >= this.tilemap.width || tileY >= this.tilemap.height) {
      return false;
    }
    return !this.isWater(tileX, tileY) && !this.isBlocked(tileX, tileY);
  }
}
