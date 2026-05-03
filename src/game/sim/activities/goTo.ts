import { TILE_SIZE } from "../../constants";
import { BaseActivity } from "./activity";
import type {
  Activity,
  ActivityCtx,
  Pathfinder,
  PathWaypoint,
} from "./activity";
import type { BodyHandle } from "../bodyHandle";
import type { Facing, SceneKey, WorldLocation } from "../location";
import type { NpcAgent } from "../npcAgent";
import { portalRegistry } from "../portals";

export interface GoToConfig {
  /** Final destination — tile in `target.sceneKey`. */
  readonly target: WorldLocation;
  /** Pixels per second when running in live mode. */
  readonly liveSpeedPxPerSec: number;
  /** Tiles per sim-minute when running in abstract mode. Tuned to be a touch
   *  slower than the live equivalent so abstract travel doesn't outpace
   *  what the player would see. */
  readonly abstractTilesPerMinute: number;
}

interface GoToLeg {
  /** Scene this leg is walked in. */
  readonly sceneKey: SceneKey;
  readonly startTile: { x: number; y: number };
  readonly endTile: { x: number; y: number };
  /** When non-null, completing this leg traverses a portal into
   *  `portalToSceneKey` at `portalEntryTile`. The next leg begins there. */
  readonly portalToSceneKey: SceneKey | null;
  readonly portalEntryTile: { x: number; y: number } | null;
}

interface GoToRuntime {
  legs: GoToLeg[];
  legIndex: number;
  /** Sim-minutes consumed within the current leg. */
  legElapsedMinutes: number;
  done: boolean;
  /** Live-only path cache. Not serialized. */
  livePath: PathWaypoint[] | null;
  livePathIdx: number;
  /** Live-only timeout per pathfind attempt — protects against an unstable
   *  walkability oracle thrashing the search. Reset whenever a new path is
   *  computed; advances proportionally to dtMs. */
  livePathAgeMs: number;
}

interface GoToSerializedRuntime {
  legs: GoToLeg[];
  legIndex: number;
  legElapsedMinutes: number;
  done: boolean;
}

interface GoToSerialized {
  config: GoToConfig;
  runtime: GoToSerializedRuntime;
}

const CLAIMANT = { name: "GoTo" };
/** A traversed waypoint within this many pixels counts as "reached". */
const WAYPOINT_REACH_PX = 1.5;
/** Re-pathfind if a single path has been alive longer than this without
 *  reaching the leg's end. */
const PATH_MAX_AGE_MS = 4000;
/** Fixed per-portal cost in sim-minutes — represents door fumble + threshold
 *  cross. Matches the player's perceived pause when entering an interior. */
const PORTAL_COST_MINUTES = 0.25;

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

function legDistTiles(leg: GoToLeg): number {
  return octile(leg.startTile.x, leg.startTile.y, leg.endTile.x, leg.endTile.y);
}

function deriveFacing(dx: number, dy: number, fallback: Facing): Facing {
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return fallback;
  if (Math.abs(dy) > Math.abs(dx)) return dy < 0 ? "up" : "down";
  return dx < 0 ? "left" : "right";
}

/** Cross-scene movement activity. Plans a route as one or two legs:
 *  same-scene direct, or current-scene → portal → target-scene. Multi-portal
 *  chains (e.g. interior → world → another interior) are out of scope for
 *  Phase 4 — the scheduler will compose two `GoTo`s instead.
 *
 *  Live mode uses the adapter-provided pathfinder for tile-accurate routing
 *  inside the current leg. Abstract mode draws each leg's duration from its
 *  octile tile distance × `abstractTilesPerMinute` and advances the leg
 *  index as the abstract clock ticks. The handshake on scene-boundary
 *  crossings is automatic because completing a portal-bearing leg calls
 *  `ctx.registry.setLocation`, which fires `npcLeftScene` / `npcEnteredScene`
 *  in that order — the binders pick up dematerialize/materialize from
 *  there. */
export class GoToActivity extends BaseActivity {
  readonly kind = "goTo";

  private handle: BodyHandle | null = null;

  constructor(public readonly config: GoToConfig, private runtime: GoToRuntime) {
    super();
  }

