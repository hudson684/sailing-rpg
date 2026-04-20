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

  /** Continuous position. `heading` is the cardinal visual facing (one of N/E/S/W),
   *  snapped from `moveAngle` each tick. `moveAngle` is the continuous direction
   *  of travel in radians (0 = east, π/2 = south), allowing 8-directional (and
   *  smoother) movement without needing diagonal ship art. */
  public x: number;
  public y: number;
  public heading: Heading;
  public moveAngle: number;

  public speed = 0;
  public targetThrottle = 0; // -1..1; sign indicates reverse

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
    this.moveAngle = headingToRotation(this.heading);
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
    this.moveAngle = headingToRotation(this.heading);
    this.updateVisual();
  }

  /** Set the continuous direction of travel (radians). Snaps `heading` to the
   *  nearest cardinal so the visual/hitbox uses existing 4-way art even when
   *  moving diagonally. */
  setMoveAngle(angle: number): void {
    if (this.mode !== "sailing") return;
    this.moveAngle = angle;
    // headingToRotation(h) = (h - 1) * π/2, so h = round(angle/(π/2)) + 1.
    const cardinal = ((Math.round(angle / (Math.PI / 2)) + 1) % 4 + 4) % 4 as Heading;
    if (cardinal !== this.heading) {
      this.heading = cardinal;
      this.updateVisual();
    }
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
    this.speed = 0;
    this.targetThrottle = 0;
    this.moveAngle = headingToRotation(this.heading);
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

  /** Advance physics while sailing. Velocity direction comes from `moveAngle`
   *  (set via `setMoveAngle()` or `turn()`). When `active` is false (no
   *  direction input held) the ship decelerates to a stop — same accel rate
   *  as when throttling, so release-to-stop feels like walking. */
  updateSailing(
    dtSec: number,
    active: boolean,
    classify: (tx: number, ty: number) => ShipTileState,
  ): SailingStepResult {
    const throttleSpeed = this.targetThrottle * (this.targetThrottle < 0 ? SHIP_REVERSE_MAX : SHIP_MAX_SPEED);
    const targetSpeed = active ? throttleSpeed : 0;
    let nextSpeed = this.speed;
    if (nextSpeed < targetSpeed) nextSpeed = Math.min(targetSpeed, nextSpeed + SHIP_ACCEL * dtSec);
    else nextSpeed = Math.max(targetSpeed, nextSpeed - SHIP_ACCEL * dtSec);

    const a = this.moveAngle;
    const nx = this.x + Math.cos(a) * nextSpeed * dtSec;
    const ny = this.y + Math.sin(a) * nextSpeed * dtSec;

    const tiles = Ship.hitboxTilesAt(nx, ny, this.hitbox());
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
    this.moveAngle = headingToRotation(pose.heading);
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
    this.moveAngle = headingToRotation(data.heading);
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
