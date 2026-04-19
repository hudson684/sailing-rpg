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
const SHIP_REVERSE_MAX = 30; // px/s when backing off a beach (negative throttle)
const SHIP_ACCEL = 60; // px/s^2

export type ShipTileState = "water" | "beach" | "blocked";

export interface SailingStepResult {
  beached: boolean;
  blocked: boolean;
}

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
    this.container.setDepth(this.sortY());

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

  /** Y-value used for depth sorting — bottom of the footprint in world pixels.
   *  Chosen over the visual sprite bottom because vessel art frames include tall
   *  masts/sails extending well above the hull; sorting by the footprint keeps
   *  the player drawing correctly relative to the hull (the walkable reference). */
  sortY(): number {
    const eastWest = this.heading === 1 || this.heading === 3;
    const hTiles = eastWest ? this.dims.tilesWide : this.dims.tilesLong;
    return this.y + (hTiles / 2) * TILE_SIZE;
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

  /**
   * World-pixel position of the helm, for parking the player while sailing/anchoring.
   * Tuned to the visible stern of the rowboat artwork — the sprite isn't centered in
   * its 288×256 frame, so we use per-heading offsets instead of a single rotated vector.
   */
  helmWorldPx(): { x: number; y: number } {
    const offset = HELM_OFFSET_PX[this.vessel.id][this.heading];
    return { x: this.x + offset.dx, y: this.y + offset.dy };
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
    dims: VesselDims = ROWBOAT_DIMS,
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
      this.container.setPosition(this.x, this.y);
      this.container.setDepth(this.sortY());
      return { beached: false, blocked: true };
    }

    if (worst === "beach") {
      // Soft grounding: forward thrust dies, reverse off only.
      if (this.targetThrottle > 0) this.targetThrottle = 0;
      if (nextSpeed > 0) nextSpeed = 0;
      this.speed = nextSpeed;
      this.x += Math.cos(a) * this.speed * dtSec;
      this.y += Math.sin(a) * this.speed * dtSec;
      this.container.setPosition(this.x, this.y);
      this.container.setDepth(this.sortY());
      return { beached: true, blocked: false };
    }

    this.speed = nextSpeed;
    this.x = nx;
    this.y = ny;
    this.container.setPosition(this.x, this.y);
    this.container.setDepth(this.sortY());
    return { beached: false, blocked: false };
  }

  /** Set position (and optionally heading) — used by anchoring drift tween. */
  setPose(x: number, y: number, heading?: Heading): void {
    this.x = x;
    this.y = y;
    this.container.setPosition(x, y);
    this.container.setDepth(this.sortY());
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

/**
 * Per-vessel visual helm offsets (in world px, post-scale). The helm sits on
 * the stern deck of the rendered sprite — not at the footprint's bbox center —
 * so we compensate for both (a) the sprite's off-centre position inside its
 * frame and (b) the visible hull extending well beyond the 2×1 tile footprint.
 */
const HELM_OFFSET_PX: Record<VesselTemplate["id"], Record<Heading, { dx: number; dy: number }>> = {
  rowboat: {
    0: { dx: -2, dy: 22 },  // bow N → helm S (stern)
    1: { dx: -20, dy: 9 },  // bow E → helm W
    2: { dx: -2, dy: -14 }, // bow S → helm N
    3: { dx: 20, dy: 9 },   // bow W → helm E
  },
  galleon: {
    0: { dx: 0, dy: 40 },
    1: { dx: -40, dy: 0 },
    2: { dx: 0, dy: -40 },
    3: { dx: 40, dy: 0 },
  },
};

export function headingToRotation(h: Heading): number {
  return (h - 1) * (Math.PI / 2);
}

/** Normalize an angle to (-PI, PI]. Kept for debug cost heuristics. */
export function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}
