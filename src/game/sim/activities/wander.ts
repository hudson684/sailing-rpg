import { TILE_SIZE } from "../../constants";
import { BaseActivity } from "./activity";
import type { Activity, ActivityCtx } from "./activity";
import type { BodyHandle } from "../bodyHandle";
import type { Facing, WorldLocation } from "../location";
import type { NpcAgent } from "../npcAgent";

export interface WanderConfig {
  /** Anchor location — wander samples target tiles within `radiusTiles`
   *  of this point, in pixel space. */
  readonly home: WorldLocation;
  readonly radiusTiles: number;
  /** Pixels per second while moving. */
  readonly moveSpeed: number;
  /** ms to pause between hops. */
  readonly pauseMs: number;
  /** Safety timeout per moving leg (ms). Matches the legacy NpcModel
   *  behavior of capping a single hop so a stuck NPC re-rolls instead of
   *  jittering against a wall forever. */
  readonly stepMs: number;
  /** Optional sim-minute duration. When set, the activity completes after
   *  the abstract clock has drained that many minutes; when omitted, the
   *  activity loops forever (legacy behavior used by authored townsfolk). */
  readonly durationMinutes?: number;
}

type Phase = "pausing" | "moving";

interface WanderRuntime {
  phase: Phase;
  phaseTimer: number;
  targetPx: { x: number; y: number } | null;
  /** Minutes of duration left when `durationMinutes` is configured. Ignored
   *  for the open-ended wander used by townsfolk. */
  remainingMinutes: number | null;
}

interface WanderSerialized {
  config: WanderConfig;
  runtime: WanderRuntime;
}

const CLAIMANT = { name: "Wander" };

function homePx(home: WorldLocation): { x: number; y: number } {
  return {
    x: (home.tileX + 0.5) * TILE_SIZE,
    y: (home.tileY + 0.5) * TILE_SIZE,
  };
}

function deriveFacing(dx: number, dy: number, fallback: Facing): Facing {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return fallback;
  if (Math.abs(dy) > Math.abs(dx)) return dy < 0 ? "up" : "down";
  return dx < 0 ? "left" : "right";
}

/** Wander aimlessly within `radiusTiles` of `home`. Live mode replicates the
 *  legacy `NpcModel` behavior tile-for-tile (axis-projected wall slide, pause
 *  between hops, randomized initial pause to avoid lockstep). Abstract mode
 *  cheaply nudges the agent's tile within radius once per minute, so an NPC
 *  in an unloaded scene drifts a believable amount. Loops forever — Phase 6
 *  scheduling will replace looped wander with a planned day. */
export class WanderActivity extends BaseActivity {
  readonly kind = "wander";

  private handle: BodyHandle | null = null;

  constructor(public readonly config: WanderConfig, private runtime: WanderRuntime) {
    super();
  }

  static create(config: WanderConfig): WanderActivity {
    return new WanderActivity(config, {
      phase: "pausing",
      // Randomized initial pause so a batch of NPCs doesn't tick in lockstep.
      phaseTimer: Math.random() * 1000,
      targetPx: null,
      remainingMinutes:
        config.durationMinutes != null ? Math.max(0, config.durationMinutes) : null,
    });
  }

  override enter(npc: NpcAgent, ctx: ActivityCtx): void {
    if (ctx.live && !this.handle) {
      this.handle = ctx.claimBody(npc, CLAIMANT);
    }
  }

  override exit(_npc: NpcAgent, _ctx: ActivityCtx): void {
    if (this.handle) {
      this.handle.release();
      this.handle = null;
    }
  }

  isComplete(): boolean {
    return this.runtime.remainingMinutes != null && this.runtime.remainingMinutes <= 0;
  }

  override tickAbstract(npc: NpcAgent, ctx: ActivityCtx, simMinutes: number): void {
    if (simMinutes <= 0) return;
    if (this.runtime.remainingMinutes != null) {
      this.runtime.remainingMinutes = Math.max(0, this.runtime.remainingMinutes - simMinutes);
    }
    // Live-scene drain: per-frame `tickLive` owns the body. Skip the
    // abstract nudges so we don't warp the wandering NPC out from under
    // the visible walk. The duration timer above still counts down.
    if (ctx.live) return;
    // One nudge per sim-minute, capped — abstract movement is impressionistic,
    // not a step-by-step simulation. Nudges respect the radius bound; the
    // real walkability check happens on materialize / live tick.
    const nudges = Math.min(8, Math.max(1, Math.floor(simMinutes / 30) + 1));
    let { tileX, tileY, facing } = npc.location;
    const home = this.config.home;
    for (let i = 0; i < nudges; i++) {
      const dx = (Math.random() < 0.5 ? -1 : 1);
      const dy = (Math.random() < 0.5 ? -1 : 1);
      const candX = tileX + dx;
      const candY = tileY + dy;
      const distSq = (candX - home.tileX) ** 2 + (candY - home.tileY) ** 2;
      if (distSq <= this.config.radiusTiles * this.config.radiusTiles) {
        tileX = candX; tileY = candY;
      }
    }
    if (tileX !== npc.location.tileX || tileY !== npc.location.tileY) {
      npc.location = { sceneKey: home.sceneKey, tileX, tileY, facing };
      // Mirror onto body for materialize convenience — body is read-only on
      // the public surface, but the registry only treats it as canonical in
      // live mode. Abstract nudges do not need a BodyHandle (no live driver
      // is competing for writes when the scene is unloaded).
      const px = (tileX + 0.5) * TILE_SIZE;
      const py = (tileY + 0.5) * TILE_SIZE;
      (npc as { body: NpcAgent["body"] }).body = { ...npc.body, px, py };
    }
  }

