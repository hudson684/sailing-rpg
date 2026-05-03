import { TILE_SIZE } from "../../constants";
import { bus } from "../../bus";
import { calendarContextFor, type CalendarContext } from "../calendar/calendar";
import { useTimeStore } from "../../time/timeStore";
import { minuteOfDay } from "../../time/constants";
import type { NpcAgent } from "../npcAgent";
import type { WorldLocation } from "../location";
import { npcRegistry } from "../npcRegistry";
import { spawnPointAnchorKey, worldAnchors } from "./anchors";
import { getArchetype, getSpawnGroup, listSpawnGroupIds, type SpawnGroupDef } from "./archetypes";
import { hashSeed, mulberry32, randInt, randRange } from "./rng";
import { planDay, makePlanSeed, type PlannerCtx } from "./scheduler";
import { getSchedule } from "./archetypes";

/** Per-day, per-group state. Built at midnight (or when the first spawn point
 *  registers after midnight). Each `pendingArrivals` entry is a sim-minute-
 *  of-day at which an agent should be spawned at the group's anchor. */
interface DaySchedule {
  dayCount: number;
  pendingArrivals: number[];
  spawnedCount: number;
}

interface RegisteredSpawnPoint {
  spawnGroupId: string;
  location: WorldLocation;
}


class SpawnDispatcher {
  /** Spawn points registered by the world load (chunk-ready). One entry per
   *  Tiled `npcSpawnPoint` object encountered. */
  private spawnPoints: RegisteredSpawnPoint[] = [];
  private daySchedules = new Map<string, DaySchedule>();
  private wired = false;

  registerSpawnPoint(spawnGroupId: string, location: WorldLocation): void {
    if (!getSpawnGroup(spawnGroupId)) {
      // Surface but don't throw — a one-off authoring slip shouldn't kill the
      // world load. The build-time validator (`tools/validate-spawn-refs.mjs`)
      // is the authoritative gate.
      // eslint-disable-next-line no-console
      console.warn(
        `[spawnDispatcher] Tiled npcSpawnPoint references unknown spawnGroupId '${spawnGroupId}' — skipping`,
      );
      return;
    }
    this.spawnPoints.push({ spawnGroupId, location: { ...location } });
    worldAnchors.set(spawnPointAnchorKey(spawnGroupId), location);

    // If midnight already fired today (e.g. world reloaded mid-day), give the
    // newly-registered point a chance to honor today's pending arrivals.
    this.flushPending(this.currentCalendar());
  }

  /** Called by WorldScene at the start of `init` so a hot reload doesn't
   *  retain stale spawn points from a prior session. The day schedules are
   *  intentionally preserved — the player's clock didn't rewind. */
  clearSpawnPoints(): void {
    this.spawnPoints = [];
  }

  /** Drop the current day's plan — used by tests and the dev console. */
  resetDaySchedules(): void {
    this.daySchedules.clear();
  }

  /** Internal: ensure today has a plan for every group. Idempotent. */
  ensureDaySchedules(calendar: CalendarContext): void {
    for (const groupId of listSpawnGroupIds()) {
      const existing = this.daySchedules.get(groupId);
      if (existing && existing.dayCount === calendar.dayCount) continue;
      const group = getSpawnGroup(groupId);
      if (!group) continue;
      const seed = hashSeed(`${groupId}|day`) ^ calendar.dayCount;
      const rng = mulberry32(seed);
      const weight = group.dayWeights[calendar.dayOfWeek] ?? 1.0;
      const scaled = Math.max(0, Math.round(group.arrivalsPerDay * weight));
      const pending: number[] = [];
      for (let i = 0; i < scaled; i++) {
        const m = randRange(
          rng,
          group.arrivalWindow.earliestMinute,
          group.arrivalWindow.latestMinute,
        );
        pending.push(Math.floor(m));
      }
      pending.sort((a, b) => a - b);
      this.daySchedules.set(groupId, {
        dayCount: calendar.dayCount,
        pendingArrivals: pending,
        spawnedCount: 0,
      });
    }
  }

