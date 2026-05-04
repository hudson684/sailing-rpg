import { TILE_SIZE } from "../../constants";
import { BaseActivity } from "./activity";
import type { Activity, ActivityCtx } from "./activity";
import type { BodyHandle } from "../bodyHandle";
import type { Facing, WorldLocation } from "../location";
import type { NpcAgent } from "../npcAgent";

export interface PatrolWaypoint {
  readonly tileX: number;
  readonly tileY: number;
}

export interface PatrolConfig {
  readonly sceneKey: WorldLocation["sceneKey"];
  readonly waypoints: readonly PatrolWaypoint[];
  readonly moveSpeed: number;
  readonly pauseMs: number;
}

type Phase = "pausing" | "moving";

interface PatrolRuntime {
  phase: Phase;
  phaseTimer: number;
  /** Index of the *current target* waypoint in `config.waypoints`. */
  waypointIndex: number;
}

interface PatrolSerialized {
  config: PatrolConfig;
  runtime: PatrolRuntime;
}

const CLAIMANT = { name: "Patrol" };
const LEG_TIMEOUT_MS = 10_000;

function deriveFacing(dx: number, dy: number, fallback: Facing): Facing {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return fallback;
  if (Math.abs(dy) > Math.abs(dx)) return dy < 0 ? "up" : "down";
  return dx < 0 ? "left" : "right";
}

/** Cycle through `waypoints` indefinitely with a `pauseMs` dwell at each.
 *  Live-mode walk is straight-line with axis-projected wall slide (matching
 *  the legacy `NpcModel.tick` path). Abstract-mode advance is a coarse
 *  per-minute teleport to the next waypoint — patrols off-screen don't earn
 *  a fine-grained simulation. */
export class PatrolActivity extends BaseActivity {
  readonly kind = "patrol";

  private handle: BodyHandle | null = null;

  constructor(public readonly config: PatrolConfig, private runtime: PatrolRuntime) {
    super();
  }

  static create(config: PatrolConfig): PatrolActivity {
    return new PatrolActivity(config, {
      phase: "pausing",
      phaseTimer: Math.random() * 1000,
      waypointIndex: 0,
    });
  }

  override enter(npc: NpcAgent, ctx: ActivityCtx): void {
    if (ctx.live && !this.handle) this.handle = ctx.claimBody(npc, CLAIMANT);
  }

  override exit(_npc: NpcAgent, _ctx: ActivityCtx): void {
    if (this.handle) { this.handle.release(); this.handle = null; }
  }

  isComplete(): boolean { return false; }

  override tickAbstract(npc: NpcAgent, ctx: ActivityCtx, simMinutes: number): void {
    if (simMinutes <= 0 || this.config.waypoints.length === 0) return;
    // Live-scene drain: per-frame `tickLive` owns body and waypoint walk.
    // Skip the abstract waypoint snap so we don't teleport the patrol
    // ahead of where the player can see it.
    if (ctx.live) return;
    // Each minute: advance one waypoint. Cheap; gives an off-screen patrol a
    // believable position when the player returns.
    let idx = this.runtime.waypointIndex;
    for (let i = 0; i < simMinutes; i++) {
      idx = (idx + 1) % this.config.waypoints.length;
    }
    this.runtime.waypointIndex = idx;
    const wp = this.config.waypoints[idx];
    npc.location = {
      sceneKey: this.config.sceneKey,
      tileX: wp.tileX,
      tileY: wp.tileY,
      facing: npc.location.facing,
    };
    const px = (wp.tileX + 0.5) * TILE_SIZE;
    const py = (wp.tileY + 0.5) * TILE_SIZE;
    (npc as { body: NpcAgent["body"] }).body = { ...npc.body, px, py };
  }

  override tickLive(npc: NpcAgent, ctx: ActivityCtx, dtMs: number): void {
    if (!this.handle) this.handle = ctx.claimBody(npc, CLAIMANT);
    const handle = this.handle;
    const walkable = ctx.live?.walkable;
    if (!walkable || this.config.waypoints.length === 0) return;

    const r = this.runtime;
    r.phaseTimer -= dtMs;

    if (r.phase === "pausing") {
      if (r.phaseTimer > 0) { handle.setAnim("idle"); return; }
      r.waypointIndex = (r.waypointIndex + 1) % this.config.waypoints.length;
      r.phase = "moving";
      r.phaseTimer = LEG_TIMEOUT_MS;
      return;
    }

    const wp = this.config.waypoints[r.waypointIndex];
    const targetPx = (wp.tileX + 0.5) * TILE_SIZE;
    const targetPy = (wp.tileY + 0.5) * TILE_SIZE;
    const dt = dtMs / 1000;
    const dx = targetPx - npc.body.px;
    const dy = targetPy - npc.body.py;
    const dist = Math.hypot(dx, dy);
    if (dist < 2 || r.phaseTimer <= 0) { this.enterPause(handle); return; }

    const step = Math.min(dist, this.config.moveSpeed * dt);
    const nx = npc.body.px + (dx / dist) * step;
    const ny = npc.body.py + (dy / dist) * step;

    let px = npc.body.px;
    let py = npc.body.py;
    let moved = false;
    if (walkable(nx, py)) { px = nx; moved = true; }
    if (walkable(px, ny)) { py = ny; moved = true; }
    if (!moved) { this.enterPause(handle); return; }

    handle.setPosition(px, py);
    handle.setFacing(deriveFacing(dx, dy, npc.body.facing));
    handle.setAnim("walk");
    npc.location = {
      sceneKey: npc.location.sceneKey,
      tileX: Math.floor(px / TILE_SIZE),
      tileY: Math.floor(py / TILE_SIZE),
      facing: npc.body.facing,
    };
  }

  materialize(npc: NpcAgent, ctx: ActivityCtx): void {
    if (!this.handle) this.handle = ctx.claimBody(npc, CLAIMANT);
    const cx = (npc.location.tileX + 0.5) * TILE_SIZE;
    const cy = (npc.location.tileY + 0.5) * TILE_SIZE;
    this.handle.setPosition(cx, cy);
    this.handle.setAnim("idle");
    this.runtime.phase = "pausing";
    this.runtime.phaseTimer = 0;
  }

  dematerialize(npc: NpcAgent, _ctx: ActivityCtx): void {
    const tileX = Math.floor(npc.body.px / TILE_SIZE);
    const tileY = Math.floor(npc.body.py / TILE_SIZE);
    npc.location = { sceneKey: npc.location.sceneKey, tileX, tileY, facing: npc.body.facing };
    if (this.handle) { this.handle.release(); this.handle = null; }
  }

  serialize(): PatrolSerialized {
    return { config: { ...this.config, waypoints: [...this.config.waypoints] }, runtime: { ...this.runtime } };
  }

  private enterPause(handle: BodyHandle): void {
    this.runtime.phase = "pausing";
    this.runtime.phaseTimer = this.config.pauseMs;
    handle.setAnim("idle");
  }
}

export function deserializePatrol(data: unknown): Activity {
  const s = data as Partial<PatrolSerialized>;
  if (!s.config) throw new Error("deserializePatrol: missing config");
  const runtime: PatrolRuntime = s.runtime ?? { phase: "pausing", phaseTimer: 0, waypointIndex: 0 };
  return new PatrolActivity(s.config, runtime);
}