  /** Plan a `GoToActivity` from `npc.location` to `target`. Returns null
   *  when the destination is in a different scene and no portal connects
   *  them — the caller should pick a different target or wait until portals
   *  are registered (e.g. after the destination interior has been visited
   *  for the first time). */
  static plan(
    npc: NpcAgent,
    target: WorldLocation,
    opts?: Partial<Pick<GoToConfig, "liveSpeedPxPerSec" | "abstractTilesPerMinute">>,
  ): GoToActivity | null {
    const config: GoToConfig = {
      target,
      liveSpeedPxPerSec: opts?.liveSpeedPxPerSec ?? 36,
      abstractTilesPerMinute: opts?.abstractTilesPerMinute ?? 60,
    };
    const legs: GoToLeg[] = [];
    if (npc.location.sceneKey === target.sceneKey) {
      legs.push({
        sceneKey: target.sceneKey,
        startTile: { x: npc.location.tileX, y: npc.location.tileY },
        endTile: { x: target.tileX, y: target.tileY },
        portalToSceneKey: null,
        portalEntryTile: null,
      });
    } else {
      const portal = portalRegistry.findPortal(npc.location.sceneKey, target.sceneKey);
      if (!portal) return null;
      legs.push({
        sceneKey: npc.location.sceneKey,
        startTile: { x: npc.location.tileX, y: npc.location.tileY },
        endTile: { x: portal.fromTile.x, y: portal.fromTile.y },
        portalToSceneKey: portal.toSceneKey,
        portalEntryTile: { x: portal.toTile.x, y: portal.toTile.y },
      });
      legs.push({
        sceneKey: portal.toSceneKey,
        startTile: { x: portal.toTile.x, y: portal.toTile.y },
        endTile: { x: target.tileX, y: target.tileY },
        portalToSceneKey: null,
        portalEntryTile: null,
      });
    }
    return new GoToActivity(config, {
      legs,
      legIndex: 0,
      legElapsedMinutes: 0,
      done: false,
      livePath: null,
      livePathIdx: 0,
      livePathAgeMs: 0,
    });
  }

  isComplete(): boolean { return this.runtime.done; }

  override enter(npc: NpcAgent, ctx: ActivityCtx): void {
    if (ctx.live && !this.handle) {
      this.handle = ctx.claimBody(npc, CLAIMANT);
    }
  }

  override exit(_npc: NpcAgent, _ctx: ActivityCtx): void {
    if (this.handle) { this.handle.release(); this.handle = null; }
  }

  override tickAbstract(npc: NpcAgent, ctx: ActivityCtx, simMinutes: number): void {
    if (this.runtime.done || simMinutes <= 0) return;
    let remaining = simMinutes;
    let safety = 8;
    while (remaining > 0 && !this.runtime.done && safety-- > 0) {
      const leg = this.runtime.legs[this.runtime.legIndex];
      if (!leg) { this.runtime.done = true; break; }
      const distTiles = legDistTiles(leg);
      const legMinutes =
        Math.max(0, distTiles / this.config.abstractTilesPerMinute) +
        (leg.portalToSceneKey ? PORTAL_COST_MINUTES : 0);
      const consumed = Math.min(remaining, Math.max(0, legMinutes - this.runtime.legElapsedMinutes));
      this.runtime.legElapsedMinutes += consumed;
      remaining -= consumed;
      if (this.runtime.legElapsedMinutes + 1e-9 >= legMinutes) {
        this.completeLeg(npc, ctx, leg);
      }
    }
  }