  /** Spawn any arrivals whose scheduled minute has passed (current clock).
   *  Called on hour ticks and when a new spawn point registers. */
  flushPending(calendar: CalendarContext): void {
    if (this.spawnPoints.length === 0) return;
    const now = currentMinuteOfDay();
    this.ensureDaySchedules(calendar);
    for (const [groupId, schedule] of this.daySchedules) {
      if (schedule.dayCount !== calendar.dayCount) continue;
      while (schedule.pendingArrivals.length > 0 && schedule.pendingArrivals[0] <= now) {
        schedule.pendingArrivals.shift();
        const arrivalIndex = schedule.spawnedCount;
        schedule.spawnedCount += 1;
        const point = this.pickPointFor(groupId);
        if (!point) break;
        const group = getSpawnGroup(groupId);
        if (!group) continue;
        this.spawnArrival(group, point.location, calendar, arrivalIndex);
      }
    }
  }

  /** Build an `NpcAgent`, run the planner, and register it. The agent's
   *  `flags.unregisterOnPlanExhaustion` opts into the registry's default
   *  removal-on-exhaustion behavior — Phase 6's tourists are ephemeral.
   *
   *  `arrivalIndex` is the per-day, per-group ordinal of this arrival. The
   *  resulting npc id (`agent:<archetype>:day<dayCount>:i<arrivalIndex>`) is
   *  stable across reloads, which means a save mid-day rebuilds the same
   *  arrival schedule and we can detect "this arrival already spawned" by
   *  checking the registry — instead of double-registering and throwing. */
  spawnArrival(
    group: SpawnGroupDef,
    location: WorldLocation,
    calendar: CalendarContext,
    arrivalIndex: number,
  ): NpcAgent | null {
    const archetype = getArchetype(group.archetype);
    if (!archetype) {
      // eslint-disable-next-line no-console
      console.warn(`[spawnDispatcher] unknown archetype '${group.archetype}'`);
      return null;
    }
    // Id starts with "npc:" so the SceneNpcBinder's
    // `entityRegistry.get(agent.id)` lookup matches the synthetic NpcModel
    // the entities-layer listener creates for this agent. NpcModel forces
    // its own `id = "npc:" + def.id`, so def.id below drops the prefix.
    const id = `npc:${group.archetype}:day${calendar.dayCount}:i${arrivalIndex}`;
    // eslint-disable-next-line no-console
    console.log(
      `[spawnDispatcher] spawn attempt: ${id} group='${group.id}' at ` +
        `${location.sceneKey} (${location.tileX},${location.tileY}) ` +
        `minute=${minuteOfDay(useTimeStore.getState().phase, useTimeStore.getState().elapsedInPhaseMs).toFixed(0)}`,
    );
    if (npcRegistry.get(id)) {
      // eslint-disable-next-line no-console
      console.log(`[spawnDispatcher]   ↳ skipped: '${id}' already registered (post-hydrate replay)`);
      return null;
    }
    const ctx: PlannerCtx = { spawnPoint: { ...location }, npcId: id };
    const schedule = getSchedule(archetype.scheduleId);
    if (!schedule) {
      // eslint-disable-next-line no-console
      console.warn(`[spawnDispatcher] missing schedule '${archetype.scheduleId}' for archetype '${archetype.id}'`);
      return null;
    }
    const seed = makePlanSeed(id, calendar.dayCount);
    const plan = planDay(archetype, schedule, calendar, ctx, seed);

    if (plan.activities.length === 0) {
      // Nothing to do — drop the agent before registering so the world stays
      // tidy (better than spawning an immediately-departing visitor).
      // eslint-disable-next-line no-console
      console.warn(
        `[spawnDispatcher] empty plan for ${group.archetype} (skipped templates: ${plan.skippedTemplateIds.join(",") || "none"}) — not spawning`,
      );
      return null;
    }

    const px = (location.tileX + 0.5) * TILE_SIZE;
    const py = (location.tileY + 0.5) * TILE_SIZE;
    const agent: NpcAgent = {
      id,
      archetypeId: archetype.id,
      body: {
        px,
        py,
        facing: location.facing,
        anim: "idle",
        spriteKey: archetype.spriteSet,
      },
      location: { ...location },
      dayPlan: plan.activities,
      currentActivityIndex: 0,
      currentActivity: null,
      traits: { ...archetype.defaultTraits },
      flags: { unregisterOnPlanExhaustion: true },
      inventory: [],
    };
    npcRegistry.register(agent);
    // eslint-disable-next-line no-console
    console.log(
      `[spawnDispatcher]   ↳ registered: ${id} dayPlan=[${plan.activities.map((a) => a.kind).join(",")}] ` +
        `(skipped templates: ${plan.skippedTemplateIds.join(",") || "none"})`,
    );
    return agent;
  }

