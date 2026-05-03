import { TILE_SIZE } from "../../constants";
import { bus } from "../../bus";
import { businesses, businessKinds } from "../registry";
import { useBusinessStore } from "../businessStore";
import { getHireable, spritePackSourceNpc } from "../hireables";
import { worldAnchors, businessArrivalAnchorKey } from "../../sim/planner/anchors";
import { residences } from "../../sim/planner/residences";
import { npcRegistry, registerReplanner } from "../../sim/npcRegistry";
import { GoToActivity } from "../../sim/activities/goTo";
import { WorkAtActivity } from "../../sim/activities/workAt";
import { SleepActivity } from "../../sim/activities/sleep";
import type { Activity } from "../../sim/activities/activity";
import type { NpcAgent } from "../../sim/npcAgent";
import type { BusinessId } from "../businessTypes";
import { npcRegistryStaff } from "./staffService";

/** Phase 8 hire bootstrap: when `npcRegistryStaff` is enabled and a residence
 *  is authored for a hire, register an NpcAgent with a baseline daily plan
 *  and remove it on fire. Without an authored residence (or with the flag
 *  off), this is a no-op — the legacy synthetic-spawn path inside
 *  `CustomerSim.reconcileStaffSchedule` runs unchanged.
 *
 *  The agent's id matches the synthesizeStaffNpc convention
 *  (`npc:staff:<bizId>:<hireableId>`) so `CustomerSim.clockInImpl` can
 *  recover the hireable id from the npc id, and the role-agent refresh
 *  picks up the model in the entity registry transparently. */

const SHIFT_MIN = 480; // 8 in-game hours — fallback for businesses with no schedule

/** Ids of agents this bootstrap has registered, so we can reconcile against
 *  the current `state.staff` snapshot per business. Keyed by `businessId →
 *  Set<npcId>`. */
const registered = new Map<BusinessId, Set<string>>();

function staffNpcId(businessId: string, hireableId: string): string {
  return `npc:staff:${businessId}:${hireableId}`;
}

/** Sim-minute window when staff are needed at the business. Falls back to
 *  the Phase 8 fixed durations if the business has no schedule (e.g. an
 *  always-open service). */
function shiftWindowFor(businessId: string): { startMin: number; endMin: number } {
  const def = businesses.tryGet(businessId);
  const schedule = def?.schedule;
  if (!schedule) {
    // No schedule = always open. Use a daytime block centered on noon.
    return { startMin: 480, endMin: 480 + SHIFT_MIN };
  }
  // statusForPhase uses (phase, elapsedInPhaseMs) — we don't have direct
  // access to the day-open boundary. Approximate: the day phase is 06:00–
  // 22:00 in the existing time system; pull the schedule's open/close out
  // of the def directly when present.
  const open = (def?.schedule as { openMinute?: number } | undefined)?.openMinute ?? 480;
  const close = (def?.schedule as { closeMinute?: number } | undefined)?.closeMinute ?? 480 + SHIFT_MIN;
  return { startMin: open, endMin: close };
}

/** Build the daily plan for a hired staffer, calendar-aligned. Sleep
 *  durations are derived from the actual business schedule so the staffer
 *  rests until ~start-of-shift and goes home after the close edge. The
 *  midnight re-plan loop calls this fresh every day. */
function buildDayPlan(opts: {
  businessId: string;
  roleId: string;
  home: ReturnType<typeof residences.get>;
  workArrival: ReturnType<typeof worldAnchors.get>;
}): Activity[] | null {
  const { businessId, roleId, home, workArrival } = opts;
  if (!home || !workArrival) return null;
  const { startMin, endMin } = shiftWindowFor(businessId);
  const shiftMinutes = Math.max(60, endMin - startMin);
  // Pre-shift sleep: from "midnight + 0" until shift start (capped to keep
  // the plan small). Post-shift sleep: from shift end through to next
  // midnight, again capped.
  const preSleep = Math.max(60, Math.min(720, startMin));
  const postSleep = Math.max(60, Math.min(720, 1440 - endMin));
  // Plan-time synthetic agent: GoTo.plan / WorkAt.plan only read .location.
  const plannerNpc: NpcAgent = {
    id: "_planner",
    archetypeId: "_planner",
    body: { px: 0, py: 0, facing: home.facing, anim: "idle", spriteKey: "" },
    location: { ...home },
    dayPlan: [],
    currentActivityIndex: 0,
    currentActivity: null,
    traits: {},
    flags: {},
    inventory: [],
  };
  const plan: Activity[] = [];
  plan.push(SleepActivity.create({ home: { ...home }, durationMinutes: preSleep }));
  const goToWork = WorkAtActivity.plan(plannerNpc, {
    businessId,
    roleId,
    arrivalTile: { ...workArrival },
    abstractShiftMinutes: shiftMinutes,
  });
  if (!goToWork) return null;
  plan.push(goToWork);
  plannerNpc.location = { ...workArrival };
  const goHome = GoToActivity.plan(plannerNpc, { ...home });
  if (!goHome) return null;
  plan.push(goHome);
  plan.push(SleepActivity.create({ home: { ...home }, durationMinutes: postSleep }));
  return plan;
}