  override tickLive(npc: NpcAgent, ctx: ActivityCtx, dtMs: number): void {
    if (!this.handle) {
      this.handle = ctx.claimBody(npc, CLAIMANT);
    }
    const handle = this.handle;
    const walkable = ctx.live?.walkable;
    if (!walkable) return;

    const move = this.config;
    const r = this.runtime;
    r.phaseTimer -= dtMs;

    if (r.phase === "pausing") {
      if (r.phaseTimer > 0) { handle.setAnim("idle"); return; }
      const home = homePx(move.home);
      const angle = Math.random() * Math.PI * 2;
      const dist = move.radiusTiles * TILE_SIZE * (0.3 + Math.random() * 0.7);
      r.targetPx = {
        x: home.x + Math.cos(angle) * dist,
        y: home.y + Math.sin(angle) * dist,
      };
      r.phase = "moving";
      r.phaseTimer = move.stepMs;
      return;
    }

    if (!r.targetPx) { this.enterPause(handle); return; }

    const dt = dtMs / 1000;
    const dx = r.targetPx.x - npc.body.px;
    const dy = r.targetPx.y - npc.body.py;
    const dist = Math.hypot(dx, dy);
    if (dist < 2 || r.phaseTimer <= 0) { this.enterPause(handle); return; }

    const step = Math.min(dist, move.moveSpeed * dt);
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

    // Keep canonical tile address aligned with the live position.
    npc.location = {
      sceneKey: npc.location.sceneKey,
      tileX: Math.floor(px / TILE_SIZE),
      tileY: Math.floor(py / TILE_SIZE),
      facing: npc.body.facing,
    };
  }

  materialize(npc: NpcAgent, ctx: ActivityCtx): void {
    if (!this.handle) {
      this.handle = ctx.claimBody(npc, CLAIMANT);
    }
    // Snap presentation to the current tile; activity will resume from a
    // pause and pick a fresh hop on the next live tick.
    const cx = (npc.location.tileX + 0.5) * TILE_SIZE;
    const cy = (npc.location.tileY + 0.5) * TILE_SIZE;
    this.handle.setPosition(cx, cy);
    this.handle.setAnim("idle");
    this.runtime = {
      phase: "pausing",
      phaseTimer: 0,
      targetPx: null,
      remainingMinutes: this.runtime.remainingMinutes,
    };
  }

  dematerialize(npc: NpcAgent, _ctx: ActivityCtx): void {
    // Collapse pixel-precise position back to nearest tile.
    const tileX = Math.floor(npc.body.px / TILE_SIZE);
    const tileY = Math.floor(npc.body.py / TILE_SIZE);
    npc.location = { sceneKey: npc.location.sceneKey, tileX, tileY, facing: npc.body.facing };
    if (this.handle) { this.handle.release(); this.handle = null; }
  }

  serialize(): WanderSerialized {
    return {
      config: { ...this.config },
      runtime: {
        phase: this.runtime.phase,
        phaseTimer: this.runtime.phaseTimer,
        targetPx: this.runtime.targetPx ? { ...this.runtime.targetPx } : null,
        remainingMinutes: this.runtime.remainingMinutes,
      },
    };
  }

  private enterPause(handle: BodyHandle): void {
    this.runtime.phase = "pausing";
    this.runtime.phaseTimer = this.config.pauseMs;
    this.runtime.targetPx = null;
    handle.setAnim("idle");
  }
}

export function deserializeWander(data: unknown): Activity {
  const s = data as Partial<WanderSerialized>;
  if (!s.config) throw new Error("deserializeWander: missing config");
  const incoming = s.runtime as Partial<WanderRuntime> | undefined;
  const runtime: WanderRuntime = {
    phase: incoming?.phase ?? "pausing",
    phaseTimer: incoming?.phaseTimer ?? 0,
    targetPx: incoming?.targetPx ? { ...incoming.targetPx } : null,
    remainingMinutes:
      incoming?.remainingMinutes ??
      (s.config.durationMinutes != null ? Math.max(0, s.config.durationMinutes) : null),
  };
  return new WanderActivity(s.config, runtime);
}
