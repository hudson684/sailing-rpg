import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import {
  VESSEL_TEMPLATES,
  headingToVesselDir,
  vesselAnimKey,
  vesselTextureKey,
  type VesselTemplate,
} from "./vessels";

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

const ROWBOAT_DIMS: VesselDims = {
  tilesLong: VESSEL_TEMPLATES.rowboat.tilesLong,
  tilesWide: VESSEL_TEMPLATES.rowboat.tilesWide,
};

const SHIP_MAX_SPEED = 120; // px/s at full throttle
const SHIP_ACCEL = 60; // px/s^2

const HULL_COLOR = 0x5e3a1a;
const HULL_STROKE = 0x2a1a08;
const DECK_COLOR = 0xb88449;
const MAST_COLOR = 0x2a1a08;
const HELM_COLOR = 0xd9b07a;

export class Ship {
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

  public readonly container: Phaser.GameObjects.Container;
  private readonly hull: Phaser.GameObjects.Rectangle;
  private readonly deckTiles: Phaser.GameObjects.Rectangle[] = [];
  private readonly mast: Phaser.GameObjects.Arc;
  private readonly helmMarker: Phaser.GameObjects.Rectangle;
  private readonly bowMarker: Phaser.GameObjects.Triangle;
  private readonly visual: Phaser.GameObjects.Sprite;

  constructor(scene: Phaser.Scene, docked: DockedPose, vessel: VesselTemplate = VESSEL_TEMPLATES.rowboat) {
    this.vessel = vessel;
    this.dims = { tilesLong: vessel.tilesLong, tilesWide: vessel.tilesWide };
    this.docked = { ...docked };
    this.heading = docked.heading;
    const c = Ship.bboxCenterPx(docked, this.dims);
    this.x = c.x;
    this.y = c.y;

    // Cardinal-only sailing: the container never rotates — headings are discrete
    // and every art sheet is pre-drawn per direction.
    this.container = scene.add.container(this.x, this.y);
    this.container.setDepth(30);

    const longPx = TILE_SIZE * this.dims.tilesLong;
    const widePx = TILE_SIZE * this.dims.tilesWide;

    this.hull = scene.add
      .rectangle(0, 0, longPx + 4, widePx + 4, HULL_COLOR)
      .setStrokeStyle(2, HULL_STROKE);

    const xOff = -(this.dims.tilesLong - 1) / 2;
    const yOff = -(this.dims.tilesWide - 1) / 2;
    for (let dx = 0; dx < this.dims.tilesLong; dx++) {
      for (let dy = 0; dy < this.dims.tilesWide; dy++) {
        const t = scene.add
          .rectangle((xOff + dx) * TILE_SIZE, (yOff + dy) * TILE_SIZE, TILE_SIZE - 2, TILE_SIZE - 2, DECK_COLOR)
          .setStrokeStyle(1, HULL_STROKE);
        this.deckTiles.push(t);
      }
    }

    this.mast = scene.add.circle(0, 0, 5, MAST_COLOR);
    this.helmMarker = scene.add
      .rectangle(0, -TILE_SIZE / 2, 10, 10, HELM_COLOR)
      .setStrokeStyle(1, HULL_STROKE);
    this.bowMarker = scene.add.triangle(
      longPx / 2 + 6,
      0,
      0,
      -8,
      12,
      0,
      0,
      8,
      0xffeeaa,
    );

    this.container.add([
      this.hull,
      ...this.deckTiles,
      this.mast,
      this.helmMarker,
      this.bowMarker,
    ]);
    this.hull.setVisible(false);
    this.deckTiles.forEach((t) => t.setVisible(false));
    this.mast.setVisible(false);
    this.helmMarker.setVisible(false);
    this.bowMarker.setVisible(false);

    this.visual = scene.add.sprite(0, 0, vesselTextureKey(vessel, "idle", "down"), 0);
    this.visual.setScale(vessel.scale);
    this.container.add(this.visual);
    this.updateVisual();
  }

  /** Derived angle — some callers (player sprite, debug) still want a radian value. */
  get rotation(): number {
    return headingToRotation(this.heading);
  }

  private updateVisual() {
    const state = this.mode === "sailing" ? "sailing" : "idle";
    const { dir, flipX } = headingToVesselDir(this.heading);
    const key = vesselAnimKey(this.vessel, state, dir);
    if (this.visual.anims.currentAnim?.key !== key) {
      this.visual.anims.play(key, true);
    }
    this.visual.setFlipX(flipX);
  }

