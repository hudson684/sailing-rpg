import { bus } from "../bus";
import { calendarContextFor } from "./calendar/calendar";
import { useTimeStore } from "../time/timeStore";
import { minuteOfDay } from "../time/constants";
import {
  BodyHandle,
  createBodyHandle,
  type BodyHandleRegistry,
} from "./bodyHandle";
import type { Activity, ActivityCtx } from "./activities/activity";
import { deserializeActivity } from "./activities/registry";
import type { ItemStack, NpcAgent, ReadonlyBody } from "./npcAgent";
import type { SceneKey, WorldLocation } from "./location";

export type SceneEvent = "npcEnteredScene" | "npcLeftScene";
export type SceneEventHandler = (sceneKey: SceneKey, npc: NpcAgent) => void;

export interface RegistrySnapshot {
  schemaVersion: number;
  agents: Array<{
    id: string;
    archetypeId: string;
    location: WorldLocation;
    body: ReadonlyBody;
    dayPlan: Array<{ kind: string; data: unknown }>;
    currentActivityIndex: number;
    currentActivityState: { kind: string; data: unknown } | null;
    traits: Record<string, unknown>;
    flags: Record<string, boolean>;
    inventory: ItemStack[];
  }>;
}

const SCHEMA_VERSION = 1;

export class NpcRegistry implements BodyHandleRegistry {
  private readonly agents = new Map<string, NpcAgent>();
  private readonly bySceneKey = new Map<SceneKey, Set<string>>();
  /** npcId → currently-valid handle (or null when nothing has claimed it). */
  private readonly drivers = new Map<string, BodyHandle | null>();
  private readonly listeners = new Map<SceneEvent, Set<SceneEventHandler>>();

  // ── Public surface ─────────────────────────────────────────────────

