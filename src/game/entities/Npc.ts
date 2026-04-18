import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import {
  npcAnimKey,
  npcTextureKey,
  type NpcDef,
  type NpcFacing,
} from "./npcTypes";

export const NPC_INTERACT_RADIUS = TILE_SIZE * 1.0;

type State = "idle" | "walk";
type Phase = "pausing" | "moving";

export class Npc {
  readonly def: NpcDef;
  readonly sprite: Phaser.GameObjects.Sprite;

  private facing: NpcFacing;
  private animState: State = "idle";

  private phase: Phase = "pausing";
  private phaseTimer = 0;
  private targetPx: { x: number; y: number } | null = null;
  private patrolIdx = 0;
  private readonly homePx: { x: number; y: number };

  constructor(scene: Phaser.Scene, def: NpcDef) {
    this.def = def;
    this.facing = def.facing;
    const x = (def.spawn.tileX + 0.5) * TILE_SIZE;
    const y = (def.spawn.tileY + 0.5) * TILE_SIZE;
    this.homePx = { x, y };

    this.sprite = scene.add.sprite(x, y, npcTextureKey(def.id, "idle"), def.sprite.idle.start);
    this.sprite.setScale(def.display.scale);
    this.sprite.setOrigin(0.5, def.display.originY);
    this.sprite.setDepth(this.sortY());
    this.applyAnim();

    // Randomize initial pause so NPCs don't tick in lockstep.
    this.phaseTimer = Math.random() * 1000;
  }

  get x(): number {
    return this.sprite.x;
  }
  get y(): number {
    return this.sprite.y;
  }

  /** Y-value used for depth sorting — the sprite's visible bottom edge (feet). */
  sortY(): number {
    const { display, sprite } = this.def;
    return this.sprite.y + (1 - display.originY) * sprite.idle.frameHeight * display.scale;
  }

  setFacing(f: NpcFacing) {
    if (f === this.facing) return;
    this.facing = f;
    this.sprite.setFlipX(f === "left");
  }

  faceToward(px: number, _py: number) {
    const dx = px - this.sprite.x;
    if (Math.abs(dx) < 1) return;
    this.setFacing(dx < 0 ? "left" : "right");
  }

  update(dtMs: number, isWalkablePx: (x: number, y: number) => boolean) {
    const move = this.def.movement;
    if (move.type === "static") return;

    this.phaseTimer -= dtMs;

    if (this.phase === "pausing") {
      if (this.phaseTimer > 0) return;
      // Pick next target.
      if (move.type === "wander") {
        const maxDist = move.radiusTiles * TILE_SIZE;
        const angle = Math.random() * Math.PI * 2;
        const dist = maxDist * (0.3 + Math.random() * 0.7);
        const tx = this.homePx.x + Math.cos(angle) * dist;
        const ty = this.homePx.y + Math.sin(angle) * dist;
        this.targetPx = { x: tx, y: ty };
        this.phaseTimer = move.stepMs;
      } else {
        // patrol
        this.patrolIdx = (this.patrolIdx + 1) % move.waypoints.length;
        const wp = move.waypoints[this.patrolIdx];
        this.targetPx = {
          x: (wp.tileX + 0.5) * TILE_SIZE,
          y: (wp.tileY + 0.5) * TILE_SIZE,
        };
        this.phaseTimer = 10000; // safety timeout on a single leg
      }
      this.phase = "moving";
      return;
    }

    // moving
    if (!this.targetPx) {
      this.enterPause(move.pauseMs);
      return;
    }

    const dt = dtMs / 1000;
    const speed = move.moveSpeed;
    const dx = this.targetPx.x - this.sprite.x;
    const dy = this.targetPx.y - this.sprite.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 2 || this.phaseTimer <= 0) {
      this.enterPause(move.pauseMs);
      return;
    }

    const step = Math.min(dist, speed * dt);
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

    if (!moved) {
      // Blocked — bounce back to pause.
      this.enterPause(move.pauseMs);
      return;
    }

    if (Math.abs(dx) > 1) this.setFacing(dx < 0 ? "left" : "right");
    this.setAnimState(this.def.sprite.walk ? "walk" : "idle");
    this.sprite.setDepth(this.sortY());
  }

  private enterPause(ms: number) {
    this.phase = "pausing";
    this.phaseTimer = ms;
    this.targetPx = null;
    this.setAnimState("idle");
  }

  private setAnimState(state: State) {
    const hasWalk = !!this.def.sprite.walk;
    const resolved = state === "walk" && !hasWalk ? "idle" : state;
    if (this.animState === resolved && this.sprite.anims.isPlaying) return;
    this.animState = resolved;
    this.applyAnim();
  }

  private applyAnim() {
    this.sprite.setFlipX(this.facing === "left");
    this.sprite.anims.play(npcAnimKey(this.def.id, this.animState), true);
  }
}

export function registerNpcAnimations(scene: Phaser.Scene, def: NpcDef) {
  const states: Array<"idle" | "walk"> = def.sprite.walk ? ["idle", "walk"] : ["idle"];
  for (const state of states) {
    const key = npcAnimKey(def.id, state);
    if (scene.anims.exists(key)) scene.anims.remove(key);
    const cfg = state === "walk" ? def.sprite.walk! : def.sprite.idle;
    scene.anims.create({
      key,
      frames: scene.anims.generateFrameNumbers(npcTextureKey(def.id, state), {
        start: cfg.start,
        end: cfg.end,
      }),
      frameRate: cfg.frameRate,
      repeat: -1,
    });
  }
}
