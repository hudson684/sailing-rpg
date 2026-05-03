# Phase 6 — Path robustness

## Goal

Two correctness improvements to the cross-scene movement layer that
together prevent silent NPC stalls:

1. **Morning portal-graph validation** — at midnight, dry-run portal
   connectivity for every `GoTo` leg in every plan. Failures produce
   warnings (and optionally drop the leg) before the day starts, not
   hours into the day inside an offscreen scene.
2. **Materialize-time fallback** — when live A* fails because a
   placed object now blocks the precomputed waypoint, fall back to
   "warp to nearest walkable tile adjacent to the goal and complete
   the leg" instead of stranding the NPC.

This is the hardening pass after the data-side phases have packed
schedules with more travel.

## Why

Today, `GoToActivity` pathfinds lazily, inside live mode, when the
leg starts. Failures produce `console.warn` and the activity quietly
completes without moving — the NPC is "at" their destination
abstractly but visibly stuck. With phases 1–5 layering in more
schedule density and festival travel, these silent failures will get
more common.

We deliberately don't pre-resolve every leg's tile-level A* (Stardew
does, but it's expensive and doesn't fit our split). Instead we use
the cheap portal graph for connectivity and live A* for actual tiles.

## Background

`src/game/world/pathfinding.ts` already has portal-aware A*. The
portal graph (which scenes connect to which via which tiles) is
derivable from world data. We don't currently expose a cheap "is X
reachable from Y" query — we just call full A*.

For the materialize-time fallback: when a player has placed a chest
on a tile a precomputed path crosses, the NPC's live A* now fails (or
returns a different path that may itself be blocked). Stardew's
behavior is to shove through and break the placeable. We won't break
placeables, but we shouldn't strand either.

## Deliverables

### 1. Portal graph cache

Extract from `pathfinding.ts` (or add alongside in
`src/game/world/portalGraph.ts`):

```ts
export interface PortalGraph {
  /** True if there's a sequence of portals from `fromScene` to
   *  `toScene`. Cheap — graph reachability, not tile-level A*. */
  reachable(fromScene: SceneKey, toScene: SceneKey): boolean;

  /** The sequence of portals to traverse. Useful for plan logging
   *  and the dev overlay. */
  route(fromScene: SceneKey, toScene: SceneKey): SceneKey[] | null;
}

export function buildPortalGraph(): PortalGraph;
```

Built once at boot from the same data that drives portal-aware
pathfinding. Rebuilt when world data hot-reloads in dev.

### 2. Midnight plan validation

After every plan replan (festival or normal), iterate the agent's new
plan and dry-run each `GoTo`'s scene reachability:

```ts
for (let i = 0; i < plan.length; i++) {
  const act = plan[i];
  if (act.kind !== "goTo") continue;
  const fromScene = inferOriginScene(plan, i);
  if (!portalGraph.reachable(fromScene, act.targetScene)) {
    console.warn(
      `[plan] ${agent.id} day ${dayCount}: leg ${i} unreachable ` +
      `(${fromScene} → ${act.targetScene})`,
    );
    // Strategy: drop the leg + everything depending on it.
    // For phase 6, just warn; plans don't get rewritten.
  }
}
```

Just a warning in phase 6. Future iteration could re-resolve the
schedule variant or pick a different sample, but that risks
non-determinism — defer until we have a concrete need.

### 3. `GoToActivity.materialize` fallback

`materialize` already runs A* against the live walkability oracle.
Today, on failure it logs and the activity stalls. Add fallback:

1. Try A* with the player's placed-objects collision layer included
   (current behavior).
2. If that fails, try A* against the static-only collision layer
   (i.e. assume placed objects are passable). If a path exists this
   way, the placed object is the blocker.
3. Find the nearest walkable tile adjacent to the goal that *is*
   reachable on the full collision layer. If found, set body position
   to that tile and mark the activity complete.
4. If even step 3 fails (the agent is inside a fully sealed area),
   warp the body to the goal directly (last resort) and warn loudly.

Critically, **don't break the placed object**. The fallback is
"recover gracefully," not "Stardew-style chest destruction."

In abstract mode (which has no walkable oracle), there's nothing to
fall back from — abstract just teleports on timer expiry, same as
today. The fallback only matters when the player is watching.

### 4. Stranded-agent watchdog

Cheap dev-mode check: if an agent's body position hasn't changed in
N consecutive quarter-hour ticks AND their current activity claims to
be a `GoTo`, log once. This catches silent failures the existing
warnings miss.

```ts
// In a dev-only registry tick listener
if (act.kind === "goTo" && bodyUnchangedTicks > 4) {
  console.warn(`[stranded] ${agent.id} stuck mid-goTo at ${tile}`);
}
```

Off in production builds.

## Validation

- A schedule that authors a `GoTo` to an unreachable scene produces a
  midnight warning naming the agent and the broken leg.
- Place a chest on a known NPC path and walk into the scene at the
  right time: the NPC routes around it (step 1) or warps to an
  adjacent tile (step 3) and continues their day. The chest is
  unharmed.
- Seal an NPC inside a 1-tile region with a placed object: warning
  fires, last-resort warp activates.
- The watchdog catches a real stall introduced via dev console
  manipulation (force the NPC's path to a tile in a sealed room).
- Production build: watchdog and explainer code are absent. Verify
  via grep on the build output.
- Performance: reachability checks at midnight for ~50 agents × ~10
  legs each take < 5ms total.

## Risks / mitigations

- **Risk:** the portal graph drifts from the actual pathfinding
  reachability (the pathfinder considers tile-level walkability that
  the graph doesn't). **Mitigation:** the graph is intentionally
  optimistic — "reachable in principle." Tile-level failures still
  hit the materialize fallback at run time. The midnight check is
  belt-and-suspenders, not authoritative.
- **Risk:** materialize fallback's "warp to nearest walkable" places
  the NPC visibly far from where the player would expect.
  **Mitigation:** the fallback only triggers when A* genuinely fails;
  before fallback, the proxy renders the NPC at their old position,
  so the warp-on-recovery is at most one frame jarring. Acceptable.
- **Risk:** rebuilding the portal graph on every world hot-reload in
  dev causes lag spikes. **Mitigation:** debounce the rebuild;
  flagged as dev-only, doesn't ship.

## Out of scope

- Pre-resolving full tile-level A* paths at midnight. Defeats the
  abstract savings. We don't do it.
- Path-aware walk duration estimates (replacing
  `estimatedWalkMinutes`). Useful but expensive — pathfind every leg
  at midnight just to time it. Punt until phase 3's hard-arrival
  times surface real estimation problems.
- Auto-recomputing plans when a leg becomes unreachable mid-day.
  Non-deterministic across save/load. Don't do it without a concrete
  need.
- Detection-evasion-style behavior changes for blocked NPCs. They
  fall back gracefully; they don't try to "lose" the player.

## Files touched

- New: `src/game/world/portalGraph.ts`
- Edited: `src/game/world/pathfinding.ts` (extract reusable graph
  builder)
- Edited: `src/game/sim/activities/goTo.ts` (materialize fallback)
- Edited: `src/game/sim/npcRegistry.ts` (post-replan validation hook)
- Edited: `src/game/sim/festivals/festivalReplanner.ts` (same hook)
- New: `src/game/dev/strandedAgentWatchdog.ts`
- Edited: `docs/npc-system.md` (document the fallback semantics)
