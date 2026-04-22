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
import {
  LayeredEnemyView,
  SingleSpriteEnemyView,
  type EnemyView,
} from "./enemyView";
import {
  charModelManifestKey,
  type CharacterModelManifest,
} from "./npcTypes";
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
  /** Rendering handle — single sprite for legacy enemies, layered container
   *  for humanoid character-model enemies. Enemy logic reads position and
   *  issues paint ops via this interface rather than touching a specific
   *  Phaser object type. */
  readonly view: EnemyView;
  /** Reference frame dimensions for hit-rect math. Legacy enemies pull from
   *  `def.sprite`; layered enemies pull from their model manifest. Cached at
   *  construction so every hit test doesn't redo the lookup. */
  /** Reference frame dimensions — kept public so the map editor and
   *  on-hit floating-number spawners can position UI above the character
   *  without caring whether it's a single sprite or a layered model. */
  readonly frameWidth: number;
  readonly frameHeight: number;

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

    // Pick the rendering backend: layered for character-model enemies, legacy
    // single-sprite otherwise. Layered falls back to single-sprite if the
    // model manifest didn't load (bad data) and the def still has a `sprite`
    // block — keeps a partially-broken enemy visible rather than invisible.
    if (def.layered) {
      const manifest = scene.cache.json.get(charModelManifestKey(def.layered.model)) as
        | CharacterModelManifest
        | undefined;
      if (manifest) {
        this.view = new LayeredEnemyView(scene, def, def.layered, manifest, x, y);
        this.frameWidth = manifest.frameWidth;
        this.frameHeight = manifest.frameHeight;
      } else if (def.sprite) {
        this.view = new SingleSpriteEnemyView(scene, def, x, y);
        this.frameWidth = def.sprite.frameWidth;
        this.frameHeight = def.sprite.frameHeight;
      } else {
        throw new Error(
          `Enemy "${def.id}" is layered but model "${def.layered.model}" didn't load and no fallback sprite is defined.`,
        );
      }
    } else {
      if (!def.sprite) throw new Error(`Enemy "${def.id}" has neither "sprite" nor "layered".`);
      this.view = new SingleSpriteEnemyView(scene, def, x, y);
      this.frameWidth = def.sprite.frameWidth;
      this.frameHeight = def.sprite.frameHeight;
    }
    this.view.setDepth(this.sortY());

    const barW = Math.max(18, this.frameWidth * def.display.scale * 0.9);
    const barY = -this.frameHeight * def.display.scale * def.display.originY - 4;
    this.hpBarBg = scene.add.rectangle(x, y + barY, barW, 3, 0x000000, 0.6).setOrigin(0.5, 1);
    this.hpBar = scene.add.rectangle(x - barW / 2, y + barY, barW, 3, 0xcc4444).setOrigin(0, 1);
    this.hpBarBg.setVisible(false);
    this.hpBar.setVisible(false);
    this.hpBarBg.setDepth(this.sortY());
    this.hpBar.setDepth(this.sortY());

    this.stateTimer = Math.random() * 1500;
    this.applyAnim();
  }

  get x(): number { return this.view.x; }
  get y(): number { return this.view.y; }

  /** External movers (map editor, cutscenes) use this to re-home an enemy
   *  without touching the view directly. Also fixes up y-sort depth so the
   *  sprite renders above/below props correctly at the new location. */
  setPositionPx(x: number, y: number): void {
    this.view.setPosition(x, y);
    this.view.setDepth(this.sortY());
  }

  isAlive(): boolean { return this.state !== "dying" && this.state !== "dead"; }

  sortY(): number {
    const { display } = this.def;
    return this.view.y + (1 - display.originY) * this.frameHeight * display.scale;
  }

  /** Pixel-rect blocking footprint for living enemies. */
  blocksPx(px: number, py: number): boolean {
    if (!this.isAlive()) return false;
    const w = this.frameWidth * this.def.display.scale * 0.45;
    const h = this.frameHeight * this.def.display.scale * 0.35;
    const cy = this.view.y - 2;
    return (
      px >= this.view.x - w / 2 &&
      px <= this.view.x + w / 2 &&
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
    const w = this.frameWidth * this.def.display.scale * 0.75;
    const h = this.frameHeight * this.def.display.scale * 0.7;
    const cy = this.view.y - this.frameHeight * this.def.display.scale * 0.25;
    return (
      px >= this.view.x - w / 2 &&
      px <= this.view.x + w / 2 &&
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
    this.view.clearTint();
    this.hpBar.setVisible(false);
    this.hpBarBg.setVisible(false);
    this.setAnimState("death");
    this.view.onceAnimComplete(() => {
      this.state = "dead";
      this.view.setVisible(false);
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

    const distToPlayer = Math.hypot(player.x - this.view.x, player.y - this.view.y);
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
    const dx = this.homePx.x - this.view.x;
    const dy = this.homePx.y - this.view.y;
    if (Math.hypot(dx, dy) < 2) {
      // Snap home, reset to idle.
      this.view.setPosition(this.homePx.x, this.homePx.y);
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
      const dx = this.view.x - attackerX;
      const dy = this.view.y - attackerY;
      const len = Math.hypot(dx, dy) || 1;
      this.kbVx = (dx / len) * HURT_KNOCKBACK_SPEED;
      this.kbVy = (dy / len) * HURT_KNOCKBACK_SPEED;
      this.setFacing(dx < 0 ? "right" : "left");
    } else {
      this.kbVx = 0;
      this.kbVy = 0;
    }
    this.view.setTint(HURT_TINT);
    // Play the dedicated hurt anim if one exists for this enemy (the
    // layered model always has one — it ships every tag; legacy defs flag
    // via `def.sprite.anims.hurt`). Fall back to idle + red tint otherwise.
    const hasHurt = this.def.layered !== undefined
      ? true
      : this.def.sprite?.anims.hurt !== undefined;
    this.setAnimState(hasHurt ? "hurt" : "idle");
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
      const nx = this.view.x + this.kbVx * avgFrac * dt;
      const ny = this.view.y + this.kbVy * avgFrac * dt;
      if (isWalkablePx(nx, this.view.y)) this.view.x = nx;
      if (isWalkablePx(this.view.x, ny)) this.view.y = ny;
      this.syncOverlayPositions();
      this.view.setDepth(this.sortY());
    }

    if (this.hurtTimer <= 0) {
      this.view.clearTint();
      if (this.def.combat) this.enterChase();
      else this.enterIdle(400);
    }
  }

  private shouldAggro(player: PlayerRef | undefined): boolean {
    const combat = this.def.combat;
    if (!combat || !player) return false;
    if (this.forceAggro) return true;
    const d = Math.hypot(player.x - this.view.x, player.y - this.view.y);
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

    const dx = this.targetPx.x - this.view.x;
    const dy = this.targetPx.y - this.view.y;
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
    const dx = tx - this.view.x;
    const dy = ty - this.view.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return false;
    const step = Math.min(dist, speedPx * (dtMs / 1000));
    const nx = this.view.x + (dx / dist) * step;
    const ny = this.view.y + (dy / dist) * step;

    let moved = false;
    if (isWalkablePx(nx, this.view.y)) {
      this.view.x = nx;
      moved = true;
    }
    if (isWalkablePx(this.view.x, ny)) {
      this.view.y = ny;
      moved = true;
    }
    if (!moved) return false;

    if (Math.abs(dx) > 1) this.setFacing(dx < 0 ? "left" : "right");
    this.setAnimState("move");
    this.syncOverlayPositions();
    this.view.setDepth(this.sortY());
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
    this.setFacing(player.x < this.view.x ? "left" : "right");
    this.setAnimState("attack");
    this.view.onceAnimComplete(() => {
      if (!this.isAlive()) return;
      // The attack was interrupted (e.g. we took a hit) — don't land damage or override the new state.
      if (this.state !== "attack") return;
      // Recheck range on landing — a dodging player avoids damage.
      const d = Math.hypot(player.x - this.view.x, player.y - this.view.y);
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
    this.view.clearTint();
    this.view.setPosition(this.homePx.x, this.homePx.y);
    this.view.setAlpha(1);
    this.view.setVisible(true);
    this.view.setDepth(this.sortY());
    this.stateTimer = 500 + Math.random() * 1000;
    this.wanderMoving = false;
    this.updateHpBar();
    this.setAnimState("idle");
  }

  private syncOverlayPositions() {
    const barY =
      this.view.y -
      this.frameHeight * this.def.display.scale * this.def.display.originY -
      4;
    this.hpBarBg.setPosition(this.view.x, barY);
    this.hpBar.setPosition(this.view.x - this.hpBarBg.width / 2, barY);
    this.hpBarBg.setDepth(this.sortY());
    this.hpBar.setDepth(this.sortY());
  }

  private setFacing(f: Facing) {
    if (f === this.facing) return;
    this.facing = f;
    this.view.setFlipX(f === "left");
  }

  private setAnimState(state: EnemyAnimState) {
    if (this.animState === state && this.view.isAnimPlaying()) return;
    this.animState = state;
    this.applyAnim();
  }

  private applyAnim() {
    this.view.setFlipX(this.facing === "left");
    // Per-anim origin override (single-sprite enemies) and the actual anim
    // play both happen inside the view. Layered enemies don't have per-anim
    // origin overrides — the model's shared bbox already aligns every slot.
    this.view.playState(this.animState);
  }

  destroy() {
    this.view.destroy();
    this.hpBar.destroy();
    this.hpBarBg.destroy();
  }
}

export function registerEnemyAnimations(scene: Phaser.Scene, def: EnemyDef) {
  // Layered enemies register their anims via setupCharacterAnims() in
  // manifest.ts — bail early so we don't touch `def.sprite` when absent.
  if (!def.sprite) return;
  const sheet = def.sprite;
  const states: EnemyAnimState[] = ["idle", "move", "attack", "death", "hurt"];
  for (const state of states) {
    const cfg = sheet.anims[state];
    if (!cfg) continue;
    const key = enemyAnimKey(def.id, state);
    if (scene.anims.exists(key)) scene.anims.remove(key);
    // Anims with a `sheet` override live on their own texture, with their
    // own grid dimensions. Everything else uses the base sheet.
    const textureKey = cfg.sheet
      ? enemyAnimTextureKey(def.id, state)
      : enemyTextureKey(def.id);
    const cols = cfg.sheet ? (cfg.sheetCols ?? sheet.sheetCols) : sheet.sheetCols;
    // Column-major sheets (e.g. Hana Caraka pirate: cols are facings,
    // rows are anim frames) pick frames by stepping down a single column.
    // Otherwise the anim is a contiguous run across `row`.
    const frameNumbers: Phaser.Types.Animations.GenerateFrameNumbers =
      cfg.col !== undefined
        ? {
            frames: Array.from(
              { length: cfg.frames },
              (_, i) => (cfg.row + i) * cols + cfg.col!,
            ),
          }
        : { start: cfg.row * cols, end: cfg.row * cols + cfg.frames - 1 };
    const repeat = cfg.repeat ?? (state === "idle" || state === "move" ? -1 : 0);
    scene.anims.create({
      key,
      frames: scene.anims.generateFrameNumbers(textureKey, frameNumbers),
      frameRate: cfg.frameRate,
      repeat,
    });
  }
}
