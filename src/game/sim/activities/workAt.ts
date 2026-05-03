import { BaseActivity } from "./activity";
import type { Activity, ActivityCtx } from "./activity";
import type { BodyHandle } from "../bodyHandle";
import type { NpcAgent } from "../npcAgent";
import type { WorldLocation } from "../location";
import { GoToActivity, deserializeGoTo } from "./goTo";
import {
  emitShiftComplete,
  getStaffService,
  onShiftComplete,
} from "../../business/staff/staffService";

export interface WorkAtConfig {
  readonly businessId: string;
  /** Role the staffer is clocking in as — must match a `RoleId` in the
   *  business kind's `roles` list (e.g. "cook", "server", "bartender"). */
  readonly roleId: string;
  /** Tile inside the business interior the staffer walks to before clocking
   *  in. Typically the workstation tile (or an authored "staff entry"). */
  readonly arrivalTile: WorldLocation;
  /** Live walk speed for the inner GoTo. */
  readonly liveSpeedPxPerSec?: number;
  /** Sim-minutes the shift lasts when running purely abstractly (player not
   *  in scene). Mirrors the average shift duration of the underlying staff
   *  FSM — defaults to a full 8-hour workday. The CustomerSim service drives
   *  shift end via `emitShiftComplete` when the player is watching. */
  readonly abstractShiftMinutes?: number;
}

type Phase =
  | "goingToWork"
  | "working"
  | "abstractWorking"
  | "done";

interface WorkAtRuntime {
  phase: Phase;
  /** Set on rejected clock-in / service vanished mid-shift. */
  failure: boolean;
  /** Sim-minutes remaining in `abstractWorking`. Live mode never reads this
   *  (the service drives shift completion). */
  abstractRemainingMinutes: number;
}

interface WorkAtSerialized {
  config: WorkAtConfig;
  runtime: WorkAtRuntime;
  inner: { kind: string; data: unknown } | null;
}

const CLAIMANT = { name: "WorkAt" };
const DEFAULT_ABSTRACT_SHIFT_MIN = 480; // 8 in-game hours

function defaultAbstract(config: WorkAtConfig): number {
  return config.abstractShiftMinutes ?? DEFAULT_ABSTRACT_SHIFT_MIN;
}

/** Top-level activity: walk to a workstation, hand body to the staff service,
 *  resume when service signals shift complete. Mirror of `PatronTavernActivity`
 *  for hired staff (cook / server / bartender). The inner FSM is owned by
 *  `CustomerSim` (via `staffService`); this activity is the bridge between an
 *  agent's day plan and that FSM.
 *
 *  Live mode wires through to `CustomerSim`'s cook/server/bartender role
 *  agents. Abstract mode is a duration timer: the player isn't watching, so
 *  the shift collapses to a flat "at work for N minutes." */
export class WorkAtActivity extends BaseActivity {
  readonly kind = "workAt";

  private handle: BodyHandle | null = null;
  private inner: GoToActivity | null;
  private unsubComplete: (() => void) | null = null;

  constructor(
    public readonly config: WorkAtConfig,
    private runtime: WorkAtRuntime,
    inner: GoToActivity | null,
  ) {
    super();
    this.inner = inner;
  }

  /** Build a `WorkAtActivity` for `npc`, planning an inner `GoTo` from the
   *  agent's current location to `config.arrivalTile`. Returns null if no
   *  route exists (no portal connecting source and destination scenes). */
  static plan(
    npc: NpcAgent,
    config: WorkAtConfig,
  ): WorkAtActivity | null {
    const goTo = GoToActivity.plan(npc, config.arrivalTile, {
      ...(config.liveSpeedPxPerSec !== undefined
        ? { liveSpeedPxPerSec: config.liveSpeedPxPerSec }
        : {}),
    });
    if (!goTo) return null;
    return new WorkAtActivity(
      config,
      {
        phase: "goingToWork",
        failure: false,
        abstractRemainingMinutes: 0,
      },
      goTo,
    );
  }

  isComplete(): boolean {
    return this.runtime.phase === "done";
  }

  override enter(npc: NpcAgent, ctx: ActivityCtx): void {
    if (this.runtime.phase === "goingToWork" && this.inner) {
      this.inner.enter(npc, ctx);
    }
    this.subscribeCompletion(npc.id);
  }

  override exit(npc: NpcAgent, ctx: ActivityCtx): void {
    this.unsubComplete?.();
    this.unsubComplete = null;
    if (this.inner) {
      try { this.inner.exit(npc, ctx); } catch (_e) { /* ignore */ }
      this.inner = null;
    }
    if (this.handle) {
      try { this.handle.release(); } catch (_e) { /* may already be transferred */ }
      this.handle = null;
    }
  }

