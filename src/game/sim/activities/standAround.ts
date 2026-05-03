import { TILE_SIZE } from "../../constants";
import { BaseActivity } from "./activity";
import type {
  Activity,
  ActivityCtx,
  Pathfinder,
  PathWaypoint,
} from "./activity";
import type { BodyHandle } from "../bodyHandle";
import type { Facing } from "../location";
import type { NpcAgent } from "../npcAgent";
import {
  standingSpots,
  standingSpotKey,
  DEFAULT_STANDING_GROUP_ID,
} from "../planner/standingSpots";

export interface StandAroundConfig {
  /** Interior key or business id used to look up authored standing spots
   *  (`standingSpots` registry). The shop's interior must be loaded for live
   *  mode to find spots — InteriorScene seeds them on create. Abstract mode
   *  doesn't read or claim spots. */
  readonly businessId: string;
  /** Optional sub-zone id within the shop. Defaults to `"all"`. */
  readonly standingGroupId: string;
  /** How long the visit lasts in sim-minutes. Drained by the abstract tick. */
  readonly durationMinutes: number;
  /** Pixels per second when walking to the next spot in live mode. */
  readonly moveSpeed: number;
  /** Wallclock ms to stand at each claimed spot before releasing and picking
   *  the next one. Default 20000 (20s). */
  readonly dwellMs: number;
}

type LivePhase = "claiming" | "moving" | "standing";

interface StandAroundRuntime {
  remainingMinutes: number;
  livePhase: LivePhase;
  /** Spot uid currently held (or being walked to). Null while in `claiming`
   *  or after a release before the next claim. */
  currentSpotUid: string | null;
  /** Spot uid we just vacated, so the next `tryClaim` skips it (avoids
   *  ping-ponging on the same tile when only two spots are free). */
  lastSpotUid: string | null;
  dwellTimer: number;
  liveTargetTile: { x: number; y: number } | null;
  livePath: PathWaypoint[] | null;
  livePathIdx: number;
  livePathAgeMs: number;
  /** When set, the activity has decided no more progress is possible (no
   *  free spots and nowhere to fall back to) and finishes early. */
  abandoned: boolean;
}

interface StandAroundSerialized {
  config: StandAroundConfig;
  runtime: Pick<StandAroundRuntime, "remainingMinutes">;
}

const CLAIMANT = { name: "StandAround" };
const WAYPOINT_REACH_PX = 1.5;
const PATH_MAX_AGE_MS = 4000;

function deriveFacing(dx: number, dy: number, fallback: Facing): Facing {
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return fallback;
  if (Math.abs(dy) > Math.abs(dx)) return dy < 0 ? "up" : "down";
  return dx < 0 ? "left" : "right";
}

/** Loiter inside a shop by cycling through authored standing spots. Each spot
 *  is reserved atomically *before* the patron starts walking to it — the
 *  reservation prevents two patrons from picking the same spot while one is
 *  still en route. After a wallclock dwell at the spot the activity releases
 *  and picks another free one. Finishes when its sim-minute duration runs out
 *  OR when no free spot is available (the "all spots taken" exit branch).
 *
 *  Abstract mode doesn't claim spots — the player isn't in the scene, so
 *  there's no risk of visible collisions. The activity just drains the
 *  duration counter until the abstract clock catches up. */
export class StandAroundActivity extends BaseActivity {
  readonly kind = "standAround";

  private handle: BodyHandle | null = null;

  constructor(
    public readonly config: StandAroundConfig,
    private runtime: StandAroundRuntime,
  ) {
    super();
  }

  static create(
    config: Pick<StandAroundConfig, "businessId" | "durationMinutes"> &
      Partial<
        Pick<StandAroundConfig, "standingGroupId" | "moveSpeed" | "dwellMs">
      >,
  ): StandAroundActivity {
    return new StandAroundActivity(
      {
        businessId: config.businessId,
        standingGroupId: config.standingGroupId ?? DEFAULT_STANDING_GROUP_ID,
        durationMinutes: Math.max(0, config.durationMinutes),
        moveSpeed: config.moveSpeed ?? 30,
        dwellMs: Math.max(0, config.dwellMs ?? 20000),
      },
      {
        remainingMinutes: Math.max(0, config.durationMinutes),
        livePhase: "claiming",
        currentSpotUid: null,
        lastSpotUid: null,
        dwellTimer: 0,
        liveTargetTile: null,
        livePath: null,
        livePathIdx: 0,
        livePathAgeMs: 0,
        abandoned: false,
      },
    );
  }

  isComplete(): boolean {
    return this.runtime.abandoned || this.runtime.remainingMinutes <= 0;
  }

  override enter(npc: NpcAgent, ctx: ActivityCtx): void {
    if (ctx.live && !this.handle) this.handle = ctx.claimBody(npc, CLAIMANT);
  }

  override exit(npc: NpcAgent, _ctx: ActivityCtx): void {
    standingSpots.releaseAllFor(npc.id);
    this.runtime.currentSpotUid = null;
    if (this.handle) {
      this.handle.release();
      this.handle = null;
    }
  }

  override tickAbstract(_npc: NpcAgent, _ctx: ActivityCtx, simMinutes: number): void {
    if (simMinutes <= 0) return;
    this.runtime.remainingMinutes = Math.max(
      0,
      this.runtime.remainingMinutes - simMinutes,
    );
  }

