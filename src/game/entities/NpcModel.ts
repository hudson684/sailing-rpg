import { TILE_SIZE } from "../constants";
import type { MapId } from "./mapId";
import type { EntityModel } from "./registry";
import type { NpcDef, NpcFacing } from "./npcTypes";

export type NpcAnimState = "idle" | "walk";
type Phase = "pausing" | "moving";

export type WalkableProbe = (px: number, py: number) => boolean;

/** Pure-data NPC. Holds position, facing, animation state, and movement
 *  phase. Its `tick` mutates model state only — no Phaser calls. Sprites
 *  read from this each frame. */
export class NpcModel implements EntityModel {
  readonly id: string;
  readonly kind = "npc" as const;
  mapId: MapId;
  x: number;
  y: number;

  def: NpcDef;
  facing: NpcFacing;
  animState: NpcAnimState = "idle";
  /** When true, autonomous movement (`tick`) is suppressed so a cutscene
   *  director can drive position/facing/anim without the AI fighting it. */
  scripted = false;

  private phase: Phase = "pausing";
  private phaseTimer = 0;
  private targetPx: { x: number; y: number } | null = null;
  private patrolIdx = 0;
  private readonly homePx: { x: number; y: number };

  constructor(def: NpcDef, mapId: MapId) {
    this.id = `npc:${def.id}`;
    this.def = def;
    this.mapId = mapId;
    this.facing = def.facing;
    this.x = (def.spawn.tileX + 0.5) * TILE_SIZE;
    this.y = (def.spawn.tileY + 0.5) * TILE_SIZE;
    this.homePx = { x: this.x, y: this.y };
    // Randomize initial pause so NPCs don't tick in lockstep.
    this.phaseTimer = Math.random() * 1000;
  }

  setFacing(f: NpcFacing) {
    this.facing = f;
  }

  faceToward(px: number, _py: number) {
    const dx = px - this.x;
    if (Math.abs(dx) < 1) return;
    this.facing = dx < 0 ? "left" : "right";
  }

  setPositionPx(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  tick(dtMs: number, isWalkablePx: WalkableProbe) {
    if (this.scripted) return;
    const move = this.def.movement;
    if (move.type === "static") return;

    this.phaseTimer -= dtMs;

    if (this.phase === "pausing") {
      if (this.phaseTimer > 0) return;
      if (move.type === "wander") {
        const maxDist = move.radiusTiles * TILE_SIZE;
        const angle = Math.random() * Math.PI * 2;
        const dist = maxDist * (0.3 + Math.random() * 0.7);
        this.targetPx = {
          x: this.homePx.x + Math.cos(angle) * dist,
          y: this.homePx.y + Math.sin(angle) * dist,
        };
        this.phaseTimer = move.stepMs;
      } else {
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

    if (!this.targetPx) {
      this.enterPause(move.pauseMs);
      return;
    }

    const dt = dtMs / 1000;
    const speed = move.moveSpeed;
    const dx = this.targetPx.x - this.x;
    const dy = this.targetPx.y - this.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 2 || this.phaseTimer <= 0) {
      this.enterPause(move.pauseMs);
      return;
    }

    const step = Math.min(dist, speed * dt);
    const nx = this.x + (dx / dist) * step;
    const ny = this.y + (dy / dist) * step;

    let moved = false;
    if (isWalkablePx(nx, this.y)) {
      this.x = nx;
      moved = true;
    }
    if (isWalkablePx(this.x, ny)) {
      this.y = ny;
      moved = true;
    }

    if (!moved) {
      this.enterPause(move.pauseMs);
      return;
    }

    if (Math.abs(dx) > 1) this.facing = dx < 0 ? "left" : "right";
    // Layered NPCs always have a walk animation if the model ships one;
    // legacy NPCs only have one when their sprite.walk sheet is present.
    const hasWalk = this.def.layered !== undefined || this.def.sprite?.walk !== undefined;
    this.animState = hasWalk ? "walk" : "idle";
  }

  private enterPause(ms: number) {
    this.phase = "pausing";
    this.phaseTimer = ms;
    this.targetPx = null;
    this.animState = "idle";
  }
}
