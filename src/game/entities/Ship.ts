import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { type VesselTemplate } from "./vessels";
import { createShipVisual, type HelmRect, type HitboxRect, type ShipVisualLayers } from "./shipTilemap";

export type Heading = 0 | 1 | 2 | 3; // 0=N, 1=E, 2=S, 3=W

export type ShipMode = "docked" | "sailing" | "anchoring";

export interface DockedPose {
  tx: number;
  ty: number;
  heading: Heading;
}

/** Tile dimensions used by footprint / bbox math. tilesLong is the bow-to-stern axis. */
export interface VesselDims {
  tilesLong: number;
  tilesWide: number;
}

const SHIP_MAX_SPEED = 120; // px/s cap on velocity magnitude
const SHIP_ACCEL = 60; // px/s^2 — thrust and drag rate

export type ShipTileState = "water" | "beach" | "blocked";

export interface SailingStepResult {
  beached: boolean;
  blocked: boolean;
}

export class Ship {
  /** Stable instance id (matches ships.json instance id). */
  public readonly id: string;
  public mode: ShipMode = "docked";
  public docked: DockedPose;
  public readonly vessel: VesselTemplate;
  public readonly dims: VesselDims;

  /** Continuous position. `heading` is the cardinal visual facing (N/E/S/W),
   *  independent of velocity — the scene chooses it from thrust input with a
   *  sticky-axis preference, and reverse thrust leaves it alone. Velocity is a
   *  2D vector with momentum; thrust accelerates it and drag slows it. */
  public x: number;
  public y: number;
  public heading: Heading;
  public vx = 0;
  public vy = 0;

  /** Lightweight anchor for camera follow and global visibility. Tilemap layers
   *  cannot be Container children, so they live at scene level and are
   *  repositioned to track this container each time pose changes. */
  public readonly container: Phaser.GameObjects.Container;
  /** One visual per heading (moving + idle layers). Only the active heading's
   *  pair is visible at a time; within that pair, `mode === "sailing"` chooses
   *  moving, otherwise idle. */
  private readonly visuals: ShipVisualLayers[];

  constructor(scene: Phaser.Scene, id: string, vessel: VesselTemplate, docked: DockedPose) {
    this.id = id;
    this.vessel = vessel;
    this.dims = { tilesLong: vessel.tilesLong, tilesWide: vessel.tilesWide };
    this.docked = { ...docked };
    this.heading = docked.heading;
    const c = Ship.bboxCenterPx(docked, this.dims);
    this.x = c.x;
    this.y = c.y;

    this.container = scene.add.container(this.x, this.y);
    this.container.setDepth(this.sortY());

    this.visuals = [0, 1, 2, 3].map((h) => createShipVisual(scene, vessel, h as Heading));
    this.updateVisual();
  }

  /** Derived angle — some callers (player sprite, debug) still want a radian value. */
  get rotation(): number {
    return headingToRotation(this.heading);
  }

  /** Y-value used for depth sorting — bottom of the footprint in world pixels.
   *  Chosen over the visual sprite bottom because vessel art frames include tall
   *  masts/sails extending well above the hull; sorting by the footprint keeps
   *  the player drawing correctly relative to the hull (the walkable reference). */
  sortY(): number {
    const eastWest = this.heading === 1 || this.heading === 3;
    const hTiles = eastWest ? this.dims.tilesWide : this.dims.tilesLong;
    return this.y + (hTiles / 2) * TILE_SIZE;
  }

  private applyLayerTransforms(): void {
    const depth = this.sortY();
    for (let h = 0; h < 4; h++) {
      const v = this.visuals[h];
      const topLeftX = this.x - v.widthPx / 2;
      const topLeftY = this.y - v.heightPx / 2;
      v.moving.setPosition(topLeftX, topLeftY);
      v.idle.setPosition(topLeftX, topLeftY);
      v.moving.setDepth(depth);
      v.idle.setDepth(depth);
    }
  }

  private updateVisual() {
    const sailing = this.mode === "sailing";
    for (let h = 0; h < 4; h++) {
      const active = h === this.heading;
      const v = this.visuals[h];
      v.moving.setVisible(active && sailing);
      v.idle.setVisible(active && !sailing);
    }
    this.applyLayerTransforms();
  }

  /** Toggle ship visibility (used when changing scenes / entering interiors). */
  setVisible(visible: boolean): void {
    this.container.setVisible(visible);
    if (!visible) {
      for (const v of this.visuals) {
        v.moving.setVisible(false);
        v.idle.setVisible(false);
      }
    } else {
      this.updateVisual();
    }
  }

  /** Rotate heading by +1 (starboard / right) or -1 (port / left). */
  turn(dir: -1 | 1): void {
    if (this.mode !== "sailing") return;
    this.heading = ((((this.heading + dir) % 4) + 4) % 4) as Heading;
    this.updateVisual();
  }

