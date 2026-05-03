import { TILE_SIZE } from "../../constants";
import { BaseActivity } from "./activity";
import type {
  Activity,
  ActivityCtx,
  Pathfinder,
  PathWaypoint,
} from "./activity";
import type { BodyHandle } from "../bodyHandle";
import type { Facing, WorldLocation } from "../location";
import type { NpcAgent } from "../npcAgent";
import {
  browseWaypoints,
  browseWaypointKey,
  DEFAULT_BROWSE_GROUP_ID,
} from "../planner/browseWaypoints";

export interface BrowseConfig {
  /** Interior key or business id used to look up authored browse waypoints
   *  (`browseWaypoints` registry). The shop's interior must be loaded for
   *  live mode to find waypoints — the InteriorScene seeds them on create.
   *  Abstract mode doesn't read waypoints. */
  readonly businessId: string;
  /** Optional sub-zone id within the shop. Defaults to `"all"`. */
  readonly browseGroupId: string;
  /** How long the visit lasts in sim-minutes. Drained by the abstract tick. */
  readonly durationMinutes: number;
  /** Pixels per second when walking between waypoints in live mode. */
  readonly moveSpeed: number;
  /** ms standing at each waypoint before picking the next. */
  readonly waypointPauseMs: number;
}

type LivePhase = "pausing" | "moving";

interface BrowseRuntime {
  remainingMinutes: number;
  livePhase: LivePhase;
  livePhaseTimer: number;
  liveTargetTile: { x: number; y: number } | null;
  livePath: PathWaypoint[] | null;
  livePathIdx: number;
  livePathAgeMs: number;
  /** Index of the last waypoint visited (or -1) so we don't immediately
   *  re-pick the same one when the list is short. */
  lastWaypointIdx: number;
}

interface BrowseSerialized {
  config: BrowseConfig;
  runtime: Pick<BrowseRuntime, "remainingMinutes">;
}

const CLAIMANT = { name: "Browse" };
const WAYPOINT_REACH_PX = 1.5;
const PATH_MAX_AGE_MS = 4000;

function deriveFacing(dx: number, dy: number, fallback: Facing): Facing {
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return fallback;
  if (Math.abs(dy) > Math.abs(dx)) return dy < 0 ? "up" : "down";
  return dx < 0 ? "left" : "right";
}

/** Loiter inside a shop. Live mode picks a random authored browse waypoint,
 *  pathfinds to it, pauses for a few seconds, and repeats until the duration
 *  timer expires. Abstract mode is just a duration countdown — the agent's
 *  location stays at wherever it entered (the prefixing `GoTo` lands them at
 *  the interior arrival tile).
 *
 *  Falls back gracefully when no browse waypoints are registered for the
 *  business: the agent stands at its current tile and only swaps facings,
 *  i.e. behaves like `IdleActivity` until the duration runs out. The plan
 *  calls out an authoring guideline of ≥3 waypoints per shop; missing
 *  waypoints just degrade visuals, not correctness. */
export class BrowseActivity extends BaseActivity {
  readonly kind = "browse";

  private handle: BodyHandle | null = null;

  constructor(public readonly config: BrowseConfig, private runtime: BrowseRuntime) {
    super();
  }

