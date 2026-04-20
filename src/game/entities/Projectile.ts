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
    // Shaft
    g.fillStyle(0x6b4a1f, 1);
    g.lineStyle(1, 0x2a1a06, 1);
    g.fillRect(-10, -1, 18, 2);
    g.strokeRect(-10, -1, 18, 2);
    // Fletching
    g.fillStyle(0xd94a3a, 1);
    g.beginPath();
    g.moveTo(-12, 0);
    g.lineTo(-8, -4);
    g.lineTo(-6, 0);
    g.lineTo(-8, 4);
    g.closePath();
    g.fillPath();
    g.strokePath();
    // Head
    g.fillStyle(0xf0e6c8, 1);
    g.beginPath();
    g.moveTo(14, 0);
    g.lineTo(6, -4);
    g.lineTo(6, 4);
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
    const ox = this.sprite.x;
    const oy = this.sprite.y;
    const fullDx = this.vx * dt;
    const fullDy = this.vy * dt;
    const fullStep = Math.hypot(fullDx, fullDy);
    if (fullStep < 0.001) return null;

    // Sweep in small substeps so fast arrows can't tunnel past generous enemy
    // hitboxes, and so an arrow that passes *over* an enemy counts as a hit
    // even if the per-frame endpoint lands behind them.
    const subPx = 4;
    const subs = Math.max(1, Math.ceil(fullStep / subPx));
    const sx = fullDx / subs;
    const sy = fullDy / subs;

    for (let i = 1; i <= subs; i++) {
      const px = ox + sx * i;
      const py = oy + sy * i;
      const advanced = (fullStep * i) / subs;

      if (this.travelled + advanced >= this.rangePx) {
        this.sprite.setPosition(px, py);
        this.sprite.setDepth(py + 1);
        this.travelled += advanced;
        this.destroy();
        return null;
      }
      if (isBlockedPx(px, py)) {
        this.sprite.setPosition(px, py);
        this.sprite.setDepth(py + 1);
        this.travelled += advanced;
        this.destroy();
        return null;
      }
      for (const enemy of enemies) {
        if (!enemy.isAlive()) continue;
        if (this.hitIds.has(enemy.id)) continue;
        if (!enemy.arrowHitPx(px, py)) continue;
        this.hitIds.add(enemy.id);
        this.sprite.setPosition(px, py);
        this.sprite.setDepth(py + 1);
        this.travelled += advanced;
        return { killed: false, enemy };
      }
    }

    this.sprite.setPosition(ox + fullDx, oy + fullDy);
    this.sprite.setDepth(oy + fullDy + 1);
    this.travelled += fullStep;
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

