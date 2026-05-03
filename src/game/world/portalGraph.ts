// Phase 6: cheap scene-level reachability graph derived from
// `portalRegistry`. Used by the midnight plan validator to flag day plans
// whose `GoTo` legs cross unreachable scenes — a fast pre-check that runs
// once per replan rather than per-leg-attempt at runtime.

import { portalRegistry } from "../sim/portals";
import type { SceneKey } from "../sim/location";

export interface PortalGraph {
  /** True if there's a sequence of portals from `fromScene` to `toScene`. */
  reachable(fromScene: SceneKey, toScene: SceneKey): boolean;
  /** The chain of scenes traversed (inclusive endpoints) or null when not
   *  reachable. */
  route(fromScene: SceneKey, toScene: SceneKey): SceneKey[] | null;
}

class PortalGraphImpl implements PortalGraph {
  private adj = new Map<SceneKey, Set<SceneKey>>();
  private cachedFrom: SceneKey | null = null;
  private cachedDist: Map<SceneKey, SceneKey | null> | null = null;

  rebuildFromRegistry(): void {
    this.adj.clear();
    this.cachedFrom = null;
    this.cachedDist = null;
    // PortalRegistry doesn't expose a "list every link" method, but
    // `portalsFrom(sceneKey)` is enumerable across known scenes. We don't
    // know the full scene set up front, so we walk what's been registered
    // by iterating reachable scenes via a BFS from each known root.
    // Simpler: peek the internal map by re-scanning registered scenes on
    // demand. We'll lazily probe each scene we encounter.
  }

  /** Adds an edge `from → to`. Idempotent; safe across duplicate registers. */
  addEdge(from: SceneKey, to: SceneKey): void {
    let set = this.adj.get(from);
    if (!set) { set = new Set(); this.adj.set(from, set); }
    set.add(to);
    this.cachedFrom = null;
    this.cachedDist = null;
  }

  reachable(fromScene: SceneKey, toScene: SceneKey): boolean {
    if (fromScene === toScene) return true;
    const dist = this.computeBfs(fromScene);
    return dist.has(toScene);
  }

  route(fromScene: SceneKey, toScene: SceneKey): SceneKey[] | null {
    if (fromScene === toScene) return [fromScene];
    const dist = this.computeBfs(fromScene);
    if (!dist.has(toScene)) return null;
    const path: SceneKey[] = [toScene];
    let cur: SceneKey | null = toScene;
    while (cur !== null && cur !== fromScene) {
      const prev: SceneKey | null = dist.get(cur) ?? null;
      if (prev === null) break;
      path.push(prev);
      cur = prev;
    }
    return path.reverse();
  }

  private computeBfs(fromScene: SceneKey): Map<SceneKey, SceneKey | null> {
    if (this.cachedFrom === fromScene && this.cachedDist) return this.cachedDist;
    const dist = new Map<SceneKey, SceneKey | null>();
    dist.set(fromScene, null);
    const queue: SceneKey[] = [fromScene];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of this.neighbors(cur)) {
        if (dist.has(next)) continue;
        dist.set(next, cur);
        queue.push(next);
      }
    }
    this.cachedFrom = fromScene;
    this.cachedDist = dist;
    return dist;
  }

  private neighbors(scene: SceneKey): readonly SceneKey[] {
    // Always-reflect the live registry — portals can be registered after
    // the graph was last queried (chunk streaming).
    const links = portalRegistry.portalsFrom(scene);
    return links.map((l) => l.toSceneKey);
  }
}

export const portalGraph: PortalGraph = new PortalGraphImpl();

/** Phase 6: utility used by the midnight plan validator. Walks an agent's
 *  day plan and returns warnings for any `GoTo` whose target scene is
 *  unreachable from the prior cursor scene. Prefers a pessimistic check
 *  via the portal graph; tile-level walkability still happens at runtime. */
export function validatePlanReachability(
  fromScene: SceneKey,
  legs: readonly { sceneKey: SceneKey }[],
): string[] {
  const warnings: string[] = [];
  let cursor = fromScene;
  for (let i = 0; i < legs.length; i++) {
    const dest = legs[i].sceneKey;
    if (cursor === dest) {
      cursor = dest;
      continue;
    }
    if (!portalGraph.reachable(cursor, dest)) {
      warnings.push(`leg ${i}: '${cursor}' → '${dest}' has no portal route`);
    }
    cursor = dest;
  }
  return warnings;
}
