import type { CalendarContext } from "../calendar/calendar";
import type { Activity } from "../activities/activity";
import type { WorldLocation } from "../location";
import type { NpcAgent } from "../npcAgent";
import { GoToActivity } from "../activities/goTo";
import { PatronTavernActivity } from "../activities/patronTavern";
import { IdleActivity } from "../activities/idle";
import { BrowseActivity } from "../activities/browse";
import { StandAroundActivity } from "../activities/standAround";
import { WanderActivity } from "../activities/wander";
import { DEFAULT_BROWSE_GROUP_ID } from "./browseWaypoints";
import { DEFAULT_STANDING_GROUP_ID } from "./standingSpots";
import {
  businessArrivalAnchorKey,
  namedTileAnchorKey,
  worldAnchors,
} from "./anchors";
import {
  getArchetype,
  getScheduleBundle,
  type ArchetypeDef,
  type ScheduleDef,
  type ScheduleTemplate,
  type TemplateTarget,
} from "./archetypes";
import {
  resolveScheduleVariant,
  type ResolvedScheduleDef,
} from "./scheduleResolver";
import { hashSeed, mulberry32, pickWeighted, randInt, randRange, type Rng } from "./rng";

export interface PlannerCtx {
  /** Where this NPC arrives (and, if `mustEndAt: spawnPoint`, departs to). */
  readonly spawnPoint: WorldLocation;
  /** Per-NPC stable id; combined with `dayCount` to seed planning. */
  readonly npcId: string;
}

export interface PlanResult {
  readonly activities: Activity[];
  /** Templates that resolved cleanly and contributed an activity. Useful for
   *  dev console / logging. */
  readonly chosenTemplateIds: readonly string[];
  /** Templates rejected during planning (kind unsupported, anchor missing,
   *  etc.). Used by tests; visible in the dev console. */
  readonly skippedTemplateIds: readonly string[];
}

const DEFAULT_LIVE_SPEED_PX_PER_SEC = 36;
const DEFAULT_WANDER_RADIUS_TILES = 4;

function resolveTarget(
  target: TemplateTarget,
  spawnPoint: WorldLocation,
): WorldLocation | null {
  switch (target.kind) {
    case "spawnPoint":
      return { ...spawnPoint };
    case "businessArrival":
      return worldAnchors.get(businessArrivalAnchorKey(target.businessId));
    case "namedTile":
      return worldAnchors.get(namedTileAnchorKey(target.name));
  }
}

function inWindow(template: ScheduleTemplate, _calendar: CalendarContext): boolean {
  if (!template.windowMinute) return true;
  const [lo, hi] = template.windowMinute;
  return hi > lo;
}

/** Phase 3: a "step" is one template's contribution to the activity list —
 *  optionally a GoTo (the approach) plus the dwell/work activity. The
 *  hard-arrival anchor pass walks these to pad/trim/drop as needed. */
interface PlanStep {
  templateId: string;
  /** Index of the GoTo activity in `activities`, or -1 when this step had
   *  no approach (already at the target tile). */
  goToIndex: number;
  /** Index of the dwell activity (Browse/Idle/Wander/StandAround/PatronTavern). -1 if none. */
  dwellIndex: number;
  /** Estimated GoTo walk minutes. 0 when there's no GoTo. */
  walkMinutes: number;
  /** Estimated dwell minutes. PatronTavern uses its abstract-dwell default. */
  dwellMinutes: number;
  /** When set, the dwell must START at this sim-minute-of-day. Drives
   *  pad/trim/drop decisions in the anchor pass. */
  mustStartAt?: number;
  /** Cursor at the START of this step (i.e. agent's location before the
   *  GoTo). Needed to construct an Idle padding activity at the right tile. */
  cursorBefore: WorldLocation;
}

/** Phase 3: trim tolerance — how many sim-minutes of overrun we'll absorb by
 *  shrinking earlier flexible dwells. Past this we drop the hard-anchored
 *  template entirely (with a dev-console warning). */
const HARD_ARRIVAL_TRIM_TOLERANCE_MINUTES = 30;

/** Phase 3: how big a tail-end Idle padding will be allowed before we cap it.
 *  Avoids a malformed schedule producing a 14-hour wait. */
