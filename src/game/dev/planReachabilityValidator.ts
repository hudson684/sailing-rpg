// Phase 6: midnight plan validator. Walks every persistent agent's day
// plan and warns about `GoTo` legs whose target scene isn't reachable via
// the portal graph. Pure read; doesn't rewrite plans (plan rewrite would
// risk non-determinism). Dev-only; production builds tree-shake the file.

import { npcRegistry, setMidnightPostReplanHook } from "../sim/npcRegistry";
import { portalGraph } from "../world/portalGraph";
import type { SceneKey } from "../sim/location";

interface GoToLikeActivity {
  kind: string;
  serialize(): unknown;
}

interface SerializedGoTo {
  config: { target: { sceneKey: string } };
  runtime: { legs: Array<{ sceneKey: string }>; legIndex: number };
}

function isGoToSerialized(s: unknown): s is SerializedGoTo {
  if (!s || typeof s !== "object") return false;
  const r = s as { config?: { target?: { sceneKey?: unknown } }; runtime?: { legs?: unknown } };
  return typeof r.config?.target?.sceneKey === "string" && Array.isArray(r.runtime?.legs);
}

let wired = false;

export function wirePlanReachabilityValidator(): void {
  if (wired) return;
  wired = true;
  setMidnightPostReplanHook(() => runValidation());
}

function runValidation(): void {
  for (const agent of npcRegistry.allAgents()) {
    if (agent.flags.unregisterOnPlanExhaustion) continue;
    let cursor: SceneKey = agent.location.sceneKey;
    let i = 0;
    for (const act of agent.dayPlan as readonly GoToLikeActivity[]) {
      if (act.kind !== "goTo") { i += 1; continue; }
      const ser = act.serialize();
      if (!isGoToSerialized(ser)) { i += 1; continue; }
      const dest = ser.config.target.sceneKey as SceneKey;
      if (dest && cursor !== dest && !portalGraph.reachable(cursor, dest)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[plan-validator] ${agent.id} leg ${i}: '${cursor}' → '${dest}' has no portal route`,
        );
      }
      cursor = dest;
      i += 1;
    }
  }
}

// Auto-wire on module load.
wirePlanReachabilityValidator();
