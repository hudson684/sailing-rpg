import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import {
  PLAYER_FRAME_SIZE,
  playerAnimKey,
  playerTextureKey,
  type PlayerAnimDir,
  type PlayerAnimState,
} from "./playerAnims";

export const PLAYER_SPEED = 199; // pixels / sec
// Collision footprint at the feet. Wider than tall and offset down from
// `player.y` (the sprite origin, which sits around the waist) so the hitbox
// hugs the shoes. Tune in this file, not in the sampler.
export const PLAYER_FEET_WIDTH = 12;
export const PLAYER_FEET_HEIGHT = 4;
// Offset from `player.y` (sprite origin, at the bottom of the shoes) to the
// rect CENTER. Negative so the rect's bottom edge lands at the origin.
export const PLAYER_FEET_OFFSET_Y = -PLAYER_FEET_HEIGHT / 2;

// The visible character is ~13px wide inside a 79×79 frame; scale so it
// reads at roughly the previous on-screen size (~22px).
const PLAYER_SPRITE_SCALE = 1.7;
// Feet sit ~y=40 within the 79-frame; expressed as a normalized origin.
const PLAYER_ORIGIN_Y = 40 / PLAYER_FRAME_SIZE;

export type Facing =
  | "up"
  | "up-right"
  | "right"
  | "down-right"
  | "down"
  | "down-left"
  | "left"
  | "up-left";

export const FACING_VALUES: readonly Facing[] = [
  "up",
  "up-right",
  "right",
  "down-right",
  "down",
  "down-left",
  "left",
  "up-left",
];

// 4-direction sheet — diagonals collapse to the horizontal (side) facing,
// since lateral motion reads more naturally than up/down for a diagonal step.
function facingToAnimDir(f: Facing): { dir: PlayerAnimDir; flipX: boolean } {
  switch (f) {
    case "up": return { dir: "up", flipX: false };
    case "down": return { dir: "down", flipX: false };
    case "right":
    case "up-right":
    case "down-right":
      return { dir: "side", flipX: false };
    case "left":
    case "up-left":
    case "down-left":
      return { dir: "side", flipX: true };
  }
}

// Pick an 8-way facing from raw (dx, dy). Uses a ~22.5° dead-zone on each
// axis so near-cardinal input snaps cardinal instead of flickering to
// diagonal. Returns null if the input has no direction.
function facingFromDelta(dx: number, dy: number): Facing | null {
  if (dx === 0 && dy === 0) return null;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const diagonalRatio = 0.4; // tan(~22°) — below this the minor axis is ignored
  const horizontal = ax > 0 && ay / ax < diagonalRatio;
  const vertical = ay > 0 && ax / ay < diagonalRatio;
  if (horizontal) return dx > 0 ? "right" : "left";
  if (vertical) return dy > 0 ? "down" : "up";
  // Diagonal: both axes meaningful.
  if (dx > 0 && dy > 0) return "down-right";
  if (dx > 0 && dy < 0) return "up-right";
  if (dx < 0 && dy > 0) return "down-left";
  return "up-left";
}

export class Player {
  public readonly sprite: Phaser.GameObjects.Sprite;
  private _facing: Facing = "down";
  private _animState: PlayerAnimState = "idle";
  private _attacking = false;
  public frozen = false;

  get attacking(): boolean {
    return this._attacking;
  }

  /**
   * Start a primary attack in the current facing. Plays the attack animation
   * once, then reverts to idle. No-op if already attacking or frozen.
   */
  attack(): boolean {
    if (this._attacking || this.frozen) return false;
    this._attacking = true;
    this._animState = "attack";
    this.applyAnim();
    this.sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      this._attacking = false;
      this._animState = "idle";
      this.applyAnim();
    });
    return true;
  }

  get facing(): Facing {
    return this._facing;
  }

  setFacing(f: Facing): void {
    this._facing = f;
    this.applyAnim();
  }

  serialize(): { x: number; y: number; facing: Facing } {
    return { x: this.sprite.x, y: this.sprite.y, facing: this._facing };
  }

  hydrate(data: { x: number; y: number; facing: Facing }): void {
    this.sprite.setPosition(data.x, data.y);
    this.sprite.setDepth(this.sortY());
    this._facing = data.facing;
    this._animState = "idle";
    this.applyAnim();
  }

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.sprite = scene.add.sprite(x, y, playerTextureKey("idle"), 0);
    this.sprite.setScale(PLAYER_SPRITE_SCALE);
    this.sprite.setOrigin(0.5, PLAYER_ORIGIN_Y);
    this.sprite.setDepth(this.sortY());
    this.applyAnim();
  }

  get x(): number {
    return this.sprite.x;
  }
  get y(): number {
    return this.sprite.y;
  }

  /** Y-value used for depth sorting — the sprite's visible bottom edge (feet). */
  sortY(): number {
    return this.sprite.y + (1 - PLAYER_ORIGIN_Y) * PLAYER_FRAME_SIZE * PLAYER_SPRITE_SCALE;
  }

  setPosition(x: number, y: number) {
    this.sprite.setPosition(x, y);
    this.sprite.setDepth(this.sortY());
  }

  setVisible(v: boolean) {
    this.sprite.setVisible(v);
  }

  /** Returns the player's tile coordinates (integer). */
  tile(): { x: number; y: number } {
    return {
      x: Math.floor(this.sprite.x / TILE_SIZE),
      y: Math.floor(this.sprite.y / TILE_SIZE),
    };
  }

  /**
   * Attempt to move by (dx, dy) this frame, respecting a walkability predicate.
   * Uses axis-separated tests so the player can slide along walls.
   */
  tryMove(dx: number, dy: number, isWalkablePx: (x: number, y: number) => boolean) {
    if (this.frozen) {
      this.setAnimState("idle");
      return;
    }
    if (this._attacking) {
      // Movement locked during the swing; facing/anim already set.
      return;
    }
    let moved = false;
    if (dx !== 0) {
      const nx = this.sprite.x + dx;
      if (isWalkablePx(nx, this.sprite.y)) {
        this.sprite.x = nx;
        moved = true;
      }
    }
    if (dy !== 0) {
      const ny = this.sprite.y + dy;
      if (isWalkablePx(this.sprite.x, ny)) {
        this.sprite.y = ny;
        moved = true;
      }
    }
    const intended = facingFromDelta(dx, dy);
    if (intended) this._facing = intended;
    this.setAnimState(moved ? "walk" : "idle");
    this.sprite.setDepth(this.sortY());
  }

  private setAnimState(state: PlayerAnimState) {
    if (state === this._animState && this.sprite.anims.isPlaying) {
      this.applyAnim();
      return;
    }
    this._animState = state;
    this.applyAnim();
  }

  private applyAnim() {
    const { dir, flipX } = facingToAnimDir(this._facing);
    this.sprite.setFlipX(flipX);
    this.sprite.anims.play(playerAnimKey(this._animState, dir), true);
  }
}