const HARD_ARRIVAL_PAD_CAP_MINUTES = 24 * 60;

/** Pure planner. Given an archetype, the calendar, and where the agent will
 *  spawn, produces a deterministic ordered list of activities for the day.
 *
 *  Templates with `mustStartAt` get anchored to that sim-minute via padding
 *  (Idle insertion) or trimming of preceding flexible dwells. The seeded
 *  RNG runs *before* the anchor pass, so identical seeds produce identical
 *  plans even after Phase 3 lands. */
export function planDay(
  archetype: ArchetypeDef,
  schedule: ScheduleDef,
  calendar: CalendarContext,
  ctx: PlannerCtx,
  /** Stable seed for this (npc, day) pair. Use `hashSeed(npcId) ^ dayCount`
   *  if you don't have a more specific seed. */
  seed: number,
): PlanResult {
  void archetype;
  const rng = mulberry32(seed);
  const [minN, maxN] = schedule.constraints.totalActivitiesRange ?? [3, 5];
  const targetCount = randInt(rng, Math.max(1, minN), Math.max(minN, maxN));

  const eligibleTemplates = schedule.templates.filter((t) => inWindow(t, calendar));

  const activities: Activity[] = [];
  const steps: PlanStep[] = [];
  const chosenTemplateIds: string[] = [];
  const skippedTemplateIds: string[] = [];

  // The agent's "where it currently is" cursor as we lay out activities. Used
  // to insert implicit GoTo legs between non-adjacent locations.
  let cursor: WorldLocation = { ...ctx.spawnPoint };

  // Surrogate NPC for `GoToActivity.plan` / `PatronTavernActivity.plan` —
  // they only read `location`, so we carry just enough fields to avoid a real
  // registry lookup.
  const planningNpc = (loc: WorldLocation): NpcAgent =>
    ({
      id: ctx.npcId,
      archetypeId: archetype.id,
      body: { px: 0, py: 0, facing: loc.facing, anim: "idle", spriteKey: "" },
      location: loc,
      dayPlan: [],
      currentActivityIndex: 0,
      currentActivity: null,
      traits: {},
      flags: {},
      inventory: [],
    }) as NpcAgent;

  for (let i = 0; i < targetCount; i++) {
    const template = pickWeighted(rng, eligibleTemplates, (t) => Math.max(0, t.weight));
    if (!template) break;

    const target = resolveTarget(template.target, ctx.spawnPoint);
    if (!target) { skippedTemplateIds.push(template.id); continue; }

    const cursorBefore: WorldLocation = { ...cursor };

    if (template.kind === "patronTavern") {
      // PatronTavern composes its own GoTo internally (it knows about
      // cross-scene portals and a queue/seat handshake). The planner doesn't
      // need to prepend an explicit approach.
      const businessId =
        template.target.kind === "businessArrival" ? template.target.businessId : "";
      if (!businessId) { skippedTemplateIds.push(template.id); continue; }
      const act = PatronTavernActivity.plan(planningNpc(cursor), {
        businessId,
        arrivalTile: target,
        liveSpeedPxPerSec: DEFAULT_LIVE_SPEED_PX_PER_SEC,
      });
      if (!act) { skippedTemplateIds.push(template.id); continue; }
      const dwellIndex = activities.length;
      activities.push(act);
      chosenTemplateIds.push(template.id);
      // Estimate: PatronTavern bundles its own walk inside; for anchoring
      // purposes treat the walk as 0 (the activity owns timing).
      steps.push({
        templateId: template.id,
        goToIndex: -1,
        dwellIndex,
        walkMinutes: 0,
        dwellMinutes: 40, // matches DEFAULT_ABSTRACT_DWELL_MIN
        ...(template.mustStartAt != null ? { mustStartAt: template.mustStartAt } : {}),
        cursorBefore,
      });
      cursor = { ...target };
      continue;
    }

    if (
      template.kind === "wander" ||
      template.kind === "idle" ||
      template.kind === "browse" ||
      template.kind === "standAround"
    ) {
      // Approach if not already at the target tile.
      const sameTile =
        cursor.sceneKey === target.sceneKey &&
        cursor.tileX === target.tileX &&
        cursor.tileY === target.tileY;
      let goToIndex = -1;
      let walkMinutes = 0;
      if (!sameTile) {
        const goTo = GoToActivity.plan(planningNpc(cursor), target, {
          liveSpeedPxPerSec: DEFAULT_LIVE_SPEED_PX_PER_SEC,
        });
        if (!goTo) { skippedTemplateIds.push(template.id); continue; }
        goToIndex = activities.length;
        walkMinutes = goTo.estimatedWalkMinutes();
        activities.push(goTo);
      }
      const [lo, hi] = template.duration ?? [10, 20];
      const minutes = Math.max(1, randRange(rng, lo, hi));

      let dwell: Activity;
      if (template.kind === "browse") {
        // Browse only makes sense addressed to a businessId — fall through to
        // skipped on `namedTile` / `spawnPoint` mistakes in schedule data.
        const businessId =
          template.target.kind === "businessArrival" ? template.target.businessId : "";
        if (!businessId) {
          // Roll back the GoTo we may have already pushed for this step.
          if (goToIndex >= 0) activities.length = goToIndex;
          skippedTemplateIds.push(template.id);
          continue;
        }
        dwell = BrowseActivity.create({
          businessId,
          browseGroupId: template.browseGroupId ?? DEFAULT_BROWSE_GROUP_ID,
          durationMinutes: minutes,
        });
      } else if (template.kind === "standAround") {
        // Same shape as browse — only makes sense at a business arrival so it
        // can resolve a standing-spot pool.
        const businessId =
          template.target.kind === "businessArrival" ? template.target.businessId : "";
        if (!businessId) {
          if (goToIndex >= 0) activities.length = goToIndex;
          skippedTemplateIds.push(template.id);
          continue;
        }
        dwell = StandAroundActivity.create({
          businessId,
          standingGroupId: template.standingGroupId ?? DEFAULT_STANDING_GROUP_ID,
          durationMinutes: minutes,
        });
      } else if (template.kind === "wander") {
        dwell = WanderActivity.create({
          home: { ...target },
          radiusTiles: template.wanderRadiusTiles ?? DEFAULT_WANDER_RADIUS_TILES,
          moveSpeed: DEFAULT_LIVE_SPEED_PX_PER_SEC,
          pauseMs: 1500,
          stepMs: 4000,
          durationMinutes: minutes,
        });
      } else {
        dwell = IdleActivity.create({
          area: { ...target },
          durationMinutes: minutes,
        });
      }
      const dwellIndex = activities.length;
      activities.push(dwell);
      chosenTemplateIds.push(template.id);
      steps.push({
        templateId: template.id,
        goToIndex,
        dwellIndex,
        walkMinutes,
        dwellMinutes: minutes,
        ...(template.mustStartAt != null ? { mustStartAt: template.mustStartAt } : {}),
        cursorBefore,
      });
      cursor = { ...target };
      continue;
    }

    if (template.kind === "goTo") {
      const goTo = GoToActivity.plan(planningNpc(cursor), target, {
        liveSpeedPxPerSec: DEFAULT_LIVE_SPEED_PX_PER_SEC,
      });
      if (!goTo) { skippedTemplateIds.push(template.id); continue; }
      const goToIndex = activities.length;
      const walkMinutes = goTo.estimatedWalkMinutes();
      activities.push(goTo);
      chosenTemplateIds.push(template.id);
      steps.push({
        templateId: template.id,
        goToIndex,
        dwellIndex: -1,
        walkMinutes,
        dwellMinutes: 0,
        ...(template.mustStartAt != null ? { mustStartAt: template.mustStartAt } : {}),
        cursorBefore,
      });
      cursor = { ...target };
      continue;
    }

    skippedTemplateIds.push(template.id);
  }

  // Phase 3: hard-arrival anchor pass. Walks `steps` in order, padding
  // (Idle insertion) or trimming earlier flexible dwells so each
  // hard-anchored step's dwell starts at exactly its `mustStartAt`. Any
  // step that can't fit is dropped with a dev-console warning.
  const anchorNotes = applyHardArrivalAnchors(activities, steps, ctx);

  // mustEndAt — append a final GoTo back to the named anchor so the agent
  // ends the day in a believable place. For tourists this is the spawn point
  // (the docks); on completion they're unregistered by the dispatcher.
  if (schedule.constraints.mustEndAt === "spawnPoint") {
    const sameTile =
      cursor.sceneKey === ctx.spawnPoint.sceneKey &&
      cursor.tileX === ctx.spawnPoint.tileX &&
      cursor.tileY === ctx.spawnPoint.tileY;
    if (!sameTile) {
      const depart = GoToActivity.plan(planningNpc(cursor), ctx.spawnPoint, {
        liveSpeedPxPerSec: DEFAULT_LIVE_SPEED_PX_PER_SEC,
      });
      if (depart) activities.push(depart);
    }
  }

  // Phase 4: stash plan annotations for the dev overlay's drilldown.
  if (anchorNotes.length > 0) {
    for (const note of anchorNotes) {
      _logPlanNote(`[plan] ${ctx.npcId}: ${note}`);
    }
  }
  _setPlanAnnotation(ctx.npcId, {
    resolvedKey: (schedule as ResolvedScheduleDef).resolvedKey ?? null,
    notes: anchorNotes,
  });

  return { activities, chosenTemplateIds, skippedTemplateIds };
}

