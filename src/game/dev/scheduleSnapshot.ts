// Phase 4: snapshot of every NPC for the dev overlay. Pure read; no
// mutations. Lives in `dev/` so production builds tree-shake it; the
// overlay scene gates its registration behind `import.meta.env.DEV`.

import { npcRegistry } from "../sim/npcRegistry";
import { useTimeStore } from "../time/timeStore";
import { minuteOfDay } from "../time/constants";
import { getPlanAnnotation } from "../sim/planner/scheduler";
import type { NpcAgent } from "../sim/npcAgent";

export interface ScheduleSnapshotRow {
  readonly npcId: string;
  readonly archetypeId: string;
  readonly scene: string;
  readonly mode: "live" | "abstract";
  readonly currentActivity: string;
  readonly nextActivity: string | null;
  readonly etaMinutes: number | null;
  readonly bodyTile: { readonly x: number; readonly y: number };
  readonly flags: readonly string[];
  /** Phase 4: which schedule variant key resolved for this agent's
   *  current day plan (e.g. "Sunday", "rain", "default"). Null when the
   *  plan was built outside the resolver path (legacy NpcDef wander/patrol). */
  readonly resolvedKey: string | null;
  /** Phase 3 padding/trim/drop notes for this agent's current plan. */
  readonly planNotes: readonly string[];
}

function describeActivityKind(k: string | undefined | null): string {
  if (!k) return "(none)";
  return k;
}

function flagSummary(flags: Record<string, boolean>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(flags)) {
    if (v) out.push(k);
  }
  return out.sort();
}

function deriveMode(agent: NpcAgent, activeSceneKey: string | null): "live" | "abstract" {
  return activeSceneKey && agent.location.sceneKey === activeSceneKey ? "live" : "abstract";
}

/** Phase 4: build one row per registered agent. The `activeSceneKey` is
 *  the scene the player is currently in — agents in that scene tick live;
 *  every other agent ticks abstractly. Pass `null` if no scene is active. */
export function captureScheduleSnapshot(activeSceneKey: string | null): ScheduleSnapshotRow[] {
  const t = useTimeStore.getState();
  const nowMin = minuteOfDay(t.phase, t.elapsedInPhaseMs);
  const agents = npcRegistry.allAgents();
  const rows: ScheduleSnapshotRow[] = [];
  for (const a of agents) {
    const next = a.dayPlan[a.currentActivityIndex + 1] ?? null;
    const ann = getPlanAnnotation(a.id);
    rows.push({
      npcId: a.id,
      archetypeId: a.archetypeId,
      scene: a.location.sceneKey,
      mode: deriveMode(a, activeSceneKey),
      currentActivity: describeActivityKind(a.currentActivity?.kind),
      nextActivity: next ? next.kind : null,
      etaMinutes: estimateEta(a, nowMin),
      bodyTile: { x: a.location.tileX, y: a.location.tileY },
      flags: flagSummary(a.flags),
      resolvedKey: ann?.resolvedKey ?? null,
      planNotes: ann?.notes ?? [],
    });
  }
  rows.sort((a, b) => (a.scene < b.scene ? -1 : a.scene > b.scene ? 1 : a.npcId < b.npcId ? -1 : 1));
  return rows;
}

/** Cheap ETA estimate: for activities with a `remainingMinutes` field
 *  (Idle/Browse/StandAround/Wander), report it. For GoTo, report the
 *  estimated remaining walk minutes. Otherwise null. */
function estimateEta(agent: NpcAgent, _nowMin: number): number | null {
  const act = agent.currentActivity;
  if (!act) return null;
  // Cheaply read serialized state to extract a remaining-minutes value
  // without each activity having to expose a typed accessor. Cost is
  // one JSON-shaped object allocation per agent per refresh.
  const ser = act.serialize() as { runtime?: { remainingMinutes?: number; legElapsedMinutes?: number } } | null;
  if (ser && typeof ser === "object" && ser.runtime) {
    if (typeof ser.runtime.remainingMinutes === "number") {
      return Math.max(0, Math.round(ser.runtime.remainingMinutes));
    }
  }
  // GoTo: best-effort estimate via the activity's own helper.
  if (act.kind === "goTo" && "estimatedWalkMinutes" in act) {
    const est = (act as unknown as { estimatedWalkMinutes(): number }).estimatedWalkMinutes();
    return Math.max(0, Math.round(est));
  }
  return null;
}

/** Phase 4: a stable-by-id snapshot built only when the agent set
 *  changes. Cheap incremental refresh of just the volatile columns
 *  (mode, current activity, eta) follows. */
export function describeAgentVerbose(agent: NpcAgent): {
  npcId: string;
  archetypeId: string;
  scene: string;
  resolvedKey: string | null;
  planNotes: readonly string[];
  dayPlan: Array<{ kind: string; data: unknown }>;
  currentActivityIndex: number;
} {
  const ann = getPlanAnnotation(agent.id);
  return {
    npcId: agent.id,
    archetypeId: agent.archetypeId,
    scene: agent.location.sceneKey,
    resolvedKey: ann?.resolvedKey ?? null,
    planNotes: ann?.notes ?? [],
    dayPlan: agent.dayPlan.map((a) => ({ kind: a.kind, data: a.serialize() })),
    currentActivityIndex: agent.currentActivityIndex,
  };
}