  override tickLive(npc: NpcAgent, ctx: ActivityCtx, dtMs: number): void {
    if (this.runtime.done) return;
    if (!this.handle) this.handle = ctx.claimBody(npc, CLAIMANT);
    const handle = this.handle;
    const live = ctx.live;
    if (!live) return;

    const leg = this.runtime.legs[this.runtime.legIndex];
    if (!leg) { this.runtime.done = true; return; }
    // If the active scene is no longer the leg's scene (e.g. the binder
    // re-attached after the agent crossed a portal), pause the live tick —
    // the abstract path will take over until materialize fires in the right
    // scene.
    if (npc.location.sceneKey !== leg.sceneKey) return;

    if (!this.runtime.livePath || this.runtime.livePathIdx >= this.runtime.livePath.length) {
      this.computeLivePath(npc, leg, live.pathfinder);
      // No path available — fall back to abstract: instantly complete the
      // leg. Better than spinning forever inside a wall.
      if (!this.runtime.livePath) {
        this.completeLeg(npc, ctx, leg);
        return;
      }
    }
    this.runtime.livePathAgeMs += dtMs;
    if (this.runtime.livePathAgeMs > PATH_MAX_AGE_MS) {
      this.runtime.livePath = null;
      this.runtime.livePathIdx = 0;
      this.runtime.livePathAgeMs = 0;
      handle.setAnim("idle");
      return;
    }

    const path = this.runtime.livePath!;
    let idx = this.runtime.livePathIdx;
    const wp = path[idx];
    const dx = wp.x - npc.body.px;
    const dy = wp.y - npc.body.py;
    const dist = Math.hypot(dx, dy);
    if (dist <= WAYPOINT_REACH_PX) {
      this.runtime.livePathIdx = idx + 1;
      if (this.runtime.livePathIdx >= path.length) {
        this.completeLeg(npc, ctx, leg);
      } else {
        handle.setAnim("walk");
      }
      return;
    }

    const dt = dtMs / 1000;
    const step = Math.min(dist, this.config.liveSpeedPxPerSec * dt);
    const ux = dx / dist;
    const uy = dy / dist;
    const nx = npc.body.px + ux * step;
    const ny = npc.body.py + uy * step;

    // Axis-projected wall slide so the NPC doesn't dead-stop on a corner —
    // mirrors WanderActivity behavior. If both axes refuse, force a re-path.
    const walkable = live.walkable;
    let px = npc.body.px;
    let py = npc.body.py;
    let moved = false;
    if (!walkable || walkable(nx, py)) { px = nx; moved = true; }
    if (!walkable || walkable(px, ny)) { py = ny; moved = true; }
    if (!moved) {
      this.runtime.livePath = null;
      this.runtime.livePathIdx = 0;
      this.runtime.livePathAgeMs = 0;
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
    if (this.runtime.done) return;
    if (!this.handle) this.handle = ctx.claimBody(npc, CLAIMANT);
    const leg = this.runtime.legs[this.runtime.legIndex];
    if (!leg) return;
    // Place body at interpolated tile position along the current leg, using
    // legElapsedMinutes / legMinutes as the fraction. Snap to the leg's
    // start tile when the walkable oracle rejects the interpolated point —
    // an obstructed midpoint is the kind of bug the materialize fallback in
    // the phase plan calls out.
    const distTiles = legDistTiles(leg);
    const legMinutes = Math.max(
      1e-6,
      distTiles / this.config.abstractTilesPerMinute +
        (leg.portalToSceneKey ? PORTAL_COST_MINUTES : 0),
    );
    const t = Math.max(0, Math.min(1, this.runtime.legElapsedMinutes / legMinutes));
    const tx = leg.startTile.x + (leg.endTile.x - leg.startTile.x) * t;
    const ty = leg.startTile.y + (leg.endTile.y - leg.startTile.y) * t;
    let px = (tx + 0.5) * TILE_SIZE;
    let py = (ty + 0.5) * TILE_SIZE;
    const walkable = ctx.live?.walkable;
    if (walkable && !walkable(px, py)) {
      px = (leg.startTile.x + 0.5) * TILE_SIZE;
      py = (leg.startTile.y + 0.5) * TILE_SIZE;
    }
    this.handle.setPosition(px, py);
    this.handle.setAnim("idle");
    npc.location = {
      sceneKey: leg.sceneKey,
      tileX: Math.floor(px / TILE_SIZE),
      tileY: Math.floor(py / TILE_SIZE),
      facing: npc.body.facing,
    };
    this.runtime.livePath = null;
    this.runtime.livePathIdx = 0;
    this.runtime.livePathAgeMs = 0;
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
    if (this.handle) { this.handle.release(); this.handle = null; }
    this.runtime.livePath = null;
    this.runtime.livePathIdx = 0;
    this.runtime.livePathAgeMs = 0;
  }

  serialize(): GoToSerialized {
    return {
      config: { ...this.config, target: { ...this.config.target } },
      runtime: {
        legs: this.runtime.legs.map((l) => ({
          sceneKey: l.sceneKey,
          startTile: { ...l.startTile },
          endTile: { ...l.endTile },
          portalToSceneKey: l.portalToSceneKey,
          portalEntryTile: l.portalEntryTile ? { ...l.portalEntryTile } : null,
        })),
        legIndex: this.runtime.legIndex,
        legElapsedMinutes: this.runtime.legElapsedMinutes,
        done: this.runtime.done,
      },
    };
  }

  // ── Internals ──────────────────────────────────────────────────────

  private completeLeg(npc: NpcAgent, ctx: ActivityCtx, leg: GoToLeg): void {
    if (leg.portalToSceneKey && leg.portalEntryTile) {
      // Cross-scene jump. setLocation emits npcLeftScene then npcEnteredScene,
      // the binder dematerializes our proxy in the source scene and the next
      // leg's tick handles materialize on enter.
      const facing = npc.location.facing;
      const entryTile = { x: leg.portalEntryTile.x, y: leg.portalEntryTile.y };
      ctx.registry.setLocation(npc.id, {
        sceneKey: leg.portalToSceneKey,
        tileX: entryTile.x,
        tileY: entryTile.y,
        facing,
      });
      // setLocation triggered dematerialize on the source binder, which
      // re-derived `npc.location.tile{X,Y}` from the pre-traversal body
      // pixel — *in the new scene's coords*, which is meaningless. Restore
      // the canonical location to the entry tile.
      npc.location = {
        sceneKey: leg.portalToSceneKey,
        tileX: entryTile.x,
        tileY: entryTile.y,
        facing,
      };
      // Snap canonical body to the entry tile as well — the binder's mirror
      // / a future materialize will read this. Bypasses the BodyHandle
      // because no live driver is competing across the cross-scene jump
      // (the proxy in the source scene is being torn down).
      const px = (entryTile.x + 0.5) * TILE_SIZE;
      const py = (entryTile.y + 0.5) * TILE_SIZE;
      (npc as { body: NpcAgent["body"] }).body = { ...npc.body, px, py, anim: "idle" };
    } else {
      ctx.registry.setLocation(npc.id, {
        sceneKey: leg.sceneKey,
        tileX: leg.endTile.x,
        tileY: leg.endTile.y,
        facing: npc.location.facing,
      });
      const px = (leg.endTile.x + 0.5) * TILE_SIZE;
      const py = (leg.endTile.y + 0.5) * TILE_SIZE;
      (npc as { body: NpcAgent["body"] }).body = { ...npc.body, px, py, anim: "idle" };
    }
    this.runtime.legIndex += 1;
    this.runtime.legElapsedMinutes = 0;
    this.runtime.livePath = null;
    this.runtime.livePathIdx = 0;
    this.runtime.livePathAgeMs = 0;
    if (this.runtime.legIndex >= this.runtime.legs.length) {
      this.runtime.done = true;
    }
  }

  private computeLivePath(
    npc: NpcAgent,
    leg: GoToLeg,
    pathfinder: Pathfinder | undefined,
  ): void {
    this.runtime.livePathAgeMs = 0;
    this.runtime.livePathIdx = 0;
    this.runtime.livePath = null;
    if (!pathfinder) {
      // Without a pathfinder, fall back to a single straight-line waypoint
      // at the leg end. The wall-slide in tickLive will keep us honest.
      this.runtime.livePath = [
        { x: (leg.endTile.x + 0.5) * TILE_SIZE, y: (leg.endTile.y + 0.5) * TILE_SIZE },
      ];
      return;
    }
    const result = pathfinder({
      fromPx: { x: npc.body.px, y: npc.body.py },
      toPx: { x: (leg.endTile.x + 0.5) * TILE_SIZE, y: (leg.endTile.y + 0.5) * TILE_SIZE },
      allowNonWalkableGoal: true,
    });
    if (!result || result.length === 0) {
      this.runtime.livePath = null;
    } else {
      this.runtime.livePath = result;
    }
  }
}

export function deserializeGoTo(data: unknown): Activity {
  const s = data as Partial<GoToSerialized>;
  if (!s.config || !s.runtime) {
    throw new Error("deserializeGoTo: missing config/runtime");
  }
  const r = s.runtime;
  return new GoToActivity(s.config, {
    legs: r.legs.map((l) => ({
      sceneKey: l.sceneKey,
      startTile: { ...l.startTile },
      endTile: { ...l.endTile },
      portalToSceneKey: l.portalToSceneKey,
      portalEntryTile: l.portalEntryTile ? { ...l.portalEntryTile } : null,
    })),
    legIndex: r.legIndex,
    legElapsedMinutes: r.legElapsedMinutes,
    done: r.done,
    livePath: null,
    livePathIdx: 0,
    livePathAgeMs: 0,
  });
}