  override tickAbstract(npc: NpcAgent, ctx: ActivityCtx, simMinutes: number): void {
    if (this.runtime.phase === "done" || simMinutes <= 0) return;

    if (this.runtime.phase === "goingToWork" && this.inner) {
      this.inner.tickAbstract(npc, ctx, simMinutes);
      if (this.inner.isComplete()) {
        try { this.inner.exit(npc, ctx); } catch (_e) { /* ignore */ }
        this.inner = null;
        // Without a live ctx we can't clock in (no body handle to transfer);
        // collapse into the abstract shift timer.
        this.runtime.phase = "abstractWorking";
        this.runtime.abstractRemainingMinutes = defaultAbstract(this.config);
      }
      return;
    }

    if (this.runtime.phase === "abstractWorking") {
      this.runtime.abstractRemainingMinutes -= simMinutes;
      if (this.runtime.abstractRemainingMinutes <= 0) {
        this.runtime.phase = "done";
      }
      return;
    }
    // "working": service-driven; abstract tick is a no-op while player is
    // watching. Completion arrives via the onShiftComplete listener.
  }

  override tickLive(npc: NpcAgent, ctx: ActivityCtx, dtMs: number): void {
    if (this.runtime.phase === "done") return;
    const live = ctx.live;
    if (!live) return;

    if (this.runtime.phase === "goingToWork" && this.inner) {
      this.inner.tickLive(npc, ctx, dtMs);
      if (this.inner.isComplete()) {
        try { this.inner.exit(npc, ctx); } catch (_e) { /* ignore */ }
        this.inner = null;
        this.attemptClockIn(npc, ctx);
      }
      return;
    }

    if (this.runtime.phase === "abstractWorking") {
      // Player just walked into the scene mid-shift. Take over with a real
      // service clock-in.
      this.attemptClockIn(npc, ctx);
      return;
    }
    // "working": service drives via the BodyHandle it transferred in.
    // Activity sits idle until onShiftComplete arrives.
  }

  materialize(npc: NpcAgent, ctx: ActivityCtx): void {
    this.subscribeCompletion(npc.id);
    if (this.runtime.phase === "goingToWork" && this.inner?.materialize) {
      this.inner.materialize(npc, ctx);
    }
  }

  dematerialize(npc: NpcAgent, ctx: ActivityCtx): void {
    if (this.inner?.dematerialize) {
      try { this.inner.dematerialize(npc, ctx); } catch (_e) { /* ignore */ }
    }
    if (this.runtime.phase === "working") {
      // Player left the scene mid-shift. The CustomerSim is being torn down
      // (its `stop()` will clock-out our staffer + emit completion). Nothing
      // we need to do beyond letting that fire — the listener marks us done.
    }
    this.unsubComplete?.();
    this.unsubComplete = null;
  }

  serialize(): WorkAtSerialized {
    return {
      config: { ...this.config, arrivalTile: { ...this.config.arrivalTile } },
      runtime: { ...this.runtime },
      inner: this.inner
        ? { kind: this.inner.kind, data: this.inner.serialize() }
        : null,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────

  private subscribeCompletion(npcId: string): void {
    if (this.unsubComplete) return;
    this.unsubComplete = onShiftComplete(this.config.businessId, (id) => {
      if (id !== npcId) return;
      // Service is done with us; our handle (if we still hold it) was
      // transferred away on accept, so don't try to release it here.
      this.handle = null;
      if (this.runtime.phase === "working") {
        this.runtime.phase = "done";
      }
    });
  }

  private attemptClockIn(npc: NpcAgent, ctx: ActivityCtx): void {
    const service = getStaffService(this.config.businessId);
    if (!service) {
      // Business interior not loaded / service not running. Fall back to the
      // abstract shift timer so the agent isn't stuck at the door forever.
      this.releaseHeldHandle();
      this.runtime.phase = "abstractWorking";
      this.runtime.abstractRemainingMinutes = defaultAbstract(this.config);
      return;
    }
    if (!this.handle) {
      this.handle = ctx.claimBody(npc, CLAIMANT);
    }
    const result = service.clockIn(npc, this.handle, this.config.roleId);
    if (result.kind === "accepted") {
      // Service has transferred the handle internally; our reference is now
      // stale. Drop it.
      this.handle = null;
      this.runtime.phase = "working";
      return;
    }
    // rejected
    this.runtime.failure = true;
    this.releaseHeldHandle();
    this.runtime.phase = "done";
  }

  private releaseHeldHandle(): void {
    if (!this.handle) return;
    try { this.handle.release(); } catch (_e) { /* ignore */ }
    this.handle = null;
  }
}

/** Module-level helper so `CustomerSim` can drive shift completion through
 *  the same path during `stop()` teardown. Re-exported here for convenience —
 *  internally just calls the staffService event emitter. */
export function notifyShiftCompleteFromStaff(
  businessId: string,
  npcId: string,
): void {
  emitShiftComplete(businessId, npcId);
}

export function deserializeWorkAt(data: unknown): Activity {
  const s = data as Partial<WorkAtSerialized>;
  if (!s.config || !s.runtime) {
    throw new Error("deserializeWorkAt: missing config/runtime");
  }
  let inner: GoToActivity | null = null;
  if (s.inner && s.inner.kind === "goTo") {
    inner = deserializeGoTo(s.inner.data) as GoToActivity;
  }
  return new WorkAtActivity(
    s.config,
    { ...s.runtime },
    inner,
  );
}
