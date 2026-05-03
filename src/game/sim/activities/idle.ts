import { TILE_SIZE } from "../../constants";
import { BaseActivity } from "./activity";
import type { Activity, ActivityCtx } from "./activity";
import type { BodyHandle } from "../bodyHandle";
import type { Facing, WorldLocation } from "../location";
import type { NpcAgent } from "../npcAgent";

export interface IdleConfig {
  /** Tile the agent loiters around. Live mode paces within `paceRadiusTiles`
   *  of this point; abstract mode just decrements duration with the agent
   *  parked here. */
  readonly area: WorldLocation;
  /** How long the activity lasts before completing, in sim-minutes. */
  readonly durationMinutes: number;
  /** 0 → stand perfectly still and only swap facings. > 0 → permits short
   *  pacing hops within this radius. Default 1. */
  readonly paceRadiusTiles: number;
  /** Pixels per second when pacing in live mode. */
  readonly moveSpeed: number;
  /** ms between live pose changes (facing swap, occasional pace). */
  readonly pauseMs: number;
}

type LivePhase = "pausing" | "moving";

interface IdleRuntime {
  remainingMinutes: number;
  livePhase: LivePhase;
  livePhaseTimer: number;
  liveTargetPx: { x: number; y: number } | null;
}

interface IdleSerialized {
  config: IdleConfig;
  runtime: Pick<IdleRuntime, "remainingMinutes">;
}

const CLAIMANT = { name: "Idle" };
const FACINGS: readonly Facing[] = ["up", "down", "left", "right"];

function areaPx(area: WorldLocation): { x: number; y: number } {
  return {
    x: (area.tileX + 0.5) * TILE_SIZE,
    y: (area.tileY + 0.5) * TILE_SIZE,
  };
}

function deriveFacing(dx: number, dy: number, fallback: Facing): Facing {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return fallback;
  if (Math.abs(dy) > Math.abs(dx)) return dy < 0 ? "up" : "down";
  return dx < 0 ? "left" : "right";
}

/** Stand around. Live mode paces within a small radius and swaps facings so
 *  the NPC doesn't read as catatonic; abstract mode is just a duration
 *  countdown. Picked when a tourist is killing time at the docks before they
 *  depart, or anywhere else a "wait here for a few minutes" beat fits.
 *
 *  Distinct from `WanderActivity` in two ways: (a) bounded by a duration
 *  rather than looping forever, and (b) tighter movement radius (1–2 tiles
 *  by default) so it reads as "loitering" rather than "exploring." */
export class IdleActivity extends BaseActivity {
  readonly kind = "idle";

  private handle: BodyHandle | null = null;

  constructor(public readonly config: IdleConfig, private runtime: IdleRuntime) {
    super();
  }

  static create(
    config: Pick<IdleConfig, "area" | "durationMinutes"> &
      Partial<Pick<IdleConfig, "paceRadiusTiles" | "moveSpeed" | "pauseMs">>,
  ): IdleActivity {
    return new IdleActivity(
      {
        area: { ...config.area },
        durationMinutes: Math.max(0, config.durationMinutes),
        paceRadiusTiles: Math.max(0, config.paceRadiusTiles ?? 1),
        moveSpeed: config.moveSpeed ?? 24,
        pauseMs: config.pauseMs ?? 1500,
      },
      {
        remainingMinutes: Math.max(0, config.durationMinutes),
        livePhase: "pausing",
        livePhaseTimer: Math.random() * 800,
        liveTargetPx: null,
      },
    );
  }

  isComplete(): boolean { return this.runtime.remainingMinutes <= 0; }

  override enter(npc: NpcAgent, ctx: ActivityCtx): void {
    if (ctx.live && !this.handle) this.handle = ctx.claimBody(npc, CLAIMANT);
  }

  override exit(_npc: NpcAgent, _ctx: ActivityCtx): void {
    if (this.handle) { this.handle.release(); this.handle = null; }
  }

  override tickAbstract(_npc: NpcAgent, _ctx: ActivityCtx, simMinutes: number): void {
    if (simMinutes <= 0) return;
    this.runtime.remainingMinutes = Math.max(0, this.runtime.remainingMinutes - simMinutes);
  }