/** Phase 3: walk the step list in order, anchor any `mustStartAt` step to
 *  exact start time. Returns human-readable notes describing pad/trim/drop
 *  decisions. Mutates `activities` in place. */
function applyHardArrivalAnchors(
  activities: Activity[],
  steps: PlanStep[],
  ctx: PlannerCtx,
): string[] {
  const notes: string[] = [];
  if (steps.every((s) => s.mustStartAt === undefined)) return notes;

  // Day starts at minute 0; the dispatcher / midnight replanner runs at
  // wall-clock midnight, so this matches the actual schedule.
  let currentTime = 0;
  // Indexes into `activities` shift as we splice in Idle padding. Track an
  // adjustment we apply to each step's recorded indices.
  let indexShift = 0;

  for (const step of steps) {
    const goToIndex = step.goToIndex >= 0 ? step.goToIndex + indexShift : -1;
    const dwellIndex = step.dwellIndex >= 0 ? step.dwellIndex + indexShift : -1;
    const expectedArrival = currentTime + step.walkMinutes;

    if (step.mustStartAt === undefined) {
      currentTime = expectedArrival + step.dwellMinutes;
      continue;
    }

    const target = step.mustStartAt;
    const overrun = expectedArrival - target;

    if (overrun <= 1e-6) {
      // Pad with an Idle inserted *before* the GoTo (so the agent waits at
      // their previous location, not in transit). When there's no GoTo,
      // padding goes immediately before the dwell.
      const padMinutes = Math.min(target - expectedArrival, HARD_ARRIVAL_PAD_CAP_MINUTES);
      if (padMinutes > 0) {
        const insertAt = goToIndex >= 0 ? goToIndex : dwellIndex;
        const padArea = step.cursorBefore;
        const padding = IdleActivity.create({
          area: { ...padArea },
          durationMinutes: padMinutes,
          paceRadiusTiles: 0,
        });
        activities.splice(insertAt, 0, padding);
        indexShift += 1;
        notes.push(
          `padded ${padMinutes.toFixed(0)}m before ${step.templateId} (mustStartAt ${target})`,
        );
      }
      // After padding, dwell starts exactly at mustStartAt, runs dwellMinutes.
      // Wire the GoTo's `mustArriveBy` so the abstract overshoot teleport
      // catches a slow walk.
      if (goToIndex >= 0) {
        const go = activities[goToIndex + 1] as GoToActivity | undefined;
        // After the splice, the GoTo moved to goToIndex + 1.
        if (go && go.kind === "goTo") {
          // Mutate config in place — the field is readonly externally but we
          // own this freshly-created activity.
          (go.config as { mustArriveBy?: number }).mustArriveBy = target;
        }
      }
      currentTime = target + step.dwellMinutes;
    } else if (overrun <= HARD_ARRIVAL_TRIM_TOLERANCE_MINUTES) {
      // Within tolerance: trim earlier flexible dwells. Walk back over
      // prior steps (excluding hard-anchored ones), shrinking
      // dwellMinutes until the overrun is absorbed. We can't physically
      // shrink already-built activities here without reaching into their
      // configs; instead we just log and warn — the GoTo's mustArriveBy
      // teleport recovers at runtime.
      notes.push(
        `arrived ${overrun.toFixed(0)}m late at ${step.templateId} (target ${target}); abstract overshoot will teleport-recover`,
      );
      if (goToIndex >= 0) {
        const go = activities[goToIndex] as GoToActivity | undefined;
        if (go && go.kind === "goTo") {
          (go.config as { mustArriveBy?: number }).mustArriveBy = target;
        }
      }
      currentTime = target + step.dwellMinutes;
    } else {
      // Overrun beyond tolerance: drop the step entirely. Splice out the
      // GoTo + dwell from `activities`.
      const removeStart = goToIndex >= 0 ? goToIndex : dwellIndex;
      const removeCount =
        (goToIndex >= 0 ? 1 : 0) + (dwellIndex >= 0 ? 1 : 0);
      if (removeStart >= 0 && removeCount > 0) {
        activities.splice(removeStart, removeCount);
        indexShift -= removeCount;
      }
      notes.push(
        `dropped ${step.templateId}: overrun ${overrun.toFixed(0)}m exceeds ${HARD_ARRIVAL_TRIM_TOLERANCE_MINUTES}m tolerance (target ${target})`,
      );
      // currentTime unchanged — the dropped step contributes nothing.
    }
  }

  void ctx;
  return notes;
}

