import { calendarContextFor } from "../calendar/calendar";
import { npcRegistry, setMidnightPreReplanHook } from "../npcRegistry";
import { festivalForDay, getForcedFestival } from "./festivalRegistry";
import { buildFestivalPlanForAgent } from "./festivalPlanBuilder";

/** Phase 5: midnight festival override. Hooked into the registry's midnight
 *  pre-replan slot; runs *before* the per-archetype midnight replanner so
 *  the festival plan wins. Returns the set of agent ids whose plans were
 *  replaced — the registry's per-archetype loop skips those.
 *
 *  Tourists are out of scope: they spawn through the dispatcher, which
 *  picks up festival-day spawn-group overrides separately. */
let wired = false;

export function wireFestivalReplanner(): void {
  if (wired) return;
  wired = true;
  setMidnightPreReplanHook((dayCount) => {
    const replanned = new Set<string>();
    const calendar = calendarContextFor(dayCount);
    const festival = getForcedFestival() ?? festivalForDay(calendar);
    if (!festival) return replanned;
    for (const agent of npcRegistry.allAgents()) {
      if (agent.flags.unregisterOnPlanExhaustion) continue;
      const plan = buildFestivalPlanForAgent(agent, festival, dayCount);
      if (!plan || plan.length === 0) continue;
      npcRegistry.replaceDayPlan(agent.id, plan);
      replanned.add(agent.id);
    }
    return replanned;
  });
}

// Auto-wire on module load. Multiple imports are no-ops via the `wired` flag.
wireFestivalReplanner();