  /** Rotate heading by +1 (starboard / right) or -1 (port / left). */
  turn(dir: -1 | 1): void {
    if (this.mode !== "sailing") return;
    this.heading = ((((this.heading + dir) % 4) + 4) % 4) as Heading;
    this.updateVisual();
  }

  /** Footprint tiles occupied by the ship in a given docked pose. */
  static footprint(pose: DockedPose, dims: VesselDims = ROWBOAT_DIMS): Array<{ x: number; y: number }> {
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
  static bboxCenterPx(pose: DockedPose, dims: VesselDims = ROWBOAT_DIMS): { x: number; y: number } {
    const { tx, ty, heading } = pose;
    const eastWest = heading === 1 || heading === 3;
    const w = eastWest ? dims.tilesLong : dims.tilesWide;
    const h = eastWest ? dims.tilesWide : dims.tilesLong;
    return { x: (tx + w / 2) * TILE_SIZE, y: (ty + h / 2) * TILE_SIZE };
  }

  /**
   * Tile occupied by the helm (where the player stands to steer) in a docked pose.
   * Tuned for the rowboat's 2×1 footprint — the player-interactive vessel. The helm
   * is the stern tile (opposite the bow implied by `heading`).
   */
  static helmTile(pose: DockedPose, _dims: VesselDims = ROWBOAT_DIMS): { x: number; y: number } {
    const { tx, ty, heading } = pose;
    switch (heading) {
      case 0:
        return { x: tx, y: ty + 1 };
      case 1:
        return { x: tx, y: ty };
      case 2:
        return { x: tx, y: ty };
      case 3:
        return { x: tx + 1, y: ty };
    }
  }

  /** World-pixel position of the helm, for parking the player while sailing/anchoring. */
  helmWorldPx(): { x: number; y: number } {
    const a = headingToRotation(this.heading);
    const lx = -TILE_SIZE / 2;
    const ly = 0;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return {
      x: this.x + lx * c - ly * s,
      y: this.y + lx * s + ly * c,
    };
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

  /** Advance physics while sailing. Heading changes are discrete (see `turn()`). */
  updateSailing(dtSec: number): void {
    const targetSpeed = this.targetThrottle * SHIP_MAX_SPEED;
    if (this.speed < targetSpeed) this.speed = Math.min(targetSpeed, this.speed + SHIP_ACCEL * dtSec);
    else this.speed = Math.max(targetSpeed, this.speed - SHIP_ACCEL * dtSec);

    const a = headingToRotation(this.heading);
    this.x += Math.cos(a) * this.speed * dtSec;
    this.y += Math.sin(a) * this.speed * dtSec;

    this.container.setPosition(this.x, this.y);
  }

  /** Set position (and optionally heading) — used by anchoring drift tween. */
  setPose(x: number, y: number, heading?: Heading): void {
    this.x = x;
    this.y = y;
    this.container.setPosition(x, y);
    if (heading !== undefined && heading !== this.heading) {
      this.heading = heading;
      this.updateVisual();
    }
  }

  finalizeDock(pose: DockedPose): void {
    this.docked = { ...pose };
    const c = Ship.bboxCenterPx(pose, this.dims);
    this.setPose(c.x, c.y, pose.heading);
    this.mode = "docked";
    this.speed = 0;
    this.targetThrottle = 0;
    this.updateVisual();
  }

  serialize(): {
    x: number;
    y: number;
    heading: Heading;
    mode: ShipMode;
    speed: number;
    targetThrottle: number;
    docked: DockedPose;
  } {
    return {
      x: this.x,
      y: this.y,
      heading: this.heading,
      mode: this.mode,
      speed: this.speed,
      targetThrottle: this.targetThrottle,
      docked: { ...this.docked },
    };
  }

  hydrate(data: {
    x: number;
    y: number;
    heading: Heading;
    mode: ShipMode;
    speed: number;
    targetThrottle: number;
    docked: DockedPose;
  }): void {
    this.docked = { ...data.docked };
    this.mode = data.mode;
    this.speed = data.speed;
    this.targetThrottle = data.targetThrottle;
    this.setPose(data.x, data.y, data.heading);
    this.updateVisual();
  }
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
