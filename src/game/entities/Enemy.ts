import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import {
  enemyAnimKey,
  enemyAnimTextureKey,
  enemyTextureKey,
  type EnemyAnimState,
  type EnemyCombat,
  type EnemyDef,
  type EnemyInstanceData,
} from "./enemyTypes";
import type { MapId } from "./mapId";
import type { EntityModel } from "./registry";

type EnemyState = "idle" | "chase" | "attack" | "hurt" | "returning" | "dying" | "dead";

/** Total stun after taking a hit — player is guaranteed this much free time. */
const HURT_STUN_MS = 250;
/** Portion of the stun during which the knockback impulse is applied. */
const HURT_KNOCKBACK_MS = 180;
/** Initial knockback speed (px/s); decays to 0 by the end of KNOCKBACK_MS. */
const HURT_KNOCKBACK_SPEED = 240;
const HURT_TINT = 0xff6a6a;
type Facing = "left" | "right";

interface PlayerRef {
  x: number;
  y: number;
  onHit: (damage: number) => void;
}

export class Enemy implements EntityModel {
  readonly id: string;
  readonly kind = "enemy" as const;
  mapId: MapId = { kind: "world" };
  readonly def: EnemyDef;
  readonly sprite: Phaser.GameObjects.Sprite;

  private hpFloat: number;
  private state: EnemyState = "idle";
  private respawnAt = 0;

  private facing: Facing = "right";
  private animState: EnemyAnimState = "idle";

  /** Sub-timer within the current state (wander pause, wander leg deadline). */
  private stateTimer = 0;
  /** True = in the "moving" half of wander; false = in the pause half. Only used in idle. */
  private wanderMoving = false;
  private targetPx: { x: number; y: number } | null = null;
  private readonly homePx: { x: number; y: number };
  private attackCooldownMs = 0;
  /** Player attack set this — forces transition to chase regardless of aggro radius. */
  private forceAggro = false;

  private hurtTimer = 0;
  private kbTimer = 0;
  private kbVx = 0;
  private kbVy = 0;

  private readonly hpBarBg: Phaser.GameObjects.Rectangle;
  private readonly hpBar: Phaser.GameObjects.Rectangle;

  constructor(scene: Phaser.Scene, def: EnemyDef, instance: EnemyInstanceData) {
    this.id = instance.id;
    this.def = def;
    this.hpFloat = def.hp;
    const x = (instance.tileX + 0.5) * TILE_SIZE;
    const y = (instance.tileY + 0.5) * TILE_SIZE;
    this.homePx = { x, y };

    this.sprite = scene.add.sprite(x, y, enemyTextureKey(def.id), 0);
    this.sprite.setScale(def.display.scale);
    this.sprite.setOrigin(0.5, def.display.originY);
    this.sprite.setDepth(this.sortY());

    const barW = Math.max(18, def.sprite.frameWidth * def.display.scale * 0.9);
    const barY = -def.sprite.frameHeight * def.display.scale * def.display.originY - 4;
    this.hpBarBg = scene.add.rectangle(x, y + barY, barW, 3, 0x000000, 0.6).setOrigin(0.5, 1);
    this.hpBar = scene.add.rectangle(x - barW / 2, y + barY, barW, 3, 0xcc4444).setOrigin(0, 1);
    this.hpBarBg.setVisible(false);
    this.hpBar.setVisible(false);
    this.hpBarBg.setDepth(this.sortY());
    this.hpBar.setDepth(this.sortY());

    this.stateTimer = Math.random() * 1500;
    this.applyAnim();
  }

  get x(): number { return this.sprite.x; }
  get y(): number { return this.sprite.y; }

  isAlive(): boolean { return this.state !== "dying" && this.state !== "dead"; }

  sortY(): number {
    const { display, sprite } = this.def;
    return this.sprite.y + (1 - display.originY) * sprite.frameHeight * display.scale;
  }

