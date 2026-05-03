# Phase 4 — Dev schedule overlay

## Goal

A developer overlay listing every registered NPC, what they're doing
right now, where they're going next, and when they'll get there. The
abstract/live split makes the world genuinely opaque — most NPCs are
in scenes you can't see — so we need a viewer.

## Why

Stardew's universal-tick model is debuggable because the community
built schedule-viewer mods that show every NPC at once. Our chunked
world makes this even more critical: the only way to currently know
"is the cook actually showing up to work?" is to sail to the right
island and walk into the kitchen. That's not a sustainable debug
loop.

Doing this early in the plan means it accelerates phases 1–3 and 5 —
they all benefit from being able to see the new behavior.

## Why now (after phases 1–3, before festivals)

Phases 1–3 are pure data-side changes; the overlay is most useful
once those have shipped because the variety in plans is what makes a
viewer interesting. But phase 5 (festivals) is the first time the
overlay's "where is everyone" question becomes urgent for design
review (festival staging), so building it just before phase 5 is the
right cut.

If you find yourself debugging phase 1 and reaching for `console.log`
loops, hoist this earlier. It's free-standing.

## Deliverables

### 1. Data API

New file: `src/game/dev/scheduleSnapshot.ts` (lives in a `dev/` folder
so it's tree-shaken from production builds).

```ts
export interface ScheduleSnapshotRow {
  npcId: string;
  archetypeId: string;
  scene: string;
  mode: "live" | "abstract";
  currentActivity: string;          // kind + a one-line summary
  nextActivity: string | null;
  etaMinutes: number | null;        // until next activity or arrival
  bodyTile: { x: number; y: number };
  flags: string[];                  // truthy keys, comma-joined
}

export function captureScheduleSnapshot(): ScheduleSnapshotRow[];
```

Pulls from `npcRegistry.allAgents()` + the active scene key + the
quarter-hour tick clock. Pure read; never mutates.

### 2. Phaser overlay scene

`src/game/scenes/DevScheduleOverlayScene.ts`:

- Toggle: `F9` (or whatever's free; check existing dev keys).
- Renders a fixed-position panel with a virtualized list of rows.
- Columns: id · scene · mode · activity · next · eta.
- Click a row → camera warps the player's scene to the agent's scene
  if it's a chunk-loaded one; otherwise just logs the agent state
  to console.
- Refresh: re-captures snapshot once per second (cheap; pure read).

Lives behind `import.meta.env.DEV` so production builds don't ship
it. Use Phaser 4's scene system to layer above the world UI; do not
overlay in DOM.

### 3. Per-row drilldown

Right-click a row → console.log the full agent state:
- Day plan as a typed list (kind + brief data summary)
- Currently-resolved schedule variant key (from phase 1's resolver)
- Predicate evaluation trace (from phase 2)
- Padding/trim log (from phase 3)

This is "why is this NPC doing this?" answered in one click.

### 4. Optional: resolver introspection

Expose a dev-only function that, given an archetype id, returns *all*
variants and which one resolves today (and why). Useful for authoring
sessions without spawning the NPC:

```ts
export function explainResolver(
  archetypeId: string,
  dayCount: number,
  weather: string | null,
): {
  matched: string;
  rejected: Array<{ key: string; reason: string }>;
};
```

Wire into the dev console as `window.__npc.explain('cook', 12)`.

## Validation

- Overlay opens with F9, lists every agent in `npcRegistry.allAgents()`.
- Walking into a scene flips the relevant agents from `abstract` to
  `live`; the overlay reflects this within 1 second.
- ETA columns count down monotonically as time advances; they don't
  go negative.
- Right-click drilldown logs structured JSON the author can read.
- Toggling F9 off completely tears the scene down (no leaked tickers).
- Production build (`npx vite build`) does not include the overlay
  scene; verify by greping the build output for the file name.

## Risks / mitigations

- **Risk:** snapshot capture iterates every agent every second and
  creates GC pressure. **Mitigation:** rebuild the row list only on
  hour ticks and on agent register/unregister; just refresh the ETA
  column every second. The expensive part is the activity-summary
  string; cache it on the row.
- **Risk:** clicking a row to switch scenes is dangerous if it cuts
  through cutscenes or gameplay state. **Mitigation:** make the
  click-to-warp opt-in via a modifier (Shift-click), and bail out if
  any cutscene flag is set.
- **Risk:** Phaser 4 scene overlay z-ordering collides with existing
  UI. **Mitigation:** use Phaser's scene `setActive(true).bringToTop()`
  and a dedicated key range for input. Don't reach for DOM.

## Out of scope

- A timeline view (Gantt-style) of the day plan. Useful but a much
  bigger UI project. Reach for it if list-form rows aren't enough.
- A scrubber that fast-forwards time to preview future state. The
  calendar dev console already has time controls; the overlay just
  reflects them.
- Networking/multiplayer considerations. Single-player only.

## Files touched

- New: `src/game/dev/scheduleSnapshot.ts`
- New: `src/game/scenes/DevScheduleOverlayScene.ts`
- Edited: `src/game/scenes/SceneManager.ts` (or wherever the dev
  scene list lives) — gate behind `import.meta.env.DEV`.
- Edited: `src/game/sim/planner/scheduleResolver.ts` — export
  `explainResolver`.