/** Convenience wrapper that looks up the archetype + schedule by id. Returns
 *  null if either is missing (logged at the call site, not here). Resolves
 *  the schedule bundle's variant for the given calendar/weather/flags before
 *  planning — pass `weather: null` for now until the weather system exists. */
export function planDayById(
  archetypeId: string,
  calendar: CalendarContext,
  ctx: PlannerCtx,
  seed?: number,
  resolverInputs?: {
    weather?: string | null;
    worldFlags?: ReadonlySet<string>;
    agentFlags?: ReadonlyMap<string, boolean>;
    friendship?: (npcId: string) => number;
  },
): PlanResult | null {
  const archetype = getArchetype(archetypeId);
  if (!archetype) return null;
  const bundle = getScheduleBundle(archetype.scheduleId);
  if (!bundle) return null;
  const variant = resolveScheduleVariant({
    bundle,
    calendar,
    weather: resolverInputs?.weather ?? null,
    worldFlags: resolverInputs?.worldFlags,
    agentFlags: resolverInputs?.agentFlags,
    friendship: resolverInputs?.friendship,
  });
  if (!variant) return null;
  const s = seed ?? (hashSeed(ctx.npcId) ^ calendar.dayCount);
  return planDay(archetype, variant, calendar, ctx, s);
}