  register(agent: NpcAgent): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`NpcRegistry: agent '${agent.id}' is already registered`);
    }
    this.agents.set(agent.id, agent);
    this.drivers.set(agent.id, null);
    this.indexLocation(agent.id, null, agent.location.sceneKey);
    // Synchronous pre-emit hook: the entities-layer model factory runs here
    // so the SceneNpcBinder's `npcEnteredScene` listener sees the NpcModel
    // already in `entityRegistry` and can pair a proxy on first emit. Order
    // matters — without this, dispatcher-spawned tourists were invisible
    // because the binder's listener (registered at scene attach) fired
    // before agentBinding's listener (registered when bootstrapNpcs loaded
    // later in WorldScene.create).
    if (preEmitRegister) preEmitRegister(agent);
    this.emit("npcEnteredScene", agent.location.sceneKey, agent);

    // First activity, if planned.
    if (!agent.currentActivity && agent.dayPlan.length > 0) {
      agent.currentActivityIndex = Math.max(
        0,
        Math.min(agent.dayPlan.length - 1, agent.currentActivityIndex),
      );
      agent.currentActivity = agent.dayPlan[agent.currentActivityIndex];
    }
    if (agent.currentActivity) {
      agent.currentActivity.enter(agent, this.makeCtx());
    }
  }

  unregister(npcId: string): void {
    const agent = this.agents.get(npcId);
    if (!agent) return;
    if (agent.currentActivity) {
      try { agent.currentActivity.exit(agent, this.makeCtx()); } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[NpcRegistry] exit threw for '${npcId}':`, e);
      }
    }
    this.agents.delete(npcId);
    this.drivers.delete(npcId);
    this.indexLocation(npcId, agent.location.sceneKey, null);
    this.emit("npcLeftScene", agent.location.sceneKey, agent);
  }

  get(npcId: string): NpcAgent | undefined { return this.agents.get(npcId); }

  /** Snapshot of every registered agent. Returned as an array (not an
   *  iterator) so callers can mutate the registry mid-iteration without
   *  invalidating their loop. */
  allAgents(): NpcAgent[] { return [...this.agents.values()]; }

  /** Swap an agent's `dayPlan` for a freshly-built one and reset the cursor
   *  to the first activity. Used by the midnight re-plan loop for persistent
   *  agents (hired staff, authored townsfolk). The current activity (if any)
   *  is `exit()`-ed first; the new first activity is `enter()`-ed.
   *  No-op if the agent isn't registered. */
  replaceDayPlan(npcId: string, dayPlan: Activity[]): void {
    const agent = this.agents.get(npcId);
    if (!agent) return;
    const ctx = this.makeCtx();
    if (agent.currentActivity) {
      try { agent.currentActivity.exit(agent, ctx); } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[NpcRegistry] exit threw on replan for '${npcId}':`, e);
      }
    }
    // Defensive: if an activity transfer left the body claimed, drop the
    // claim so the next activity can take it cleanly.
    this.drivers.set(agent.id, null);
    agent.dayPlan = dayPlan;
    agent.currentActivityIndex = 0;
    agent.currentActivity = dayPlan.length > 0 ? dayPlan[0] : null;
    if (agent.currentActivity) {
      try { agent.currentActivity.enter(agent, ctx); } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[NpcRegistry] enter threw on replan for '${npcId}':`, e);
      }
    }
  }

  npcsAt(sceneKey: SceneKey | string): readonly NpcAgent[] {
    const set = this.bySceneKey.get(sceneKey as SceneKey);
    if (!set) return [];
    const out: NpcAgent[] = [];
    for (const id of set) {
      const a = this.agents.get(id);
      if (a) out.push(a);
    }
    return out;
  }

  setLocation(npcId: string, loc: WorldLocation): void {
    const agent = this.agents.get(npcId);
    if (!agent) throw new Error(`NpcRegistry: setLocation on unknown npc '${npcId}'`);
    const prev = agent.location.sceneKey;
    agent.location = loc;
    if (prev !== loc.sceneKey) {
      this.indexLocation(npcId, prev, loc.sceneKey);
      // Order: leftScene first, then enteredScene.
      this.emit("npcLeftScene", prev, agent);
      this.emit("npcEnteredScene", loc.sceneKey, agent);
    }
  }

  /** Claim an exclusive write handle to an agent's body. Throws if a
   *  different claimant already owns it. */
  claimBody(npc: NpcAgent, claimant: object): BodyHandle {
    const current = this.drivers.get(npc.id);
    if (current) {
      throw new Error(
        `NpcRegistry: body for '${npc.id}' is already claimed by another driver`,
      );
    }
    const handle = createBodyHandle(this, npc.id, claimant);
    this.drivers.set(npc.id, handle);
    return handle;
  }

  tickAbstract(simMinutes: number): void {
    if (simMinutes <= 0) return;
    const ctx = this.makeCtx();
    // Snapshot ids — agents may be unregistered mid-tick when activities complete.
    for (const id of [...this.agents.keys()]) {
      const agent = this.agents.get(id);
      if (!agent) continue;
      this.advanceAgent(agent, ctx, simMinutes, /*live*/ false, 0);
    }
  }

  tickLive(
    sceneKey: SceneKey,
    dtMs: number,
    live?: ActivityCtx["live"],
    opts?: { skip?: (npc: NpcAgent) => boolean },
  ): void {
    if (dtMs <= 0) return;
    const set = this.bySceneKey.get(sceneKey);
    if (!set || set.size === 0) return;
    const ctx = this.makeCtx(live);
    const skip = opts?.skip;
    for (const id of [...set]) {
      const agent = this.agents.get(id);
      if (!agent || agent.location.sceneKey !== sceneKey) continue;
      if (skip && skip(agent)) continue;
      const act = agent.currentActivity;
      if (!act) continue;
      act.tickLive(agent, ctx, dtMs);
      this.maybeAdvanceCompleted(agent, ctx);
    }
  }

  /** Call `materialize` on every active activity in `sceneKey`. Used by the
   *  scene binder when a scene becomes loaded. Activities without a
   *  `materialize` method are no-ops. */
  materializeScene(sceneKey: SceneKey, live?: ActivityCtx["live"]): void {
    const set = this.bySceneKey.get(sceneKey);
    if (!set || set.size === 0) return;
    const ctx = this.makeCtx(live);
    for (const id of [...set]) {
      const agent = this.agents.get(id);
      const act = agent?.currentActivity;
      if (!agent || !act?.materialize) continue;
      act.materialize(agent, ctx);
    }
  }

  /** Materialize a single agent's active activity. Used by the scene binder
   *  when an agent enters the active scene mid-tick (e.g. completing a
   *  `GoTo` portal traversal) — `materializeScene` only runs at scene
   *  attach time. No-op if the agent has no activity or its activity has no
   *  `materialize` hook. */
  materializeNpc(npcId: string, live?: ActivityCtx["live"]): void {
    const agent = this.agents.get(npcId);
    const act = agent?.currentActivity;
    if (!agent || !act?.materialize) return;
    act.materialize(agent, this.makeCtx(live));
  }

  /** Counterpart to `materializeNpc`. Called by the binder when the agent
   *  leaves the active scene mid-tick. */
  dematerializeNpc(npcId: string, live?: ActivityCtx["live"]): void {
    const agent = this.agents.get(npcId);
    const act = agent?.currentActivity;
    if (!agent || !act?.dematerialize) return;
    act.dematerialize(agent, this.makeCtx(live));
  }

  /** Counterpart to `materializeScene`. Called when a scene unloads. */
  dematerializeScene(sceneKey: SceneKey, live?: ActivityCtx["live"]): void {
    const set = this.bySceneKey.get(sceneKey);
    if (!set || set.size === 0) return;
    const ctx = this.makeCtx(live);
    for (const id of [...set]) {
      const agent = this.agents.get(id);
      const act = agent?.currentActivity;
      if (!agent || !act?.dematerialize) continue;
      act.dematerialize(agent, ctx);
    }
  }

  on(event: SceneEvent, handler: SceneEventHandler): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  serialize(): RegistrySnapshot {
    const agents: RegistrySnapshot["agents"] = [];
    for (const a of this.agents.values()) {
      agents.push({
        id: a.id,
        archetypeId: a.archetypeId,
        location: { ...a.location },
        body: { ...a.body },
        dayPlan: a.dayPlan.map((act) => ({ kind: act.kind, data: act.serialize() })),
        currentActivityIndex: a.currentActivityIndex,
        currentActivityState: a.currentActivity
          ? { kind: a.currentActivity.kind, data: a.currentActivity.serialize() }
          : null,
        traits: { ...a.traits },
        flags: { ...a.flags },
        inventory: a.inventory.map((s) => ({ ...s })),
      });
    }
    return { schemaVersion: SCHEMA_VERSION, agents };
  }

  hydrate(snap: RegistrySnapshot): void {
    if (snap.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `NpcRegistry: snapshot schemaVersion ${snap.schemaVersion} unsupported (expected ${SCHEMA_VERSION})`,
      );
    }
    // Clear (without firing exit handlers — hydrate replaces the whole world).
    this.agents.clear();
    this.bySceneKey.clear();
    this.drivers.clear();

    for (const s of snap.agents) {
      const dayPlan = s.dayPlan.map((p) => deserializeActivity(p.kind, p.data));
      const currentActivity = s.currentActivityState
        ? deserializeActivity(s.currentActivityState.kind, s.currentActivityState.data)
        : (dayPlan[s.currentActivityIndex] ?? null);

      const agent: NpcAgent = {
        id: s.id,
        archetypeId: s.archetypeId,
        body: { ...s.body },
        location: { ...s.location },
        dayPlan,
        currentActivityIndex: s.currentActivityIndex,
        currentActivity,
        traits: { ...s.traits },
        flags: { ...s.flags },
        inventory: s.inventory.map((it) => ({ ...it })),
      };
      this.agents.set(agent.id, agent);
      this.drivers.set(agent.id, null);
      this.indexLocation(agent.id, null, agent.location.sceneKey);
      // Same pre-emit story as `register`: give the entities layer a chance
      // to mint an NpcModel before any binder picks the agent up via
      // `npcsAt(sceneKey)`.
      if (preEmitRegister) preEmitRegister(agent);
    }
  }

  // ── BodyHandleRegistry (internal — called only by BodyHandle) ──────

  _isActiveDriver(npcId: string, handle: BodyHandle): boolean {
    return this.drivers.get(npcId) === handle;
  }

  /** Transitional bypass for the scene binder's scripted-mode mirror: while
   *  legacy NPC drivers (customerSim, staff service, cutscenes) write to
   *  `NpcModel.x/y` directly, the proxy uses this to keep the canonical body
   *  state in sync without claiming a handle. Phases 5/8 remove the need for
   *  this once those drivers go through the activity/handle path. */
  setBodyExternal(npcId: string, patch: Partial<ReadonlyBody>): void {
    const agent = this.agents.get(npcId);
    if (!agent) return;
    agent.body = { ...agent.body, ...patch };
  }

  _writeBody(npcId: string, mutate: (b: ReadonlyBody) => ReadonlyBody): void {
    const agent = this.agents.get(npcId);
    if (!agent) return;
    agent.body = mutate(agent.body);
  }

  _transferDriver(npcId: string, from: BodyHandle, toClaimant: object): BodyHandle {
    if (this.drivers.get(npcId) !== from) {
      throw new Error(`NpcRegistry: cannot transfer — handle is not the active driver of '${npcId}'`);
    }
    const next = createBodyHandle(this, npcId, toClaimant);
    this.drivers.set(npcId, next);
    return next;
  }

  _releaseDriver(npcId: string, handle: BodyHandle): void {
    if (this.drivers.get(npcId) !== handle) return;
    this.drivers.set(npcId, null);
  }

  // ── Internals ──────────────────────────────────────────────────────

  private indexLocation(npcId: string, prev: SceneKey | null, next: SceneKey | null): void {
    if (prev) {
      const set = this.bySceneKey.get(prev);
      if (set) {
        set.delete(npcId);
        if (set.size === 0) this.bySceneKey.delete(prev);
      }
    }
    if (next) {
      let set = this.bySceneKey.get(next);
      if (!set) { set = new Set(); this.bySceneKey.set(next, set); }
      set.add(npcId);
    }
  }

  private emit(event: SceneEvent, sceneKey: SceneKey, npc: NpcAgent): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try { fn(sceneKey, npc); } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[NpcRegistry] listener for '${event}' threw:`, e);
      }
    }
  }

  private makeCtx(live?: ActivityCtx["live"]): ActivityCtx {
    const t = useTimeStore.getState();
    const ctx: ActivityCtx = {
      registry: this,
      time: {
        minuteOfDay: minuteOfDay(t.phase, t.elapsedInPhaseMs),
        dayCount: t.dayCount,
      },
      calendar: calendarContextFor(t.dayCount),
      claimBody: (npc, claimant) => this.claimBody(npc, claimant),
      live,
    };
    return ctx;
  }

  private advanceAgent(
    agent: NpcAgent,
    ctx: ActivityCtx,
    simMinutes: number,
    _live: boolean,
    _dtMs: number,
  ): void {
    const act = agent.currentActivity;
    if (!act) {
      // No activity — if there's plan ahead, start it.
      this.advanceToNextActivity(agent, ctx);
      return;
    }
    act.tickAbstract(agent, ctx, simMinutes);
    this.maybeAdvanceCompleted(agent, ctx);
  }

  private maybeAdvanceCompleted(agent: NpcAgent, ctx: ActivityCtx): void {
    let safety = 16;
    while (agent.currentActivity && agent.currentActivity.isComplete() && safety-- > 0) {
      try { agent.currentActivity.exit(agent, ctx); } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[NpcRegistry] activity exit threw:`, e);
      }
      this.advanceToNextActivity(agent, ctx);
    }
  }

  private advanceToNextActivity(agent: NpcAgent, ctx: ActivityCtx): void {
    const nextIdx = agent.currentActivityIndex + 1;
    if (nextIdx < agent.dayPlan.length) {
      agent.currentActivityIndex = nextIdx;
      agent.currentActivity = agent.dayPlan[nextIdx];
      agent.currentActivity.enter(agent, ctx);
      return;
    }
    agent.currentActivity = null;
    // Day plan exhausted. Phase 6 introduces two behaviors here:
    //  - Ephemeral agents (tourists, anyone the spawn dispatcher created) opt
    //    in via `flags.unregisterOnPlanExhaustion = true` and are removed —
    //    they've left town for the day.
    //  - Persistent agents (authored townsfolk, hired staff once Phase 8 lands)
    //    fall through and idle with `currentActivity = null` until Phase 9
    //    wires per-archetype re-planning at midnight.
    if (agent.flags.unregisterOnPlanExhaustion) {
      this.unregister(agent.id);
    }
  }
}

/** Synchronous hook fired inside `register()` BEFORE `npcEnteredScene` is
 *  emitted. The entities layer wires this so an `NpcModel` exists in
 *  `entityRegistry` by the time the SceneNpcBinder's listener runs and
 *  tries to pair a proxy. Pure data layer ignores Phaser; the hook is the
 *  one place we let entities-layer state pre-stage. */
let preEmitRegister: ((agent: NpcAgent) => void) | null = null;

export function setRegisterPreEmitHook(fn: (agent: NpcAgent) => void): void {
  preEmitRegister = fn;
}

// ── Singleton, wired to the time bus ─────────────────────────────────
//
// Mirrors the bus pattern: import the module, get a global instance.
// Subscribed to `time:hourTick` because that's the finest-grained tick
// the time system currently emits. Each hour tick = 60 sim-minutes —
// cheap by design (abstract, scene-agnostic).

export const npcRegistry = new NpcRegistry();

const HOUR_SIM_MINUTES = 60;

bus.onTyped("time:hourTick", () => {
  npcRegistry.tickAbstract(HOUR_SIM_MINUTES);
});

/** Per-archetype day-plan re-roller. Registered by `staffAgentBootstrap`
 *  / `agentBinding` so persistent agents (hired staff, authored townsfolk)
 *  can rebuild their day plan at midnight without the registry knowing
 *  the archetype-specific anchor / schedule details. The registry just
 *  asks "give me a new dayPlan for this agent on this day"; null means
 *  "no schedule applies — leave the agent idle today". */
export type DayPlanReplanner = (
  agent: NpcAgent,
  dayCount: number,
) => Activity[] | null;

const replanners = new Map<string, DayPlanReplanner>();

/** Register a replanner keyed by `archetypeId`. The id can be a literal
 *  archetype id (e.g. `"tourist"`) or a per-class prefix like `"staff:cook"`
 *  — agents are matched by exact `archetypeId` first, then by the longest
 *  matching `<prefix>:` form. Returns an unsubscribe function. */
export function registerReplanner(
  archetypeId: string,
  fn: DayPlanReplanner,
): () => void {
  replanners.set(archetypeId, fn);
  return () => {
    if (replanners.get(archetypeId) === fn) replanners.delete(archetypeId);
  };
}

function findReplanner(archetypeId: string): DayPlanReplanner | null {
  const exact = replanners.get(archetypeId);
  if (exact) return exact;
  // Longest prefix match: `staff:cook` → `staff:` → `staff`.
  let best: { len: number; fn: DayPlanReplanner } | null = null;
  for (const [key, fn] of replanners) {
    if (!archetypeId.startsWith(key)) continue;
    if (!best || key.length > best.len) best = { len: key.length, fn };
  }
  return best?.fn ?? null;
}

bus.onTyped("time:midnight", ({ dayCount }) => {
  // Iterate registered persistent agents and rebuild their day plans. An
  // agent is "persistent" if it does NOT have `unregisterOnPlanExhaustion`
  // (tourists keep their dispatcher-built plan and exit when it ends).
  const agents = npcRegistry.allAgents();
  for (const agent of agents) {
    if (agent.flags.unregisterOnPlanExhaustion) continue;
    const fn = findReplanner(agent.archetypeId);
    if (!fn) continue;
    const next = fn(agent, dayCount);
    if (!next || next.length === 0) continue;
    npcRegistry.replaceDayPlan(agent.id, next);
  }
});
