import type { CalendarContext } from "../calendar/calendar";
import type { BodyHandle } from "../bodyHandle";
import type { WorldLocation } from "../location";
import type { NpcAgent } from "../npcAgent";

export type WalkableProbe = (px: number, py: number) => boolean;

/** Pixel-space waypoint along a path. Mirrors `world/pathfinding.ts`'s
 *  `Waypoint` type without importing it (sim has no adapter deps). */
export interface PathWaypoint {
  readonly x: number;
  readonly y: number;
}

export interface PathfinderQuery {
  readonly fromPx: PathWaypoint;
  readonly toPx: PathWaypoint;
  /** Allow the goal tile itself to be non-walkable (counters, doors with
   *  collision lintel). Defaults to true at the adapter. */
  readonly allowNonWalkableGoal?: boolean;
}

/** Live-mode pathfinding probe. Provided by the adapter (binder) — wraps
 *  `pathfindPx` against the active scene's walkability oracle. Returns null
 *  when no path exists or the search budget is exceeded. */
export type Pathfinder = (q: PathfinderQuery) => PathWaypoint[] | null;

/** Phaser-only state passed through `ActivityCtx` in live mode. Typed as a
 *  loose pair of opaque references so the sim layer never imports Phaser. */
export interface LiveCtxBindings {
  readonly scene: object;
  /** Pixel-space path search rooted at the active scene. Activities that
   *  need cross-tile routing (GoTo) call this; activities that only walk in
   *  straight lines (Wander, Patrol) just use `walkable`. */
  readonly pathfinder?: Pathfinder;
  /** Tile-stable walkability oracle for the active scene. Activities that
   *  move the body (Wander, Patrol, GoTo) query this before committing
   *  pixel-step writes. */
  readonly walkable?: WalkableProbe;
}

export interface ActivityCtx {
  readonly registry: ActivityCtxRegistry;
  /** Current in-game minute-of-day [0,1440), and current `dayCount`. */
  readonly time: { readonly minuteOfDay: number; readonly dayCount: number };
  readonly calendar: CalendarContext;
  /** Claim the body for this activity (or another claimant on its behalf).
   *  Throws if the body is already claimed by something else. */
  claimBody(npc: NpcAgent, claimant: object): BodyHandle;
  /** Live-mode only. `undefined` during abstract ticks. */
  readonly live?: LiveCtxBindings;
}

/** A subset of the registry surface visible to activities. Avoids exposing
 *  `tickAbstract` / `serialize` etc. through the activity context. */
export interface ActivityCtxRegistry {
  setLocation(npcId: string, loc: WorldLocation): void;
  npcsAt(sceneKey: string): readonly NpcAgent[];
}

export interface Activity {
  /** Stable identifier used for serialization dispatch. */
  readonly kind: string;

  enter(npc: NpcAgent, ctx: ActivityCtx): void;

  /** Canonical state advance, scene-agnostic. Driven by the registry's
   *  per-minute(-ish) tick. `simMinutes` is the number of in-game minutes
   *  to advance. */
  tickAbstract(npc: NpcAgent, ctx: ActivityCtx, simMinutes: number): void;

  /** Per-frame; reads abstract state and drives the visual proxy. May call
   *  `tickAbstract` internally to keep the canonical state aligned. Only
   *  invoked while the NPC is in the player's active scene. */
  tickLive(npc: NpcAgent, ctx: ActivityCtx, dtMs: number): void;

  exit(npc: NpcAgent, ctx: ActivityCtx): void;

  isComplete(): boolean;
  canInterrupt(): boolean;

  /** Plain-JSON state (no class instances). The matching deserializer is
   *  registered in `activities/registry.ts`. */
  serialize(): unknown;

  /** Optional. Called when a scene loads/unloads mid-activity. */
  materialize?(npc: NpcAgent, ctx: ActivityCtx): void;
  dematerialize?(npc: NpcAgent, ctx: ActivityCtx): void;
}

export abstract class BaseActivity implements Activity {
  abstract readonly kind: string;

  enter(_npc: NpcAgent, _ctx: ActivityCtx): void {}
  tickAbstract(_npc: NpcAgent, _ctx: ActivityCtx, _simMinutes: number): void {}
  tickLive(_npc: NpcAgent, _ctx: ActivityCtx, _dtMs: number): void {}
  exit(_npc: NpcAgent, _ctx: ActivityCtx): void {}

  abstract isComplete(): boolean;
  canInterrupt(): boolean { return true; }
  abstract serialize(): unknown;
}

/** Common pattern: pathfind to `target`, then run a sub-routine until
 *  complete. Subclasses fill in the "do" half via `tickDo` / `isDoComplete`.
 *  The walk half is a budgeted sim-minute countdown today; later phases
 *  swap the abstract walk for path-aware ETAs and add the live half. */
export interface WalkAndThenDoState {
  phase: "walk" | "do" | "done";
  walkMinutesRemaining: number;
}

export abstract class WalkAndThenDo extends BaseActivity {
  protected state: WalkAndThenDoState;

  constructor(
    protected readonly target: WorldLocation,
    estimatedWalkMinutes: number,
    initial?: WalkAndThenDoState,
  ) {
    super();
    this.state = initial ?? {
      phase: "walk",
      walkMinutesRemaining: Math.max(0, estimatedWalkMinutes),
    };
  }

  override tickAbstract(npc: NpcAgent, ctx: ActivityCtx, simMinutes: number): void {
    if (this.state.phase === "walk") {
      this.state.walkMinutesRemaining -= simMinutes;
      if (this.state.walkMinutesRemaining <= 0) {
        ctx.registry.setLocation(npc.id, this.target);
        this.state.phase = "do";
        this.onArrived(npc, ctx);
      }
      return;
    }
    if (this.state.phase === "do") {
      this.tickDo(npc, ctx, simMinutes);
      if (this.isDoComplete()) this.state.phase = "done";
    }
  }

  protected onArrived(_npc: NpcAgent, _ctx: ActivityCtx): void {}
  protected abstract tickDo(npc: NpcAgent, ctx: ActivityCtx, simMinutes: number): void;
  protected abstract isDoComplete(): boolean;

  override isComplete(): boolean { return this.state.phase === "done"; }
}