  static create(
    config: Pick<BrowseConfig, "businessId" | "durationMinutes"> &
      Partial<Pick<BrowseConfig, "browseGroupId" | "moveSpeed" | "waypointPauseMs">>,
  ): BrowseActivity {
    return new BrowseActivity(
      {
        businessId: config.businessId,
        browseGroupId: config.browseGroupId ?? DEFAULT_BROWSE_GROUP_ID,
        durationMinutes: Math.max(0, config.durationMinutes),
        moveSpeed: config.moveSpeed ?? 30,
        waypointPauseMs: config.waypointPauseMs ?? 2500,
      },
      {
        remainingMinutes: Math.max(0, config.durationMinutes),
        livePhase: "pausing",
        livePhaseTimer: Math.random() * 1500,
        liveTargetTile: null,
        livePath: null,
        livePathIdx: 0,
        livePathAgeMs: 0,
        lastWaypointIdx: -1,
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
    if (r.remainingMinutes <= 0) { handle.setAnim("idle"); return; }

    r.livePhaseTimer -= dtMs;

    if (r.livePhase === "pausing") {
      if (r.livePhaseTimer > 0) { handle.setAnim("idle"); return; }
      // Pick the next waypoint and start walking. If we can't find one, just
      // refresh the pause + swap facing so the NPC reads as alive.
      const next = this.pickNextWaypoint(npc.location.sceneKey);
      if (!next) {
        handle.setAnim("idle");
        const facings: readonly Facing[] = ["up", "down", "left", "right"];
        handle.setFacing(facings[Math.floor(Math.random() * facings.length)]);
        r.livePhaseTimer = this.config.waypointPauseMs;
        return;
      }
      r.liveTargetTile = next;
      r.livePhase = "moving";
      r.livePhaseTimer = 8000; // safety timeout per leg
      r.livePath = null;
      r.livePathIdx = 0;
      r.livePathAgeMs = 0;
      return;
    }

    if (!r.liveTargetTile) { this.enterPause(handle); return; }

    if (!r.livePath || r.livePathIdx >= r.livePath.length) {
      this.computeLivePath(npc, r.liveTargetTile, ctx.live?.pathfinder);
      if (!r.livePath) { this.enterPause(handle); return; }
    }
    r.livePathAgeMs += dtMs;
    if (r.livePathAgeMs > PATH_MAX_AGE_MS) {
      // Stuck — give up on this leg and pause; next pick will try a different
      // waypoint.
      this.enterPause(handle);
      return;
    }

    const wp = r.livePath[r.livePathIdx];
    const dx = wp.x - npc.body.px;
    const dy = wp.y - npc.body.py;
    const dist = Math.hypot(dx, dy);
    if (dist <= WAYPOINT_REACH_PX) {
      r.livePathIdx += 1;
      if (r.livePathIdx >= r.livePath.length) { this.enterPause(handle); return; }
      handle.setAnim("walk");
      return;
    }

    const dt = dtMs / 1000;
    const step = Math.min(dist, this.config.moveSpeed * dt);
    const nx = npc.body.px + (dx / dist) * step;
    const ny = npc.body.py + (dy / dist) * step;

    const walkable = ctx.live?.walkable;
    let px = npc.body.px;
    let py = npc.body.py;
    let moved = false;
    if (!walkable || walkable(nx, py)) { px = nx; moved = true; }
    if (!walkable || walkable(px, ny)) { py = ny; moved = true; }
    if (!moved) {
      // Re-path on the next tick from a clean slate.
      r.livePath = null;
      r.livePathIdx = 0;
      r.livePathAgeMs = 0;
      handle.setAnim("idle");
      return;
    }

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
    this.runtime.liveTargetTile = null;
    this.runtime.livePath = null;
    this.runtime.livePathIdx = 0;
    this.runtime.livePathAgeMs = 0;
  }

  dematerialize(npc: NpcAgent, _ctx: ActivityCtx): void {
    const tileX = Math.floor(npc.body.px / TILE_SIZE);
    const tileY = Math.floor(npc.body.py / TILE_SIZE);
    npc.location = { sceneKey: npc.location.sceneKey, tileX, tileY, facing: npc.body.facing };
    if (this.handle) { this.handle.release(); this.handle = null; }
  }

  serialize(): BrowseSerialized {
    return {
      config: { ...this.config },
      runtime: { remainingMinutes: this.runtime.remainingMinutes },
    };
  }

  private enterPause(handle: BodyHandle): void {
    this.runtime.livePhase = "pausing";
    this.runtime.livePhaseTimer = this.config.waypointPauseMs;
    this.runtime.liveTargetTile = null;
    this.runtime.livePath = null;
    this.runtime.livePathIdx = 0;
    this.runtime.livePathAgeMs = 0;
    handle.setAnim("idle");
  }

  /** Pick a random browse waypoint that lives in the same scene as the NPC.
   *  Avoids the immediately-previous pick when more than one is available so
   *  shop visits don't degenerate into ping-pong. */
  private pickNextWaypoint(currentScene: string): { x: number; y: number } | null {
    const points = this.collectWaypoints(currentScene);
    if (points.length === 0) return null;
    if (points.length === 1) return points[0];
    let idx = Math.floor(Math.random() * points.length);
    if (idx === this.runtime.lastWaypointIdx) idx = (idx + 1) % points.length;
    this.runtime.lastWaypointIdx = idx;
    return points[idx];
  }

  private collectWaypoints(currentScene: string): Array<{ x: number; y: number }> {
    const fromConfig = browseWaypoints.get(
      browseWaypointKey(this.config.businessId, this.config.browseGroupId),
    );
    return fromConfig
      .filter((wp: WorldLocation) => wp.sceneKey === currentScene)
      .map((wp) => ({ x: wp.tileX, y: wp.tileY }));
  }

  private computeLivePath(
    npc: NpcAgent,
    targetTile: { x: number; y: number },
    pathfinder: Pathfinder | undefined,
  ): void {
    this.runtime.livePathAgeMs = 0;
    this.runtime.livePathIdx = 0;
    this.runtime.livePath = null;
    const toPx = {
      x: (targetTile.x + 0.5) * TILE_SIZE,
      y: (targetTile.y + 0.5) * TILE_SIZE,
    };
    if (!pathfinder) {
      this.runtime.livePath = [toPx];
      return;
    }
    const result = pathfinder({
      fromPx: { x: npc.body.px, y: npc.body.py },
      toPx,
      allowNonWalkableGoal: true,
    });
    if (!result || result.length === 0) this.runtime.livePath = null;
    else this.runtime.livePath = result;
  }
}

export function deserializeBrowse(data: unknown): Activity {
  const s = data as Partial<BrowseSerialized>;
  if (!s.config) throw new Error("deserializeBrowse: missing config");
  const remaining = Math.max(
    0,
    Math.floor(s.runtime?.remainingMinutes ?? s.config.durationMinutes ?? 0),
  );
  return new BrowseActivity(
    { ...s.config },
    {
      remainingMinutes: remaining,
      livePhase: "pausing",
      livePhaseTimer: 0,
      liveTargetTile: null,
      livePath: null,
      livePathIdx: 0,
      livePathAgeMs: 0,
      lastWaypointIdx: -1,
    },
  );
}