  private pickPointFor(spawnGroupId: string): RegisteredSpawnPoint | null {
    // Round-robin would need persistent state; for Phase 6 the simplest is to
    // pick the first registered point for the group. There's only ever one
    // per group authored.
    for (const p of this.spawnPoints) if (p.spawnGroupId === spawnGroupId) return p;
    return null;
  }

  private currentCalendar(): CalendarContext {
    return calendarContextFor(useTimeStore.getState().dayCount);
  }

  /** Subscribe to time bus events. Called once at module load. */
  wire(): void {
    if (this.wired) return;
    this.wired = true;
    bus.onTyped("time:midnight", ({ calendar }) => {
      // Always rebuild today's schedule on midnight, regardless of whether
      // spawn points have registered yet (they may register seconds later in
      // the chunk-load pipeline). `flushPending` handles the actual spawning.
      this.ensureDaySchedules(calendar);
      this.flushPending(calendar);
    });
    bus.onTyped("time:hourTick", ({ dayCount }) => {
      this.flushPending(calendarContextFor(dayCount));
    });
  }

  /** Snapshot for the dev console. */
  debugSnapshot(): {
    spawnPoints: ReadonlyArray<{ groupId: string; loc: WorldLocation }>;
    daySchedules: ReadonlyArray<{ groupId: string; pending: readonly number[]; spawned: number }>;
  } {
    return {
      spawnPoints: this.spawnPoints.map((p) => ({ groupId: p.spawnGroupId, loc: { ...p.location } })),
      daySchedules: [...this.daySchedules.entries()].map(([groupId, s]) => ({
        groupId,
        pending: [...s.pendingArrivals],
        spawned: s.spawnedCount,
      })),
    };
  }
}

function currentMinuteOfDay(): number {
  const t = useTimeStore.getState();
  return minuteOfDay(t.phase, t.elapsedInPhaseMs);
}

export const spawnDispatcher = new SpawnDispatcher();
spawnDispatcher.wire();

// Log every scene transition for any tourist-archetype agent. Cheap
// O(events) cost; fires only on actual cross-scene moves.
npcRegistry.on("npcEnteredScene", (sceneKey, npc) => {
  if (!npc.archetypeId.startsWith("tourist")) return;
  // eslint-disable-next-line no-console
  console.log(
    `[tourist] ${npc.id} entered ${sceneKey} ` +
      `tile=(${npc.location.tileX},${npc.location.tileY}) ` +
      `activity=${npc.currentActivity?.kind ?? "(none)"} ` +
      `idx=${npc.currentActivityIndex}/${npc.dayPlan.length}`,
  );
});
npcRegistry.on("npcLeftScene", (sceneKey, npc) => {
  if (!npc.archetypeId.startsWith("tourist")) return;
  // eslint-disable-next-line no-console
  console.log(`[tourist] ${npc.id} left ${sceneKey}`);
});

/** Re-exported for the dev console. */
export { randInt };