  /** Pixel-rect blocking footprint for living enemies. */
  blocksPx(px: number, py: number): boolean {
    if (!this.isAlive()) return false;
    const w = this.def.sprite.frameWidth * this.def.display.scale * 0.45;
    const h = this.def.sprite.frameHeight * this.def.display.scale * 0.35;
    const cy = this.sprite.y - 2;
    return (
      px >= this.sprite.x - w / 2 &&
      px <= this.sprite.x + w / 2 &&
      py >= cy - h / 2 &&
      py <= cy + h / 2
    );
  }

  /**
   * Larger, more forgiving footprint for arrow/projectile hits. Covers most of
   * the sprite (head to feet) so shots that visually pass over the enemy count
   * as hits even when the cursor was aimed just behind them.
   */
  arrowHitPx(px: number, py: number): boolean {
    if (!this.isAlive()) return false;
    const w = this.def.sprite.frameWidth * this.def.display.scale * 0.75;
    const h = this.def.sprite.frameHeight * this.def.display.scale * 0.7;
    const cy = this.sprite.y - this.def.sprite.frameHeight * this.def.display.scale * 0.25;
    return (
      px >= this.sprite.x - w / 2 &&
      px <= this.sprite.x + w / 2 &&
      py >= cy - h / 2 &&
      py <= cy + h / 2
    );
  }

  /** Apply 1 hit. Returns true on the killing blow. */
  hit(scene: Phaser.Scene, damage = 1, attackerX?: number, attackerY?: number): boolean {
    if (!this.isAlive()) return false;
    this.hpFloat -= damage;
    this.updateHpBar();
    if (this.hpFloat <= 0) {
      this.die();
      return true;
    }
    if (this.def.combat) this.forceAggro = true;
    this.enterHurt(attackerX, attackerY);
    void scene;
    return false;
  }

  private updateHpBar() {
    const pct = Math.max(0, this.hpFloat / this.def.hp);
    const fullW = this.hpBarBg.width;
    const visible = pct < 1;
    this.hpBar.setVisible(visible);
    this.hpBarBg.setVisible(visible);
    this.hpBar.width = fullW * pct;
  }

