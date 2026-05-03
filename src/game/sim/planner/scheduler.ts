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
  getSchedule,
  type ArchetypeDef,
  type ScheduleDef,
  type ScheduleTemplate,
  type TemplateTarget,
} from "./archetypes";
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

/** Pure planner. Given an archetype, the calendar, and where the agent will
 *  spawn, produces a deterministic ordered list of activities for the day.
 *
 *  Phase 6 scope: emits `GoTo` legs to anchor each chosen activity, and
 *  `PatronTavern` for tavern visits. `wander` / `browse` / `idle` templates
 *  collapse to a `NoopActivity` dwell at the target tile (Phase 7 replaces
 *  this with real Wander / Browse / Idle activities). Any template whose
 *  anchor is unresolved is skipped — the planner never produces a `GoTo` to
 *  nowhere. */
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
      activities.push(act);
      chosenTemplateIds.push(template.id);
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
      if (!sameTile) {
        const goTo = GoToActivity.plan(planningNpc(cursor), target, {
          liveSpeedPxPerSec: DEFAULT_LIVE_SPEED_PX_PER_SEC,
        });
        if (!goTo) { skippedTemplateIds.push(template.id); continue; }
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
        if (!businessId) { skippedTemplateIds.push(template.id); continue; }
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
        if (!businessId) { skippedTemplateIds.push(template.id); continue; }
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
      activities.push(dwell);
      chosenTemplateIds.push(template.id);
      cursor = { ...target };
      continue;
    }

    if (template.kind === "goTo") {
      const goTo = GoToActivity.plan(planningNpc(cursor), target, {
        liveSpeedPxPerSec: DEFAULT_LIVE_SPEED_PX_PER_SEC,
      });
      if (!goTo) { skippedTemplateIds.push(template.id); continue; }
      activities.push(goTo);
      chosenTemplateIds.push(template.id);
      cursor = { ...target };
      continue;
    }

    skippedTemplateIds.push(template.id);
  }

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

  return { activities, chosenTemplateIds, skippedTemplateIds };
}

/** Convenience wrapper that looks up the archetype + schedule by id. Returns
 *  null if either is missing (logged at the call site, not here). */
export function planDayById(
  archetypeId: string,
  calendar: CalendarContext,
  ctx: PlannerCtx,
  seed?: number,
): PlanResult | null {
  const archetype = getArchetype(archetypeId);
  if (!archetype) return null;
  const schedule = getSchedule(archetype.scheduleId);
  if (!schedule) return null;
  const s = seed ?? (hashSeed(ctx.npcId) ^ calendar.dayCount);
  return planDay(archetype, schedule, calendar, ctx, s);
}

export function makePlanSeed(npcId: string, dayCount: number): number {
  return hashSeed(npcId) ^ dayCount;
}

export type { Rng };
