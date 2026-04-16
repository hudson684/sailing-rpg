import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";

export type Heading = 0 | 1 | 2 | 3; // 0=N, 1=E, 2=S, 3=W

export type ShipMode = "docked" | "sailing" | "anchoring";

export interface DockedPose {
  tx: number;
  ty: number;
  heading: Heading;
}

const SHIP_MAX_SPEED = 120; // px/s at full throttle
const SHIP_ACCEL = 60; // px/s^2
const SHIP_TURN_RATE_MAX = 1.4; // rad/s

const HULL_COLOR = 0x5e3a1a;
const HULL_STROKE = 0x2a1a08;
const DECK_COLOR = 0xb88449;
const MAST_COLOR = 0x2a1a08;
const HELM_COLOR = 0xd9b07a;

export class Ship {
  public mode: ShipMode = "docked";
  public docked: DockedPose;

  /** Continuous pose in pixels/radians (authoritative when sailing/anchoring). */
  public x: number;
  public y: number;
  public rotation: number;

  public speed = 0;
  public targetThrottle = 0; // 0..1
  public rudder = 0; // -1..1

  public readonly container: Phaser.GameObjects.Container;
  private readonly hull: Phaser.GameObjects.Rectangle;
  private readonly deckTiles: Phaser.GameObjects.Rectangle[] = [];
  private readonly mast: Phaser.GameObjects.Arc;
  private readonly helmMarker: Phaser.GameObjects.Rectangle;
  private readonly bowMarker: Phaser.GameObjects.Triangle;

  constructor(scene: Phaser.Scene, docked: DockedPose) {
    this.docked = { ...docked };
    const centerPx = Ship.bboxCenterPx(docked);
    this.x = centerPx.x;
    this.y = centerPx.y;
    this.rotation = headingToRotation(docked.heading);

    this.container = scene.add.container(this.x, this.y);
    this.container.setDepth(30);
    this.container.setRotation(this.rotation);

    // Hull: 3 tiles long x 2 tiles wide in east-facing default orientation.
    this.hull = scene.add
      .rectangle(0, 0, TILE_SIZE * 3 + 4, TILE_SIZE * 2 + 4, HULL_COLOR)
      .setStrokeStyle(2, HULL_STROKE);

    // 6 deck tiles (visible in all modes for consistency)
    const deckOffsets: [number, number][] = [
      [-TILE_SIZE, -TILE_SIZE / 2],
      [0, -TILE_SIZE / 2],
      [TILE_SIZE, -TILE_SIZE / 2],
      [-TILE_SIZE, TILE_SIZE / 2],
      [0, TILE_SIZE / 2],
      [TILE_SIZE, TILE_SIZE / 2],
    ];
    for (const [ox, oy] of deckOffsets) {
      const t = scene.add
        .rectangle(ox, oy, TILE_SIZE - 2, TILE_SIZE - 2, DECK_COLOR)
        .setStrokeStyle(1, HULL_STROKE);
      this.deckTiles.push(t);
    }

    // Mast in center
    this.mast = scene.add.circle(0, 0, 5, MAST_COLOR);

    // Helm marker (the wheel) at local (0, -TILE/2) — mid-top in east-facing
    this.helmMarker = scene.add
      .rectangle(0, -TILE_SIZE / 2, 10, 10, HELM_COLOR)
      .setStrokeStyle(1, HULL_STROKE);

    // Bow marker — pointing +x in local space (east-facing default)
    this.bowMarker = scene.add.triangle(
      TILE_SIZE * 1.3,
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
  }

  /** Footprint tiles occupied by the ship in a given docked pose. */
  static footprint(pose: DockedPose): Array<{ x: number; y: number }> {
    const { tx, ty, heading } = pose;
    const tiles: Array<{ x: number; y: number }> = [];
    if (heading === 1 || heading === 3) {
      // 3 wide x 2 tall
      for (let dx = 0; dx < 3; dx++) {
        for (let dy = 0; dy < 2; dy++) tiles.push({ x: tx + dx, y: ty + dy });
      }
    } else {
      // 2 wide x 3 tall
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 3; dy++) tiles.push({ x: tx + dx, y: ty + dy });
      }
    }
    return tiles;
  }

  /** Pixel center of the bbox for a given docked pose. */
  static bboxCenterPx(pose: DockedPose): { x: number; y: number } {
    const { tx, ty, heading } = pose;
    if (heading === 1 || heading === 3) {
      return { x: (tx + 1.5) * TILE_SIZE, y: (ty + 1) * TILE_SIZE };
    }
    return { x: (tx + 1) * TILE_SIZE, y: (ty + 1.5) * TILE_SIZE };
  }

  /** Tile occupied by the helm (where the player stands to steer) in a docked pose. */
  static helmTile(pose: DockedPose): { x: number; y: number } {
    const { tx, ty, heading } = pose;
    switch (heading) {
      case 0:
        return { x: tx, y: ty + 1 };
      case 1:
        return { x: tx + 1, y: ty };
      case 2:
        return { x: tx + 1, y: ty + 1 };
      case 3:
        return { x: tx + 1, y: ty + 1 };
    }
  }

  /** World pixel position of the helm (for parking the player while sailing/anchoring). */
  helmWorldPx(): { x: number; y: number } {
    // Helm local = (0, -TILE/2) in east-facing. Rotate + translate.
    const lx = 0;
    const ly = -TILE_SIZE / 2;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
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
    return Ship.footprint(this.docked).some((t) => t.x === tx && t.y === ty);
  }

  /** Begin sailing: switch from docked pose to continuous physics. */
  startSailing() {
    this.mode = "sailing";
    this.speed = 0;
    this.targetThrottle = 0;
    this.rudder = 0;
  }

  /** Called from scene update() while sailing. */
  updateSailing(dtSec: number) {
    // Throttle → speed
    const targetSpeed = this.targetThrottle * SHIP_MAX_SPEED;
    if (this.speed < targetSpeed) this.speed = Math.min(targetSpeed, this.speed + SHIP_ACCEL * dtSec);
    else this.speed = Math.max(targetSpeed, this.speed - SHIP_ACCEL * dtSec);

    // Rudder → angular velocity (reduced when stationary, but still some)
    const steerScale = 0.3 + 0.7 * Math.min(1, Math.abs(this.speed) / SHIP_MAX_SPEED);
    this.rotation += this.rudder * SHIP_TURN_RATE_MAX * steerScale * dtSec;

    // Position advance along heading
    this.x += Math.cos(this.rotation) * this.speed * dtSec;
    this.y += Math.sin(this.rotation) * this.speed * dtSec;

    this.container.setPosition(this.x, this.y);
    this.container.setRotation(this.rotation);
  }

  /** Set visual pose during an anchoring tween. */
  setPose(x: number, y: number, rot: number) {
    this.x = x;
    this.y = y;
    this.rotation = rot;
    this.container.setPosition(x, y);
    this.container.setRotation(rot);
  }

  /** Finalize a successful anchor — commit a new docked pose. */
  finalizeDock(pose: DockedPose) {
    this.docked = { ...pose };
    const c = Ship.bboxCenterPx(pose);
    this.setPose(c.x, c.y, headingToRotation(pose.heading));
    this.mode = "docked";
    this.speed = 0;
    this.targetThrottle = 0;
    this.rudder = 0;
  }
}

export function headingToRotation(h: Heading): number {
  return (h - 1) * (Math.PI / 2);
}

/** Normalize an angle to (-PI, PI]. */
export function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}
