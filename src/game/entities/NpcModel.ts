import { TILE_SIZE } from "../constants";
import type { MapId } from "./mapId";
import type { EntityModel } from "./registry";
import type { NpcDef, NpcFacing } from "./npcTypes";

export type NpcAnimState = "idle" | "walk";
type Phase = "pausing" | "moving";

export type WalkableProbe = (px: number, py: number) => boolean;

/** Pure-data NPC. Holds position, facing, animation state, and (legacy)
 *  movement phase. With Phase 3, every authored wander/patrol NPC also has
 *  a sim-layer `NpcAgent` that drives motion through the SceneNpcBinder;
 *  `WorldTicker.tick` is gated on agent presence so it only runs the
 *  legacy AI for NPCs that *don't* have an agent yet (customerSim-spawned
 *  customers today; Phase 5 migrates those too). */
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
   *  director or customerSim/staffService can drive position/facing/anim
   *  without the AI fighting it. The SceneNpcBinder also reads this and
   *  skips the activity tick for an agent whose model is scripted. */
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

  faceToward(px: number, py: number) {
    const dx = px - this.x;
    const dy = py - this.y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    if (Math.abs(dy) > Math.abs(dx)) {
      this.facing = dy < 0 ? "up" : "down";
    } else {
      this.facing = dx < 0 ? "left" : "right";
    }
  }

  setPositionPx(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  /** Snap back to the spawn position the model was constructed with and reset
   *  the movement state machine. Used by edit mode to make WYSIWYG editing
   *  possible while NPCs would otherwise be wandering. */
  returnHome() {
    this.x = this.homePx.x;
    this.y = this.homePx.y;
    this.facing = this.def.facing;
    this.animState = "idle";
    this.phase = "pausing";
    this.phaseTimer = 0;
    this.targetPx = null;
    this.patrolIdx = 0;
  }

  /** Recompute homePx from the current def.spawn. Call after editing
   *  def.spawn so future returnHome() goes to the new spawn. */
  rebindHome() {
    this.homePx.x = (this.def.spawn.tileX + 0.5) * TILE_SIZE;
    this.homePx.y = (this.def.spawn.tileY + 0.5) * TILE_SIZE;
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

    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      if (Math.abs(dy) > Math.abs(dx)) {
        this.facing = dy < 0 ? "up" : "down";
      } else {
        this.facing = dx < 0 ? "left" : "right";
      }
    }
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