  override tickLive(npc: NpcAgent, ctx: ActivityCtx, dtMs: number): void {
    if (!this.handle) this.handle = ctx.claimBody(npc, CLAIMANT);
    const handle = this.handle;
    const r = this.runtime;

    // Duration is drained by the registry's abstract tick (fires every
    // in-game hour for every agent regardless of scene). Live tick is
    // purely cosmetic — pacing/facing changes — and exits when the abstract
    // counter hits zero.
    if (r.remainingMinutes <= 0) { handle.setAnim("idle"); return; }

    r.livePhaseTimer -= dtMs;
    const walkable = ctx.live?.walkable;

    if (r.livePhase === "pausing") {
      if (r.livePhaseTimer > 0) { handle.setAnim("idle"); return; }
      // On pause expiry, ~50% chance pick a new pacing target (when radius
      // > 0); otherwise just swap facing. Keeps the NPC alive without making
      // them wander around.
      if (this.config.paceRadiusTiles > 0 && walkable && Math.random() < 0.5) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.max(4, this.config.paceRadiusTiles * TILE_SIZE * Math.random());
        const home = areaPx(this.config.area);
        r.liveTargetPx = {
          x: home.x + Math.cos(angle) * dist,
          y: home.y + Math.sin(angle) * dist,
        };
        r.livePhase = "moving";
        r.livePhaseTimer = 1500;
      } else {
        const f = FACINGS[Math.floor(Math.random() * FACINGS.length)];
        handle.setFacing(f);
        handle.setAnim("idle");
        r.livePhaseTimer = this.config.pauseMs;
      }
      return;
    }

    if (!r.liveTargetPx) { this.enterPause(handle); return; }
    const dt = dtMs / 1000;
    const dx = r.liveTargetPx.x - npc.body.px;
    const dy = r.liveTargetPx.y - npc.body.py;
    const dist = Math.hypot(dx, dy);
    if (dist < 2 || r.livePhaseTimer <= 0) { this.enterPause(handle); return; }
    const step = Math.min(dist, this.config.moveSpeed * dt);
    const nx = npc.body.px + (dx / dist) * step;
    const ny = npc.body.py + (dy / dist) * step;
    let px = npc.body.px;
    let py = npc.body.py;
    let moved = false;
    if (!walkable || walkable(nx, py)) { px = nx; moved = true; }
    if (!walkable || walkable(px, ny)) { py = ny; moved = true; }
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
    this.runtime.livePhase = "pausing";
    this.runtime.livePhaseTimer = 0;
    this.runtime.liveTargetPx = null;
  }

  dematerialize(npc: NpcAgent, _ctx: ActivityCtx): void {
    const tileX = Math.floor(npc.body.px / TILE_SIZE);
    const tileY = Math.floor(npc.body.py / TILE_SIZE);
    npc.location = { sceneKey: npc.location.sceneKey, tileX, tileY, facing: npc.body.facing };
    if (this.handle) { this.handle.release(); this.handle = null; }
  }

  serialize(): IdleSerialized {
    return {
      config: { ...this.config, area: { ...this.config.area } },
      runtime: { remainingMinutes: this.runtime.remainingMinutes },
    };
  }

  private enterPause(handle: BodyHandle): void {
    this.runtime.livePhase = "pausing";
    this.runtime.livePhaseTimer = this.config.pauseMs;
    this.runtime.liveTargetPx = null;
    handle.setAnim("idle");
  }
}

export function deserializeIdle(data: unknown): Activity {
  const s = data as Partial<IdleSerialized>;
  if (!s.config) throw new Error("deserializeIdle: missing config");
  const remaining = Math.max(0, Math.floor(s.runtime?.remainingMinutes ?? s.config.durationMinutes ?? 0));
  return new IdleActivity(
    { ...s.config, area: { ...s.config.area } },
    {
      remainingMinutes: remaining,
      livePhase: "pausing",
      livePhaseTimer: 0,
      liveTargetPx: null,
    },
  );
}