/** Phase 3: dev-only log buffer. Most-recent-first; capped. Each entry is a
 *  one-line note about plan padding/trim/drop decisions made at midnight, so
 *  authors can tune `mustStartAt` densities. */
const PLAN_LOG_LIMIT = 256;
const planLog: string[] = [];

export function _logPlanNote(note: string): void {
  planLog.unshift(note);
  if (planLog.length > PLAN_LOG_LIMIT) planLog.length = PLAN_LOG_LIMIT;
}

export function getPlanLog(): readonly string[] { return planLog; }
export function clearPlanLog(): void { planLog.length = 0; }

/** Phase 4: per-agent plan annotations. Each agent's last successful plan
 *  records (a) which schedule variant resolved and (b) any padding/trim
 *  notes from phase 3. Reset on every replan. The dev overlay reads this. */
interface PlanAnnotation {
  resolvedKey: string | null;
  notes: string[];
}
const planAnnotations = new Map<string, PlanAnnotation>();

export function _setPlanAnnotation(npcId: string, ann: PlanAnnotation): void {
  planAnnotations.set(npcId, ann);
}

export function getPlanAnnotation(npcId: string): PlanAnnotation | null {
  return planAnnotations.get(npcId) ?? null;
}

export function clearPlanAnnotation(npcId: string): void {
  planAnnotations.delete(npcId);
}

/** Re-export the resolved variant type for callers that want to inspect it. */
export type { ResolvedScheduleDef };

export function makePlanSeed(npcId: string, dayCount: number): number {
  return hashSeed(npcId) ^ dayCount;
}

export type { Rng };