  /** Pick a cardinal heading from a thrust input (dx, dy), preferring to keep
   *  the axis of the current heading. Diagonal inputs do not flip to the other
   *  axis unless the current axis component is zero — so a ship already moving
   *  east that gets W+S stays horizontal (snaps to W), and one moving south
   *  that gets S+E stays vertical. */
  setHeadingFromInput(dx: number, dy: number): void {
    if (this.mode !== "sailing") return;
    if (dx === 0 && dy === 0) return;
    const headingIsHorizontal = this.heading === 1 || this.heading === 3;
    let next: Heading = this.heading;
    if (headingIsHorizontal) {
      if (dx !== 0) next = dx > 0 ? 1 : 3;
      else next = dy > 0 ? 2 : 0;
    } else {
      if (dy !== 0) next = dy > 0 ? 2 : 0;
      else next = dx > 0 ? 1 : 3;
    }
    if (next !== this.heading) {
      this.heading = next;
      this.updateVisual();
    }
  }

  /** Current velocity magnitude (px/s). */
  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  /** Footprint tiles occupied by the ship in a given docked pose. */
  static footprint(pose: DockedPose, dims: VesselDims): Array<{ x: number; y: number }> {
    const { tx, ty, heading } = pose;
    const eastWest = heading === 1 || heading === 3;
    const w = eastWest ? dims.tilesLong : dims.tilesWide;
    const h = eastWest ? dims.tilesWide : dims.tilesLong;
    const tiles: Array<{ x: number; y: number }> = [];
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) tiles.push({ x: tx + dx, y: ty + dy });
    }
    return tiles;
  }

  /** Pixel center of the bbox for a given docked pose. */
  static bboxCenterPx(pose: DockedPose, dims: VesselDims): { x: number; y: number } {
    const { tx, ty, heading } = pose;
    const eastWest = heading === 1 || heading === 3;
    const w = eastWest ? dims.tilesLong : dims.tilesWide;
    const h = eastWest ? dims.tilesWide : dims.tilesLong;
    return { x: (tx + w / 2) * TILE_SIZE, y: (ty + h / 2) * TILE_SIZE };
  }

  /** Tile containing the helm interaction point for a given docked pose. */
  helmTileForPose(pose: DockedPose): { x: number; y: number } {
    const center = Ship.bboxCenterPx(pose, this.dims);
    const h = this.visuals[pose.heading].helm;
    const wx = center.x + h.offX + h.w / 2;
    const wy = center.y + h.offY + h.h / 2;
    return { x: Math.floor(wx / TILE_SIZE), y: Math.floor(wy / TILE_SIZE) };
  }

  /** World-pixel position of the helm (center of the helm object), for parking
   *  the player while sailing/anchoring. Per-heading, authored in each tmj's
   *  `helm` object layer. */
  helmWorldPx(): { x: number; y: number } {
    const h = this.visuals[this.heading].helm;
    return { x: this.x + h.offX + h.w / 2, y: this.y + h.offY + h.h / 2 };
  }

  /** Current helm rect (ship-center-relative world px) for the active heading. */
  helm(): HelmRect {
    return this.visuals[this.heading].helm;
  }

  /** Whether a player-center pixel is on a deck tile of this ship (docked only). */
  isOnDeck(px: number, py: number): boolean {
    if (this.mode !== "docked") return false;
    const tx = Math.floor(px / TILE_SIZE);
    const ty = Math.floor(py / TILE_SIZE);
    return Ship.footprint(this.docked, this.dims).some((t) => t.x === tx && t.y === ty);
  }

  startSailing(): void {
    this.mode = "sailing";
    this.vx = 0;
    this.vy = 0;
    this.updateVisual();
  }

  /** Tiles overlapped by the hitbox rect at a continuous ship center (x, y). */
  static hitboxTilesAt(
    x: number,
    y: number,
    hb: HitboxRect,
  ): Array<{ x: number; y: number }> {
    const eps = 0.001;
    const tx0 = Math.floor((x + hb.offX) / TILE_SIZE);
    const ty0 = Math.floor((y + hb.offY) / TILE_SIZE);
    const tx1 = Math.floor((x + hb.offX + hb.w - eps) / TILE_SIZE);
    const ty1 = Math.floor((y + hb.offY + hb.h - eps) / TILE_SIZE);
    const tiles: Array<{ x: number; y: number }> = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) tiles.push({ x: tx, y: ty });
    }
    return tiles;
  }

  /** Current hitbox rect (ship-center-relative world px) for the active heading. */
  hitbox(): HitboxRect {
    return this.visuals[this.heading].hitbox;
  }

  /** Advance physics while sailing. `thrust` is a (possibly non-unit) vector;
   *  null means no input (the ship drifts and drag slows it). Collision is
   *  axis-separated so that grazing a beach on one axis doesn't kill motion on
   *  the other — you can slide along a shore. A beach tile only blocks the
   *  axis if traversing it would raise the ship's beach-tile count (i.e. you
   *  are being pushed *further* into the beach); parallel or outward motion
   *  along the same beach is allowed. */
  updateSailing(
    dtSec: number,
    thrust: { x: number; y: number } | null,
    classify: (tx: number, ty: number) => ShipTileState,
  ): SailingStepResult {
    const dv = SHIP_ACCEL * dtSec;
    if (thrust) {
      this.vx += thrust.x * dv;
      this.vy += thrust.y * dv;
    } else {
      const sp = Math.hypot(this.vx, this.vy);
      if (sp > 0) {
        const decel = Math.min(sp, dv);
        const k = (sp - decel) / sp;
        this.vx *= k;
        this.vy *= k;
      }
    }
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > SHIP_MAX_SPEED) {
      const k = SHIP_MAX_SPEED / sp;
      this.vx *= k;
      this.vy *= k;
    }

    const hb = this.hitbox();
    const curBeach = Ship.beachCount(this.x, this.y, hb, classify);

    // X axis first.
    let nx = this.x + this.vx * dtSec;
    const xRes = Ship.classifyAt(nx, this.y, hb, classify);
    if (xRes.worst === "blocked" || (xRes.worst === "beach" && xRes.beachCount > curBeach)) {
      this.vx = 0;
      nx = this.x;
    }
    // Y axis from the (possibly updated) x.
    const beachAfterX = Ship.beachCount(nx, this.y, hb, classify);
    let ny = this.y + this.vy * dtSec;
    const yRes = Ship.classifyAt(nx, ny, hb, classify);
    if (yRes.worst === "blocked" || (yRes.worst === "beach" && yRes.beachCount > beachAfterX)) {
      this.vy = 0;
      ny = this.y;
    }

    this.x = nx;
    this.y = ny;
    this.syncTransform();

    const finalRes = Ship.classifyAt(this.x, this.y, hb, classify);
    return {
      beached: finalRes.worst === "beach",
      blocked: finalRes.worst === "blocked",
    };
  }

  private static classifyAt(
    x: number,
    y: number,
    hb: HitboxRect,
    classify: (tx: number, ty: number) => ShipTileState,
  ): { worst: ShipTileState; beachCount: number } {
    const tiles = Ship.hitboxTilesAt(x, y, hb);
    let worst: ShipTileState = "water";
    let beachCount = 0;
    for (const t of tiles) {
      const s = classify(t.x, t.y);
      if (s === "blocked") { worst = "blocked"; }
      else if (s === "beach") { beachCount++; if (worst !== "blocked") worst = "beach"; }
    }
    return { worst, beachCount };
  }

  private static beachCount(
    x: number,
    y: number,
    hb: HitboxRect,
    classify: (tx: number, ty: number) => ShipTileState,
  ): number {
    let n = 0;
    for (const t of Ship.hitboxTilesAt(x, y, hb)) {
      if (classify(t.x, t.y) === "beach") n++;
    }
    return n;
  }

  private syncTransform(): void {
    this.container.setPosition(this.x, this.y);
    this.container.setDepth(this.sortY());
    this.applyLayerTransforms();
  }

  /** Set position (and optionally heading) — used by anchoring drift tween. */
  setPose(x: number, y: number, heading?: Heading): void {
    this.x = x;
    this.y = y;
    if (heading !== undefined && heading !== this.heading) {
      this.heading = heading;
      this.updateVisual();
    } else {
      this.syncTransform();
    }
  }

  finalizeDock(pose: DockedPose): void {
    this.docked = { ...pose };
    const c = Ship.bboxCenterPx(pose, this.dims);
    this.mode = "docked";
    this.vx = 0;
    this.vy = 0;
    this.setPose(c.x, c.y, pose.heading);
    // setPose only updateVisuals if heading changed; force in case it didn't.
    this.updateVisual();
  }

  serialize(): ShipSavedState {
    return {
      id: this.id,
      defId: this.vessel.id,
      x: this.x,
      y: this.y,
      heading: this.heading,
      mode: this.mode,
      vx: this.vx,
      vy: this.vy,
      docked: { ...this.docked },
    };
  }

  hydrate(data: ShipSavedState): void {
    this.docked = { ...data.docked };
    this.mode = data.mode;
    this.vx = data.vx;
    this.vy = data.vy;
    this.heading = data.heading;
    this.x = data.x;
    this.y = data.y;
    this.updateVisual();
    this.container.setPosition(this.x, this.y);
    this.container.setDepth(this.sortY());
  }

  destroy(): void {
    for (const v of this.visuals) {
      v.moving.destroy();
      v.idle.destroy();
      v.tilemap.destroy();
    }
    this.container.destroy();
  }
}

export interface ShipSavedState {
  id: string;
  defId: string;
  x: number;
  y: number;
  heading: Heading;
  mode: ShipMode;
  vx: number;
  vy: number;
  docked: DockedPose;
}

export function headingToRotation(h: Heading): number {
  return (h - 1) * (Math.PI / 2);
}

/** Normalize an angle to (-PI, PI]. Kept for debug cost heuristics. */
export function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}
