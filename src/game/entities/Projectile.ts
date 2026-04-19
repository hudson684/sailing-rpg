import * as Phaser from "phaser";
import type { Enemy } from "./Enemy";

export interface ProjectileOpts {
  x: number;
  y: number;
  angle: number;
  speedPx: number;
  rangePx: number;
  damage: number;
  ownerId: string;
}

interface HitResult {
  killed: boolean;
  enemy: Enemy;
}

/**
 * Simple arrow projectile. Manually updated each frame (no Arcade body) to
 * match the rest of the combat code, which does its own tile/enemy overlap
 * checks. The sprite is a small yellow diamond drawn via Graphics — swap for
 * a real arrow texture once art lands.
 */
export class Projectile {
  readonly ownerId: string;
  readonly damage: number;
  readonly sprite: Phaser.GameObjects.Graphics;

  private vx: number;
  private vy: number;
  private travelled = 0;
  private readonly rangePx: number;
  private alive = true;
  /** Enemy ids already hit by this arrow so repeat overlaps don't double-dip. */
  private readonly hitIds = new Set<string>();

  constructor(scene: Phaser.Scene, opts: ProjectileOpts) {
    this.ownerId = opts.ownerId;
    this.damage = opts.damage;
    this.rangePx = opts.rangePx;
    this.vx = Math.cos(opts.angle) * opts.speedPx;
    this.vy = Math.sin(opts.angle) * opts.speedPx;

    const g = scene.add.graphics();
    g.fillStyle(0xffe27a, 1);
    g.lineStyle(1, 0x3a2a08, 1);
    // Draw a thin arrow-shaped diamond pointing +X; container is rotated to
    // match the shot angle so the tip always leads.
    g.beginPath();
    g.moveTo(8, 0);
    g.lineTo(-4, -2);
    g.lineTo(-4, 2);
    g.closePath();
    g.fillPath();
    g.strokePath();
    g.setPosition(opts.x, opts.y);
    g.setRotation(opts.angle);
    g.setDepth(opts.y + 1);
    this.sprite = g;
  }

  get x(): number { return this.sprite.x; }
  get y(): number { return this.sprite.y; }
  isAlive(): boolean { return this.alive; }

  /**
   * Advance the projectile. Returns the first enemy hit this frame (and
   * whether the hit killed it), or null. The caller handles drops/XP/toasts
   * so those concerns stay out of the projectile.
   */
  update(
    dtMs: number,
    enemies: readonly Enemy[],
    isBlockedPx: (x: number, y: number) => boolean,
  ): HitResult | null {
    if (!this.alive) return null;
    const dt = dtMs / 1000;
    const nx = this.sprite.x + this.vx * dt;
    const ny = this.sprite.y + this.vy * dt;
    const step = Math.hypot(nx - this.sprite.x, ny - this.sprite.y);
    this.travelled += step;
    this.sprite.setPosition(nx, ny);
    this.sprite.setDepth(ny + 1);

    if (this.travelled >= this.rangePx) {
      this.destroy();
      return null;
    }
    if (isBlockedPx(nx, ny)) {
      this.destroy();
      return null;
    }
    // Overlap check against each living enemy. First hit consumes the arrow.
    for (const enemy of enemies) {
      if (!enemy.isAlive()) continue;
      if (this.hitIds.has(enemy.id)) continue;
      if (!enemy.blocksPx(nx, ny)) continue;
      this.hitIds.add(enemy.id);
      return { killed: false, enemy };
    }
    return null;
  }

  destroy(): void {
    if (!this.alive) return;
    this.alive = false;
    this.sprite.destroy();
  }
}

/**
 * 2D distance-weighted check: is the straight line from (x0,y0) to (x1,y1)
 * clear of blocking terrain? Used for the aim reticle so the player sees red
 * when a shot would hit a wall before reaching the cursor.
 */
export function rayBlocked(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  isBlockedPx: (x: number, y: number) => boolean,
  stepPx = 8,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return false;
  const steps = Math.ceil(len / stepPx);
  const sx = dx / steps;
  const sy = dy / steps;
  for (let i = 1; i <= steps; i++) {
    if (isBlockedPx(x0 + sx * i, y0 + sy * i)) return true;
  }
  return false;
}

