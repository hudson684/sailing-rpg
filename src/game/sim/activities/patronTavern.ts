import { BaseActivity } from "./activity";
import type { Activity, ActivityCtx } from "./activity";
import type { BodyHandle } from "../bodyHandle";
import type { NpcAgent } from "../npcAgent";
import type { WorldLocation } from "../location";
import { GoToActivity, deserializeGoTo } from "./goTo";
import {
  emitPatronComplete,
  getPatronService,
  onPatronComplete,
} from "../../business/customerSim/patronService";

export interface PatronTavernConfig {
  readonly businessId: string;
  /** Inside-the-tavern arrival tile — the patron walks here before
   *  requesting a seat. Typically the interior entry tile. */
  readonly arrivalTile: WorldLocation;
  /** Live walk speed for the inner GoTo. */
  readonly liveSpeedPxPerSec?: number;
  /** Sim-minutes spent in the tavern when running purely abstractly (player
   *  not in scene). Mirrors the median in-tavern dwell of the live FSM
   *  (queue → order → walk → eat → pay → leave ≈ 35–45 in-game minutes when
   *  scaled at the current SIM_RATE). Tunable. */
  readonly abstractDwellMinutes?: number;
  /** Extra sim-minutes the patron will wait at the door if `requestSeat`
   *  returns `Queued{eta}` before giving up and marking the visit failed.
   *  Note: queue eta is in *real* milliseconds (it's a wall-clock estimate);
   *  this slack is in sim-minutes (matching the abstract clock). */
  readonly queueSlackMinutes?: number;
}

type Phase =
  | "goingToDoor"
  | "queuedAtDoor"
  | "inside"
  | "abstractDining"
  | "done";

interface PatronTavernRuntime {
  phase: Phase;
  /** Set on rejected / queue timeout / service vanished mid-meal. The
   *  registry treats activities as opaque on completion so this is for
   *  later phases (planner re-plan on failure). Phase 5 just marks done. */
  failure: boolean;
  /** Sim-minutes remaining in `queuedAtDoor` before giving up. */
  queueDeadlineMinutes: number;
  /** Sim-minutes remaining in `abstractDining`. Live mode never reads this
   *  (the service drives until completion fires). */
  abstractDiningRemaining: number;
}

interface PatronTavernSerialized {
  config: PatronTavernConfig;
  runtime: PatronTavernRuntime;
  inner: { kind: string; data: unknown } | null;
}

const CLAIMANT = { name: "PatronTavern" };
const DEFAULT_ABSTRACT_DWELL_MIN = 40;
const DEFAULT_QUEUE_SLACK_MIN = 5;

function defaultAbstract(config: PatronTavernConfig): number {
  return config.abstractDwellMinutes ?? DEFAULT_ABSTRACT_DWELL_MIN;
}

/** Top-level activity: walk to a tavern, hand body to the patron service,
 *  resume when service signals completion. First delegated activity — the
 *  pattern this proves out is reused in Phase 8 for `WorkAt(staff)`.
 *
 *  Live mode wires through to a real seat→order→eat→pay→leave FSM owned by
 *  `CustomerSim` (via `patronService`). Abstract mode is a duration timer:
 *  the player isn't watching, so the dwell collapses to the median of the
 *  live FSM's path. */
export class PatronTavernActivity extends BaseActivity {
  readonly kind = "patronTavern";

  private handle: BodyHandle | null = null;
  private inner: GoToActivity | null;
  private unsubComplete: (() => void) | null = null;

  constructor(
    public readonly config: PatronTavernConfig,
    private runtime: PatronTavernRuntime,
    inner: GoToActivity | null,
  ) {
    super();
    this.inner = inner;
  }

  /** Build a `PatronTavernActivity` for `npc`, planning an inner `GoTo` from
   *  the agent's current location to `config.arrivalTile`. Returns null if
   *  no route exists (no portal connecting source and destination scenes). */
  static plan(
    npc: NpcAgent,
    config: PatronTavernConfig,
  ): PatronTavernActivity | null {
    const goTo = GoToActivity.plan(npc, config.arrivalTile, {
      ...(config.liveSpeedPxPerSec !== undefined
        ? { liveSpeedPxPerSec: config.liveSpeedPxPerSec }
        : {}),
    });
    if (!goTo) return null;
    return new PatronTavernActivity(
      config,
      {
        phase: "goingToDoor",
        failure: false,
        queueDeadlineMinutes: 0,
        abstractDiningRemaining: 0,
      },
      goTo,
    );
  }

  isComplete(): boolean {
    return this.runtime.phase === "done";
  }

