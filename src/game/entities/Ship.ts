import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { type VesselTemplate } from "./vessels";
import { createShipVisual, type ShipVisualLayers } from "./shipTilemap";

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

const SHIP_MAX_SPEED = 120; // px/s at full throttle
const SHIP_REVERSE_MAX = 30; // px/s when backing off a beach (negative throttle)
const SHIP_ACCEL = 60; // px/s^2

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

  /** Continuous position; heading is the single source of truth for orientation. */
  public x: number;
  public y: number;
  public heading: Heading;

  public speed = 0;
  public targetThrottle = 0; // 0..1

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

  /** Visual offset (in container-local px) for the current heading. Rotates the
   *  def's (long, wide) tile offset into X/Y — long = bow axis, wide = starboard. */
  private visualOffsetPx(): { x: number; y: number } {
    const off = this.vessel.visualOffset ?? { long: 0, wide: 0 };
    const longPx = off.long * TILE_SIZE;
    const widePx = off.wide * TILE_SIZE;
    switch (this.heading) {
      case 0: return { x: widePx, y: -longPx };
      case 1: return { x: longPx, y: widePx };
      case 2: return { x: -widePx, y: longPx };
      case 3: return { x: -longPx, y: -widePx };
    }
  }

  private applyLayerTransforms(): void {
    const { x: ox, y: oy } = this.visualOffsetPx();
    const depth = this.sortY();
    for (let h = 0; h < 4; h++) {
      const v = this.visuals[h];
      const topLeftX = this.x - v.widthPx / 2 + ox;
      const topLeftY = this.y - v.heightPx / 2 + oy;
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

  /**
   * Tile occupied by the helm (where the player stands to steer) in a docked pose.
   * The helm is the stern tile (opposite the bow implied by `heading`), centered
   * across the beam. Generalized over any tilesLong×tilesWide footprint.
   */
  static helmTile(pose: DockedPose, dims: VesselDims): { x: number; y: number } {
    const { tx, ty, heading } = pose;
    const L = dims.tilesLong;
    const W = dims.tilesWide;
    const centerW = Math.floor((W - 1) / 2);
    switch (heading) {
      case 0: return { x: tx + centerW, y: ty + L - 1 };
      case 1: return { x: tx, y: ty + centerW };
      case 2: return { x: tx + centerW, y: ty };
      case 3: return { x: tx + L - 1, y: ty + centerW };
    }
  }

  /**
   * World-pixel position of the helm, for parking the player while sailing/anchoring.
   * Falls back to the footprint-centered helm tile; per-heading fine-tuning will
   * move into the .tmx object layer in a follow-up.
   */
  helmWorldPx(): { x: number; y: number } {
    // Park the player half the length behind center along the bow axis.
    const half = (this.dims.tilesLong / 2 - 0.5) * TILE_SIZE;
    switch (this.heading) {
      case 0: return { x: this.x, y: this.y + half };
      case 1: return { x: this.x - half, y: this.y };
      case 2: return { x: this.x, y: this.y - half };
      case 3: return { x: this.x + half, y: this.y };
    }
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
    this.speed = 0;
    this.targetThrottle = 0;
    this.updateVisual();
  }

  /** Tiles overlapped by the hull's bbox at a continuous (x, y, heading). */
  static occupiedTilesAt(
    x: number,
    y: number,
    heading: Heading,
    dims: VesselDims,
  ): Array<{ x: number; y: number }> {
    const eastWest = heading === 1 || heading === 3;
    const w = eastWest ? dims.tilesLong : dims.tilesWide;
    const h = eastWest ? dims.tilesWide : dims.tilesLong;
    const halfW = (w * TILE_SIZE) / 2;
    const halfH = (h * TILE_SIZE) / 2;
    const eps = 0.001;
    const tx0 = Math.floor((x - halfW) / TILE_SIZE);
    const ty0 = Math.floor((y - halfH) / TILE_SIZE);
    const tx1 = Math.floor((x + halfW - eps) / TILE_SIZE);
    const ty1 = Math.floor((y + halfH - eps) / TILE_SIZE);
    const tiles: Array<{ x: number; y: number }> = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) tiles.push({ x: tx, y: ty });
    }
    return tiles;
  }

  /** Advance physics while sailing. Heading changes are discrete (see `turn()`). */
  updateSailing(
    dtSec: number,
    classify: (tx: number, ty: number) => ShipTileState,
  ): SailingStepResult {
    const targetSpeed = this.targetThrottle * (this.targetThrottle < 0 ? SHIP_REVERSE_MAX : SHIP_MAX_SPEED);
    let nextSpeed = this.speed;
    if (nextSpeed < targetSpeed) nextSpeed = Math.min(targetSpeed, nextSpeed + SHIP_ACCEL * dtSec);
    else nextSpeed = Math.max(targetSpeed, nextSpeed - SHIP_ACCEL * dtSec);

    const a = headingToRotation(this.heading);
    const nx = this.x + Math.cos(a) * nextSpeed * dtSec;
    const ny = this.y + Math.sin(a) * nextSpeed * dtSec;

    const tiles = Ship.occupiedTilesAt(nx, ny, this.heading, this.dims);
    let worst: ShipTileState = "water";
    for (const t of tiles) {
      const s = classify(t.x, t.y);
      if (s === "blocked") { worst = "blocked"; break; }
      if (s === "beach") worst = "beach";
    }

    if (worst === "blocked") {
      this.speed = 0;
      this.targetThrottle = 0;
      this.syncTransform();
      return { beached: false, blocked: true };
    }

    if (worst === "beach") {
      // Soft grounding: forward thrust dies, reverse off only.
      if (this.targetThrottle > 0) this.targetThrottle = 0;
      if (nextSpeed > 0) nextSpeed = 0;
      this.speed = nextSpeed;
      this.x += Math.cos(a) * this.speed * dtSec;
      this.y += Math.sin(a) * this.speed * dtSec;
      this.syncTransform();
      return { beached: true, blocked: false };
    }

    this.speed = nextSpeed;
    this.x = nx;
    this.y = ny;
    this.syncTransform();
    return { beached: false, blocked: false };
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
    this.speed = 0;
    this.targetThrottle = 0;
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
      speed: this.speed,
      targetThrottle: this.targetThrottle,
      docked: { ...this.docked },
    };
  }

  hydrate(data: ShipSavedState): void {
    this.docked = { ...data.docked };
    this.mode = data.mode;
    this.speed = data.speed;
    this.targetThrottle = data.targetThrottle;
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
  speed: number;
  targetThrottle: number;
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