function registerStaffAgent(
  businessId: string,
  hireableId: string,
  roleId: string,
): boolean {
  const home = residences.get(hireableId);
  if (!home) return false;
  const def = businesses.tryGet(businessId);
  if (!def) return false;
  const arrival =
    worldAnchors.get(businessArrivalAnchorKey(businessId)) ??
    worldAnchors.get(businessArrivalAnchorKey(def.interiorKey));
  if (!arrival) return false;
  const dayPlan = buildDayPlan({ businessId, roleId, home, workArrival: arrival });
  if (!dayPlan || dayPlan.length === 0) return false;

  const id = staffNpcId(businessId, hireableId);
  if (npcRegistry.get(id)) npcRegistry.unregister(id);

  const hireable = getHireable(hireableId);
  const sourceNpc = hireable ? spritePackSourceNpc(hireable.spritePack) : null;
  const spriteKey = sourceNpc?.spritePackId ?? sourceNpc?.id ?? "";

  const agent: NpcAgent = {
    id,
    archetypeId: `staff:${roleId}`,
    body: {
      px: (home.tileX + 0.5) * TILE_SIZE,
      py: (home.tileY + 0.5) * TILE_SIZE,
      facing: home.facing,
      anim: "idle",
      spriteKey,
    },
    location: { ...home },
    dayPlan,
    currentActivityIndex: 0,
    currentActivity: null,
    traits: {},
    flags: {},
    inventory: [],
  };
  npcRegistry.register(agent);
  let set = registered.get(businessId);
  if (!set) { set = new Set(); registered.set(businessId, set); }
  set.add(id);
  return true;
}


function reconcileBusiness(businessId: string): void {
  if (!npcRegistryStaff.enabled) return;
  const def = businesses.tryGet(businessId);
  if (!def) return;
  const kind = businessKinds.tryGet(def.kindId);
  if (!kind) return;
  const state = useBusinessStore.getState().get(businessId);
  if (!state || !state.owned) {
    // Business no longer owned — drop every agent we registered for it.
    const set = registered.get(businessId);
    if (set) {
      for (const id of [...set]) {
        if (npcRegistry.get(id)) npcRegistry.unregister(id);
      }
      registered.delete(businessId);
    }
    return;
  }
  const desired = new Set<string>();
  for (const hire of state.staff) {
    desired.add(staffNpcId(businessId, hire.hireableId));
  }
  const current = registered.get(businessId) ?? new Set<string>();
  // Drop fired hires.
  for (const id of [...current]) {
    if (!desired.has(id)) {
      if (npcRegistry.get(id)) npcRegistry.unregister(id);
      current.delete(id);
    }
  }
  // Register new hires that have a residence + arrival anchor.
  for (const hire of state.staff) {
    const id = staffNpcId(businessId, hire.hireableId);
    if (current.has(id)) continue;
    if (registerStaffAgent(businessId, hire.hireableId, hire.roleId)) {
      current.add(id);
    }
  }
  if (current.size === 0) registered.delete(businessId);
  else registered.set(businessId, current);
}

let initialized = false;

/** Idempotent installer; safe under HMR. Subscribes to `business:staffChanged`
 *  and reconciles registered staff agents with the live hire state. Also
 *  reconciles every owned business once at startup so a save loaded with
 *  staff already hired registers their agents on first load.
 *
 *  Also registers a midnight replanner under the `staff:` archetype prefix
 *  so every persistent staff agent rebuilds its day plan against the
 *  business schedule each new day. */
export function initStaffAgentBootstrap(): void {
  if (initialized) return;
  initialized = true;
  bus.onTyped("business:staffChanged", ({ businessId }) => {
    reconcileBusiness(businessId);
  });
  registerReplanner("staff:", (agent, _dayCount) => {
    void _dayCount;
    // Recover (businessId, hireableId) from the agent id format the
    // bootstrap mints: `npc:staff:<bizId>:<hireableId>`.
    const parts = agent.id.split(":");
    if (parts.length < 4 || parts[0] !== "npc" || parts[1] !== "staff") return null;
    const businessId = parts[2];
    const hireableId = parts.slice(3).join(":");
    const state = useBusinessStore.getState().get(businessId);
    if (!state) return null;
    const hire = state.staff.find((s) => s.hireableId === hireableId);
    if (!hire) return null;
    const home = residences.get(hireableId);
    const def = businesses.tryGet(businessId);
    const arrival =
      worldAnchors.get(businessArrivalAnchorKey(businessId)) ??
      (def ? worldAnchors.get(businessArrivalAnchorKey(def.interiorKey)) : null);
    if (!home || !arrival) return null;
    return buildDayPlan({ businessId, roleId: hire.roleId, home, workArrival: arrival }) ?? null;
  });
}


/** Force a reconcile pass for every owned business. Called by WorldScene
 *  after world anchors + residences have been registered (chunk-ready), so
 *  the bootstrap sees the spawn data it needs. */
export function reconcileAllStaffAgents(): void {
  if (!npcRegistryStaff.enabled) return;
  const ids = useBusinessStore.getState().ownedIds();
  for (const id of ids) reconcileBusiness(id);
}

/** Snapshot for the dev console. */
export function listRegisteredStaffAgents(): ReadonlyArray<{
  businessId: string;
  npcIds: string[];
}> {
  return [...registered.entries()].map(([businessId, set]) => ({
    businessId,
    npcIds: [...set],
  }));
}