  override enter(npc: NpcAgent, ctx: ActivityCtx): void {
    if (this.runtime.phase === "goingToDoor" && this.inner) {
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

    if (this.runtime.phase === "goingToDoor" && this.inner) {
      this.inner.tickAbstract(npc, ctx, simMinutes);
      if (this.inner.isComplete()) {
        try { this.inner.exit(npc, ctx); } catch (_e) { /* ignore */ }
        this.inner = null;
        // Without a live ctx we can't request a seat (no body handle to
        // transfer); collapse into the abstract dwell timer.
        this.runtime.phase = "abstractDining";
        this.runtime.abstractDiningRemaining = defaultAbstract(this.config);
      }
      return;
    }

    if (this.runtime.phase === "queuedAtDoor") {
      this.runtime.queueDeadlineMinutes -= simMinutes;
      if (this.runtime.queueDeadlineMinutes <= 0) {
        this.runtime.failure = true;
        this.releaseHeldHandle();
        this.runtime.phase = "done";
      }
      return;
    }

    if (this.runtime.phase === "abstractDining") {
      this.runtime.abstractDiningRemaining -= simMinutes;
      if (this.runtime.abstractDiningRemaining <= 0) {
        this.runtime.phase = "done";
      }
      return;
    }
    // "inside": service-driven; abstract tick is a no-op while player is
    // watching. Completion arrives via the onPatronComplete listener.
  }

  override tickLive(npc: NpcAgent, ctx: ActivityCtx, dtMs: number): void {
    if (this.runtime.phase === "done") return;
    const live = ctx.live;
    if (!live) return;

    if (this.runtime.phase === "goingToDoor" && this.inner) {
      this.inner.tickLive(npc, ctx, dtMs);
      if (this.inner.isComplete()) {
        try { this.inner.exit(npc, ctx); } catch (_e) { /* ignore */ }
        this.inner = null;
        this.attemptRequestSeat(npc, ctx);
      }
      return;
    }

    if (this.runtime.phase === "abstractDining") {
      // Player just walked into the scene mid-dwell. Take over with a real
      // service seat request.
      this.attemptRequestSeat(npc, ctx);
      return;
    }

    if (this.runtime.phase === "queuedAtDoor") {
      // Convert dt to sim-minutes via 1 real-second-ish ≈ ? — abstract
      // clock is the canonical timer here. Live deadline countdown uses a
      // simple wall-clock conversion so the deadline still fires when the
      // player is watching. SIM_RATE in this codebase makes 1 real second ≈
      // some sim-minutes; rather than reach for that constant, decrement by
      // dtMs/1000 sim-minutes (slow-but-survives — the abstract tick will
      // catch up between hour ticks).
      this.runtime.queueDeadlineMinutes -= dtMs / 1000;
      if (this.runtime.queueDeadlineMinutes <= 0) {
        this.runtime.failure = true;
        this.releaseHeldHandle();
        this.runtime.phase = "done";
        return;
      }
      // Hold idle and retry; service may have freed a slot.
      if (this.handle) this.handle.setAnim("idle");
      this.attemptRequestSeat(npc, ctx);
      return;
    }
    // "inside": service drives via the BodyHandle it transferred in.
    // Activity sits idle until onPatronComplete arrives.
  }

  materialize(npc: NpcAgent, ctx: ActivityCtx): void {
    // Subscribe to completion if scene reload reattached us — `enter` may
    // not run on reload.
    this.subscribeCompletion(npc.id);
    if (this.runtime.phase === "goingToDoor" && this.inner?.materialize) {
      this.inner.materialize(npc, ctx);
    }
  }

  dematerialize(npc: NpcAgent, ctx: ActivityCtx): void {
    if (this.inner?.dematerialize) {
      try { this.inner.dematerialize(npc, ctx); } catch (_e) { /* ignore */ }
    }
    if (this.runtime.phase === "inside") {
      // Player left the scene mid-meal. The CustomerSim is being torn down
      // (its `stop()` will release our patron + emit completion). Nothing
      // we need to do beyond letting that fire — the listener marks us done.
    }
    this.unsubComplete?.();
    this.unsubComplete = null;
  }

  serialize(): PatronTavernSerialized {
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
    this.unsubComplete = onPatronComplete(this.config.businessId, (id) => {
      if (id !== npcId) return;
      // Service is done with us; our handle (if we still hold it) was
      // transferred away on accept, so don't try to release it here.
      this.handle = null;
      if (this.runtime.phase === "inside") {
        this.runtime.phase = "done";
      }
    });
  }

  private attemptRequestSeat(npc: NpcAgent, ctx: ActivityCtx): void {
    const service = getPatronService(this.config.businessId);
    if (!service) {
      // Tavern not loaded / service not running. Fall back to abstract
      // dwell so the agent isn't stuck at the door forever.
      this.releaseHeldHandle();
      this.runtime.phase = "abstractDining";
      this.runtime.abstractDiningRemaining = defaultAbstract(this.config);
      return;
    }
    if (!this.handle) {
      this.handle = ctx.claimBody(npc, CLAIMANT);
    }
    const result = service.requestSeat(npc, this.handle);
    if (result.kind === "accepted") {
      // Service has transferred the handle internally; our reference is
      // now stale. Drop it.
      this.handle = null;
      this.runtime.phase = "inside";
      return;
    }
    if (result.kind === "queued") {
      const slack = this.config.queueSlackMinutes ?? DEFAULT_QUEUE_SLACK_MIN;
      const etaMinutes = Math.max(0, result.etaMs) / 60_000;
      this.runtime.queueDeadlineMinutes = etaMinutes + slack;
      this.runtime.phase = "queuedAtDoor";
      if (this.handle) this.handle.setAnim("idle");
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

/** Module-level helper so `CustomerSim` can drive completion through the
 *  same path during `stop()` teardown. Re-exported here for convenience —
 *  internally just calls the patronService event emitter. */
export function notifyPatronCompleteFromTavern(
  businessId: string,
  npcId: string,
): void {
  emitPatronComplete(businessId, npcId);
}

export function deserializePatronTavern(data: unknown): Activity {
  const s = data as Partial<PatronTavernSerialized>;
  if (!s.config || !s.runtime) {
    throw new Error("deserializePatronTavern: missing config/runtime");
  }
  let inner: GoToActivity | null = null;
  if (s.inner && s.inner.kind === "goTo") {
    inner = deserializeGoTo(s.inner.data) as GoToActivity;
  }
  return new PatronTavernActivity(
    s.config,
    { ...s.runtime },
    inner,
  );
}
