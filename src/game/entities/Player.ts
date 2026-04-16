import * as Phaser from "phaser";
import { TILE_SIZE } from "../config";

export const PLAYER_SPEED = 140; // pixels / sec
export const PLAYER_RADIUS = 10;

export class Player {
  public readonly sprite: Phaser.GameObjects.Container;
  private body: Phaser.GameObjects.Arc;
  private nose: Phaser.GameObjects.Rectangle;
  private facing: "up" | "down" | "left" | "right" = "down";
  public frozen = false;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.sprite = scene.add.container(x, y);
    this.body = scene.add.circle(0, 0, PLAYER_RADIUS, 0xf2d8a7).setStrokeStyle(2, 0x2a1b0a);
    this.nose = scene.add.rectangle(0, PLAYER_RADIUS - 2, 5, 5, 0x2a1b0a);
    this.sprite.add([this.body, this.nose]);
    this.sprite.setDepth(50);
  }

  get x(): number {
    return this.sprite.x;
  }
  get y(): number {
    return this.sprite.y;
  }

  setPosition(x: number, y: number) {
    this.sprite.setPosition(x, y);
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
    if (this.frozen) return;
    if (dx !== 0) {
      const nx = this.sprite.x + dx;
      if (isWalkablePx(nx, this.sprite.y)) this.sprite.x = nx;
    }
    if (dy !== 0) {
      const ny = this.sprite.y + dy;
      if (isWalkablePx(this.sprite.x, ny)) this.sprite.y = ny;
    }
    if (Math.abs(dx) > Math.abs(dy)) this.facing = dx > 0 ? "right" : "left";
    else if (dy !== 0) this.facing = dy > 0 ? "down" : "up";
    this.updateNose();
  }

  private updateNose() {
    switch (this.facing) {
      case "up":
        this.nose.setPosition(0, -(PLAYER_RADIUS - 2));
        break;
      case "down":
        this.nose.setPosition(0, PLAYER_RADIUS - 2);
        break;
      case "left":
        this.nose.setPosition(-(PLAYER_RADIUS - 2), 0);
        break;
      case "right":
        this.nose.setPosition(PLAYER_RADIUS - 2, 0);
        break;
    }
  }
}