  override tickLive(npc: NpcAgent, ctx: ActivityCtx, dtMs: number): void {
    if (!this.handle) this.handle = ctx.claimBody(npc, CLAIMANT);
    const handle = this.handle;
    const r = this.runtime;
    if (this.isComplete()) {
      handle.setAnim("idle");
      return;
    }

    const key = standingSpotKey(this.config.businessId, this.config.standingGroupId);

    if (r.livePhase === "claiming") {
      const claimed = standingSpots.tryClaim(
        key,
        npc.id,
        r.lastSpotUid ?? undefined,
      );
      if (!claimed) {
        // No free spot (other than the one we just vacated). Per design:
        // "until time is up OR all spots are taken" — finish early.
        r.abandoned = true;
        handle.setAnim("idle");
        return;
      }
      r.currentSpotUid = claimed.uid;
      r.liveTargetTile = { x: claimed.location.tileX, y: claimed.location.tileY };
      r.livePhase = "moving";
      r.livePath = null;
      r.livePathIdx = 0;
      r.livePathAgeMs = 0;
      return;
    }

    if (r.livePhase === "standing") {
      r.dwellTimer -= dtMs;
      if (r.dwellTimer > 0) {
        handle.setAnim("idle");
        return;
      }
      // Dwell complete. Release this spot, remember it as `lastSpotUid` so
      // the next claim skips it, and loop back to claiming.
      if (r.currentSpotUid) {
        standingSpots.release(r.currentSpotUid);
        r.lastSpotUid = r.currentSpotUid;
        r.currentSpotUid = null;
      }
      r.livePhase = "claiming";
      r.liveTargetTile = null;
      handle.setAnim("idle");
      return;
    }

    // ── moving ──────────────────────────────────────────────────────────
    if (!r.liveTargetTile) {
      // Shouldn't happen, but recover gracefully by re-entering claim.
      r.livePhase = "claiming";
      return;
    }

    if (!r.livePath || r.livePathIdx >= r.livePath.length) {
      this.computeLivePath(npc, r.liveTargetTile, ctx.live?.pathfinder);
      if (!r.livePath) {
        // No path — release the spot and try a different one next tick.
        if (r.currentSpotUid) {
          standingSpots.release(r.currentSpotUid);
          r.lastSpotUid = r.currentSpotUid;
          r.currentSpotUid = null;
        }
        r.livePhase = "claiming";
        return;
      }
    }
    r.livePathAgeMs += dtMs;
    if (r.livePathAgeMs > PATH_MAX_AGE_MS) {
      // Stuck for too long — give up on this spot, release, retry.
      if (r.currentSpotUid) {
        standingSpots.release(r.currentSpotUid);
        r.lastSpotUid = r.currentSpotUid;
        r.currentSpotUid = null;
      }
      r.livePhase = "claiming";
      return;
    }

    const wp = r.livePath[r.livePathIdx];
    const dx = wp.x - npc.body.px;
    const dy = wp.y - npc.body.py;
    const dist = Math.hypot(dx, dy);
    if (dist <= WAYPOINT_REACH_PX) {
      r.livePathIdx += 1;
      if (r.livePathIdx >= r.livePath.length) {
        // Arrived. Begin the dwell.
        r.livePhase = "standing";
        r.dwellTimer = this.config.dwellMs;
        handle.setAnim("idle");
        return;
      }
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
    // Reset live state — any reservation from a prior session was wiped on
    // dematerialize, and the reservation registry doesn't persist anyway.
    this.runtime.livePhase = "claiming";
    this.runtime.currentSpotUid = null;
    this.runtime.lastSpotUid = null;
    this.runtime.dwellTimer = 0;
    this.runtime.liveTargetTile = null;
    this.runtime.livePath = null;
    this.runtime.livePathIdx = 0;
    this.runtime.livePathAgeMs = 0;
    this.runtime.abandoned = false;
  }

  dematerialize(npc: NpcAgent, _ctx: ActivityCtx): void {
    const tileX = Math.floor(npc.body.px / TILE_SIZE);
    const tileY = Math.floor(npc.body.py / TILE_SIZE);
    npc.location = {
      sceneKey: npc.location.sceneKey,
      tileX,
      tileY,
      facing: npc.body.facing,
    };
    standingSpots.releaseAllFor(npc.id);
    this.runtime.currentSpotUid = null;
    if (this.handle) {
      this.handle.release();
      this.handle = null;
    }
  }

  serialize(): StandAroundSerialized {
    return {
      config: { ...this.config },
      runtime: { remainingMinutes: this.runtime.remainingMinutes },
    };
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

export function deserializeStandAround(data: unknown): Activity {
  const s = data as Partial<StandAroundSerialized>;
  if (!s.config) throw new Error("deserializeStandAround: missing config");
  const remaining = Math.max(
    0,
    Math.floor(s.runtime?.remainingMinutes ?? s.config.durationMinutes ?? 0),
  );
  return new StandAroundActivity(
    { ...s.config },
    {
      remainingMinutes: remaining,
      livePhase: "claiming",
      currentSpotUid: null,
      lastSpotUid: null,
      dwellTimer: 0,
      liveTargetTile: null,
      livePath: null,
      livePathIdx: 0,
      livePathAgeMs: 0,
      abandoned: false,
    },
  );
}
