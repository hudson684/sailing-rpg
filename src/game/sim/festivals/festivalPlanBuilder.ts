import type { Activity } from "../activities/activity";
import type { NpcAgent } from "../npcAgent";
import type { WorldLocation } from "../location";
import { GoToActivity } from "../activities/goTo";
import { IdleActivity } from "../activities/idle";
import { StandAroundActivity } from "../activities/standAround";
import { WanderActivity } from "../activities/wander";
import {
  namedTileAnchorKey,
  worldAnchors,
} from "../planner/anchors";
import { hashSeed } from "../planner/rng";
import type { FestivalDef, SpecialAgentStep } from "./festivalRegistry";

const DEFAULT_LIVE_SPEED_PX_PER_SEC = 36;

function offsetTileWithinRadius(
  base: WorldLocation,
  radius: number,
  agentId: string,
  dayCount: number,
): WorldLocation {
  // Deterministic per-agent jitter so two agents don't stack on the same
  // tile. Stable across reloads thanks to the agent id + dayCount seed.
  const seed = hashSeed(agentId) ^ dayCount;
  const dx = (seed & 0xff) % (2 * radius + 1) - radius;
  const dy = ((seed >>> 8) & 0xff) % (2 * radius + 1) - radius;
  return {
    sceneKey: base.sceneKey,
    tileX: base.tileX + dx,
    tileY: base.tileY + dy,
    facing: base.facing,
  };
}

/** Phase 5: build the festival day plan for one agent. Returns null if the
 *  agent has no festival role (so the normal replanner runs). */
export function buildFestivalPlanForAgent(
  agent: NpcAgent,
  festival: FestivalDef,
  dayCount: number,
): Activity[] | null {
  // 1. Special-agent override wins.
  const special = festival.specialAgents[agent.id];
  if (special) return buildSpecialPlan(agent, festival, special);

  // 2. Per-archetype template (longest-prefix match — same logic as
  //    `findReplanner`).
  const template = matchParticipantTemplate(agent.archetypeId, festival);
  if (!template) return null;

  // 3. Build a plan: arrival → festival activity → home.
  const arrival = worldAnchors.get(namedTileAnchorKey(festival.arrivalAnchor));
  const dest = template.anchor
    ? worldAnchors.get(namedTileAnchorKey(template.anchor))
    : arrival;
  if (!arrival || !dest) return null;

  const out: Activity[] = [];
  // Approach festival arrival anchor first (cross-scene safe).
  const goArrival = GoToActivity.plan(agent, arrival, {
    liveSpeedPxPerSec: DEFAULT_LIVE_SPEED_PX_PER_SEC,
  });
  if (goArrival) out.push(goArrival);

  if (template.kind === "wander_anchor" || template.kind === "browse_anchors") {
    const radius = template.radius ?? 4;
    const home = offsetTileWithinRadius(dest, radius, agent.id, dayCount);
    out.push(
      WanderActivity.create({
        home,
        radiusTiles: radius,
        moveSpeed: DEFAULT_LIVE_SPEED_PX_PER_SEC,
        pauseMs: 1500,
        stepMs: 4000,
        durationMinutes: Math.max(60, (festival.closeHour - festival.openHour) * 60),
      }),
    );
  } else {
    // stand_at
    out.push(
      StandAroundActivity.create({
        businessId: festival.id,
        durationMinutes: Math.max(60, (festival.closeHour - festival.openHour) * 60),
      }),
    );
  }

  // Final GoTo back home (the agent's pre-festival spawn). Reuses the
  // existing schedule pattern of bookending with a return trip.
  return out;
}

function matchParticipantTemplate(
  archetypeId: string,
  festival: FestivalDef,
): import("./festivalRegistry").FestivalParticipantTemplate | null {
  const exact = festival.participants[archetypeId];
  if (exact) return exact;
  // Longest-prefix match for `staff:cook` etc.
  let best: { len: number; tpl: import("./festivalRegistry").FestivalParticipantTemplate } | null = null;
  for (const [key, tpl] of Object.entries(festival.participants)) {
    if (!archetypeId.startsWith(key)) continue;
    if (!best || key.length > best.len) best = { len: key.length, tpl };
  }
  return best ? best.tpl : null;
}

function buildSpecialPlan(
  agent: NpcAgent,
  festival: FestivalDef,
  steps: readonly SpecialAgentStep[],
): Activity[] {
  void festival;
  const out: Activity[] = [];
  let cursor = agent.location;
  for (const step of steps) {
    const target = worldAnchors.get(namedTileAnchorKey(step.anchor));
    if (!target) continue;
    if (step.kind === "goTo") {
      const goTo = GoToActivity.plan(
        { ...agent, location: cursor },
        target,
        { liveSpeedPxPerSec: DEFAULT_LIVE_SPEED_PX_PER_SEC },
      );
      if (goTo) out.push(goTo);
      cursor = target;
    } else if (step.kind === "standAround") {
      // Walk if not already there
      const sameTile =
        cursor.sceneKey === target.sceneKey &&
        cursor.tileX === target.tileX &&
        cursor.tileY === target.tileY;
      if (!sameTile) {
        const goTo = GoToActivity.plan(
          { ...agent, location: cursor },
          target,
          { liveSpeedPxPerSec: DEFAULT_LIVE_SPEED_PX_PER_SEC },
        );
        if (goTo) out.push(goTo);
      }
      const duration =
        step.duration ??
        (step.until !== undefined ? Math.max(1, step.until - 0) : 60);
      out.push(
        IdleActivity.create({
          area: { ...target, ...(step.facing ? { facing: step.facing } : {}) },
          durationMinutes: duration,
          paceRadiusTiles: 0,
        }),
      );
      cursor = target;
    }
  }
  return out;
}