  private die() {
    this.state = "dying";
    this.targetPx = null;
    this.forceAggro = false;
    this.hurtTimer = 0;
    this.kbTimer = 0;
    this.sprite.clearTint();
    this.hpBar.setVisible(false);
    this.hpBarBg.setVisible(false);
    this.setAnimState("death");
    this.sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      this.state = "dead";
      this.sprite.setVisible(false);
    });
  }

  /** Schedule a respawn, called by WorldScene after handling drops. */
  beginRespawn(now: number): void {
    this.respawnAt = now + this.def.respawnSec * 1000;
  }

  update(
    dtMs: number,
    now: number,
    isWalkablePx: (x: number, y: number) => boolean,
    player?: PlayerRef,
  ): void {
    if (this.state === "dead") {
      if (now >= this.respawnAt) this.respawn();
      return;
    }
    if (this.state === "dying") return;

    if (this.attackCooldownMs > 0) this.attackCooldownMs -= dtMs;

    switch (this.state) {
      case "idle":
        this.updateIdle(dtMs, isWalkablePx, player);
        return;
      case "chase":
        this.updateChase(dtMs, isWalkablePx, player);
        return;
      case "attack":
        // Attack is driven by the ANIMATION_COMPLETE callback; no per-tick work.
        return;
      case "hurt":
        this.updateHurt(dtMs, isWalkablePx);
        return;
      case "returning":
        this.updateReturning(dtMs, isWalkablePx);
        return;
    }
  }

  // ---------- state updates ----------

  private updateIdle(
    dtMs: number,
    isWalkablePx: (x: number, y: number) => boolean,
    player: PlayerRef | undefined,
  ) {
    this.tickRegen(dtMs);

    if (this.shouldAggro(player)) {
      this.enterChase();
      return;
    }

    this.tickWander(dtMs, isWalkablePx);
  }

  private updateChase(
    dtMs: number,
    isWalkablePx: (x: number, y: number) => boolean,
    player: PlayerRef | undefined,
  ) {
    const combat = this.def.combat;
    if (!combat || !player) {
      this.enterReturning();
      return;
    }

    const homeToPlayer = Math.hypot(player.x - this.homePx.x, player.y - this.homePx.y);
    if (homeToPlayer > combat.leashRadiusPx) {
      this.enterReturning();
      return;
    }

    const distToPlayer = Math.hypot(player.x - this.sprite.x, player.y - this.sprite.y);
    if (distToPlayer <= combat.attackRangePx && this.attackCooldownMs <= 0) {
      this.beginAttack(player, combat);
      return;
    }

    this.stepToward(player.x, player.y, combat.chaseSpeedPx, dtMs, isWalkablePx);
  }

  private updateReturning(
    dtMs: number,
    isWalkablePx: (x: number, y: number) => boolean,
  ) {
    const combat = this.def.combat;
    const speed = combat?.chaseSpeedPx ?? 40;
    const dx = this.homePx.x - this.sprite.x;
    const dy = this.homePx.y - this.sprite.y;
    if (Math.hypot(dx, dy) < 2) {
      // Snap home, reset to idle.
      this.sprite.setPosition(this.homePx.x, this.homePx.y);
      this.enterIdle(400 + Math.random() * 600);
      return;
    }
    this.stepToward(this.homePx.x, this.homePx.y, speed, dtMs, isWalkablePx);
  }

  // ---------- state transitions ----------

  private enterIdle(pauseMs = 500) {
    this.state = "idle";
    this.wanderMoving = false;
    this.stateTimer = pauseMs;
    this.targetPx = null;
    this.setAnimState("idle");
  }

  private enterChase() {
    this.state = "chase";
    this.targetPx = null;
    this.forceAggro = false;
    this.setAnimState("move");
  }

  private enterReturning() {
    this.state = "returning";
    this.targetPx = null;
    this.forceAggro = false;
    this.setAnimState("move");
  }

  private enterHurt(attackerX?: number, attackerY?: number) {
    this.state = "hurt";
    this.hurtTimer = HURT_STUN_MS;
    this.kbTimer = HURT_KNOCKBACK_MS;
    this.targetPx = null;
    if (attackerX != null && attackerY != null) {
      const dx = this.sprite.x - attackerX;
      const dy = this.sprite.y - attackerY;
      const len = Math.hypot(dx, dy) || 1;
      this.kbVx = (dx / len) * HURT_KNOCKBACK_SPEED;
      this.kbVy = (dy / len) * HURT_KNOCKBACK_SPEED;
      this.setFacing(dx < 0 ? "right" : "left");
    } else {
      this.kbVx = 0;
      this.kbVy = 0;
    }
    this.sprite.setTint(HURT_TINT);
    // No dedicated hurt frame in the sheets; freeze on idle + tint communicates the state.
    this.setAnimState("idle");
  }

  private updateHurt(
    dtMs: number,
    isWalkablePx: (x: number, y: number) => boolean,
  ) {
    this.hurtTimer -= dtMs;

    if (this.kbTimer > 0) {
      // Linear decay to 0 over the knockback window so the push eases out.
      const prevFrac = Math.max(0, this.kbTimer) / HURT_KNOCKBACK_MS;
      this.kbTimer -= dtMs;
      const nextFrac = Math.max(0, this.kbTimer) / HURT_KNOCKBACK_MS;
      const avgFrac = (prevFrac + nextFrac) / 2;
      const dt = dtMs / 1000;
      const nx = this.sprite.x + this.kbVx * avgFrac * dt;
      const ny = this.sprite.y + this.kbVy * avgFrac * dt;
      if (isWalkablePx(nx, this.sprite.y)) this.sprite.x = nx;
      if (isWalkablePx(this.sprite.x, ny)) this.sprite.y = ny;
      this.syncOverlayPositions();
      this.sprite.setDepth(this.sortY());
    }

    if (this.hurtTimer <= 0) {
      this.sprite.clearTint();
      if (this.def.combat) this.enterChase();
      else this.enterIdle(400);
    }
  }

  private shouldAggro(player: PlayerRef | undefined): boolean {
    const combat = this.def.combat;
    if (!combat || !player) return false;
    if (this.forceAggro) return true;
    const d = Math.hypot(player.x - this.sprite.x, player.y - this.sprite.y);
    return d <= combat.aggroRadiusPx;
  }

  private tickRegen(dtMs: number) {
    const combat = this.def.combat;
    if (!combat || this.hpFloat >= this.def.hp) return;
    this.hpFloat = Math.min(this.def.hp, this.hpFloat + combat.regenPerSec * (dtMs / 1000));
    this.updateHpBar();
  }

  // ---------- movement primitives ----------

  private tickWander(
    dtMs: number,
    isWalkablePx: (x: number, y: number) => boolean,
  ) {
    const move = this.def.movement;
    if (move.type === "static") return;

    this.stateTimer -= dtMs;

    if (!this.wanderMoving) {
      if (this.stateTimer > 0) return;
      const maxDist = move.radiusTiles * TILE_SIZE;
      const angle = Math.random() * Math.PI * 2;
      const dist = maxDist * (0.3 + Math.random() * 0.7);
      this.targetPx = {
        x: this.homePx.x + Math.cos(angle) * dist,
        y: this.homePx.y + Math.sin(angle) * dist,
      };
      this.stateTimer = move.stepMs;
      this.wanderMoving = true;
      return;
    }

    if (!this.targetPx) {
      this.enterWanderPause(move.pauseMs);
      return;
    }

    const dx = this.targetPx.x - this.sprite.x;
    const dy = this.targetPx.y - this.sprite.y;
    if (Math.hypot(dx, dy) < 2 || this.stateTimer <= 0) {
      this.enterWanderPause(move.pauseMs);
      return;
    }

    const moved = this.stepToward(
      this.targetPx.x,
      this.targetPx.y,
      move.moveSpeed,
      dtMs,
      isWalkablePx,
    );
    if (!moved) this.enterWanderPause(move.pauseMs);
  }

  /** Returns true iff the sprite actually moved. Updates facing/anim/depth/overlays. */
  private stepToward(
    tx: number,
    ty: number,
    speedPx: number,
    dtMs: number,
    isWalkablePx: (x: number, y: number) => boolean,
  ): boolean {
    const dx = tx - this.sprite.x;
    const dy = ty - this.sprite.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return false;
    const step = Math.min(dist, speedPx * (dtMs / 1000));
    const nx = this.sprite.x + (dx / dist) * step;
    const ny = this.sprite.y + (dy / dist) * step;

    let moved = false;
    if (isWalkablePx(nx, this.sprite.y)) {
      this.sprite.x = nx;
      moved = true;
    }
    if (isWalkablePx(this.sprite.x, ny)) {
      this.sprite.y = ny;
      moved = true;
    }
    if (!moved) return false;

    if (Math.abs(dx) > 1) this.setFacing(dx < 0 ? "left" : "right");
    this.setAnimState("move");
    this.syncOverlayPositions();
    this.sprite.setDepth(this.sortY());
    return true;
  }

  private enterWanderPause(ms: number) {
    this.wanderMoving = false;
    this.stateTimer = ms;
    this.targetPx = null;
    this.setAnimState("idle");
  }

  // ---------- attack ----------

  private beginAttack(player: PlayerRef, combat: EnemyCombat) {
    this.state = "attack";
    this.attackCooldownMs = combat.cooldownMs;
    this.targetPx = null;
    this.setFacing(player.x < this.sprite.x ? "left" : "right");
    this.setAnimState("attack");
    this.sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      if (!this.isAlive()) return;
      // The attack was interrupted (e.g. we took a hit) — don't land damage or override the new state.
      if (this.state !== "attack") return;
      // Recheck range on landing — a dodging player avoids damage.
      const d = Math.hypot(player.x - this.sprite.x, player.y - this.sprite.y);
      if (d <= combat.attackRangePx * 1.1) {
        const span = combat.damageMax - combat.damageMin + 1;
        const dmg = combat.damageMin + Math.floor(Math.random() * span);
        if (dmg > 0) player.onHit(dmg);
      }
      // Re-evaluate: back to chase so the next tick decides attack-again vs pursue vs leash-break.
      this.enterChase();
    });
  }

  // ---------- respawn / overlays / anim plumbing ----------

  private respawn(): void {
    this.state = "idle";
    this.hpFloat = this.def.hp;
    this.forceAggro = false;
    this.hurtTimer = 0;
    this.kbTimer = 0;
    this.sprite.clearTint();
    this.sprite.setPosition(this.homePx.x, this.homePx.y);
    this.sprite.setAlpha(1);
    this.sprite.setVisible(true);
    this.sprite.setDepth(this.sortY());
    this.stateTimer = 500 + Math.random() * 1000;
    this.wanderMoving = false;
    this.updateHpBar();
    this.setAnimState("idle");
  }

  private syncOverlayPositions() {
    const barY =
      this.sprite.y -
      this.def.sprite.frameHeight * this.def.display.scale * this.def.display.originY -
      4;
    this.hpBarBg.setPosition(this.sprite.x, barY);
    this.hpBar.setPosition(this.sprite.x - this.hpBarBg.width / 2, barY);
    this.hpBarBg.setDepth(this.sortY());
    this.hpBar.setDepth(this.sortY());
  }

  private setFacing(f: Facing) {
    if (f === this.facing) return;
    this.facing = f;
    this.sprite.setFlipX(f === "left");
  }

  private setAnimState(state: EnemyAnimState) {
    if (this.animState === state && this.sprite.anims.isPlaying) return;
    this.animState = state;
    this.applyAnim();
  }

  private applyAnim() {
    this.sprite.setFlipX(this.facing === "left");
    // Per-anim origin override: oversized anim sheets (e.g. the swordsman's
    // 64×64 attack arc) have different padding than the base 32×32 grid, so
    // the default feet-anchor originY would shift the sprite mid-animation.
    const cfg = this.def.sprite.anims[this.animState];
    const originY = cfg.originY ?? this.def.display.originY;
    this.sprite.setOrigin(0.5, originY);
    this.sprite.anims.play(enemyAnimKey(this.def.id, this.animState), true);
  }

  destroy() {
    this.sprite.destroy();
    this.hpBar.destroy();
    this.hpBarBg.destroy();
  }
}

export function registerEnemyAnimations(scene: Phaser.Scene, def: EnemyDef) {
  const states: EnemyAnimState[] = ["idle", "move", "attack", "death"];
  for (const state of states) {
    const key = enemyAnimKey(def.id, state);
    if (scene.anims.exists(key)) scene.anims.remove(key);
    const cfg = def.sprite.anims[state];
    // Anims with a `sheet` override live on their own texture, with their
    // own grid dimensions. Everything else uses the base sheet.
    const textureKey = cfg.sheet
      ? enemyAnimTextureKey(def.id, state)
      : enemyTextureKey(def.id);
    const cols = cfg.sheet ? (cfg.sheetCols ?? def.sprite.sheetCols) : def.sprite.sheetCols;
    const start = cfg.row * cols;
    const end = start + cfg.frames - 1;
    const repeat = cfg.repeat ?? (state === "idle" || state === "move" ? -1 : 0);
    scene.anims.create({
      key,
      frames: scene.anims.generateFrameNumbers(textureKey, { start, end }),
      frameRate: cfg.frameRate,
      repeat,
    });
  }
}
