# NPC Schedule Enrichments — Plan Index

A set of focused upgrades to the existing NPC system, borrowing the
parts of Stardew Valley's schedule design that compose cleanly with our
abstract/live tick split. Nothing here replaces the registry, body
handles, activities, or the live/abstract architecture documented in
`docs/npc-system.md` — these are additions on top.

## Why

The current system has the right bones (chunked-world-friendly tick
split, exclusive body ownership, pure planners, save/load round-trip)
but authored schedules are flat: one `ScheduleDef` per archetype,
sampled by a seeded RNG, with no way to express "the cook works late on
rainy days" or "the festival overrides everyone's plan." Players can't
see what offscreen NPCs are doing, which makes the abstract tick
genuinely hard to debug. And path failures discover themselves
silently, hours into the day.

Stardew solves the authoring side with a string-DSL plus key-priority
resolution; solves the debug side via community schedule-viewer mods;
and tolerates path failures by shoving through obstacles. We can lift
the spirit of all three without giving up our architecture.

## What this is *not*

- A rewrite to "always-loaded world / universal 60 fps tick." That
  would unwind the abstract/live split deliberately. See the analysis
  in conversation history if you want the rip-and-replace version.
- A new activity vocabulary. Activities stay as-is.
- A change to body ownership, claims, or transfers.
- A change to the registry's snapshot shape.

## Locked decisions

- **Resolver is pure.** Same inputs (archetype, calendar, agent flags,
  weather, world flags) → same chosen `ScheduleDef`. Slots into the
  existing seeded planner; reproducible saves stay reproducible.
- **Conditions are static-analyzable.** AND/OR/NOT over typed
  predicates only. No string interpolation, no Turing-completeness, no
  live-state lookups.
- **Festivals are a replanner override, not a parallel system.** A
  festival day produces a hand-built `Activity[]` returned from a
  high-priority replanner; the registry doesn't know it's a festival.
- **Hard arrival times are an opt-in field on `GoTo`, not a new
  activity.** Existing duration-based plans keep working unchanged.
- **Path robustness lives at `materialize` time.** Abstract walks stay
  cheap (timer-based teleport). Live materialize is the seam where we
  re-pathfind and apply fallbacks.
- **The dev overlay is a developer tool, not a player-facing UI.**
  Behind a dev flag; can show internal data freely.

## Build order

| Step | Status | File |
|------|--------|------|
| 1. Schedule key resolver + GOTO aliases | pending | `01-schedule-key-resolver.md` |
| 2. Conditional schedule keys | pending | `02-conditional-keys.md` |
| 3. Hard arrival times + idle padding | pending | `03-hard-arrival-times.md` |
| 4. Dev schedule overlay | pending | `04-dev-schedule-overlay.md` |
| 5. Festivals as replanner override | pending | `05-festivals.md` |
| 6. Path robustness (morning validation + push-through) | pending | `06-path-robustness.md` |

Each phase ships independently. The game works between phases. Phases
1 and 2 unlock authoring expressiveness; phases 3 and 5 unlock
gameplay; phase 4 unlocks debuggability; phase 6 is a correctness
hardening pass.

## Recommended cut points

- **MVP Stardew-feel:** phases 1 + 2 + 4. Schedules respond to day,
  weather, friendship, flags; you can see what every NPC is doing.
  This is the single highest-impact subset.
- **"World feels alive":** add phases 3 + 5. NPCs hit specific times,
  festivals exist.
- **Hardening:** phase 6 last, when the new schedule density starts
  surfacing path failures.

## Anti-goals

- Recreating Stardew's `<time> [location] <x> <y> [facing] [anim]
  [dialogue]` string DSL. Our `Activity[]` representation is strictly
  more expressive; the resolver targets which template set to sample,
  not the templates themselves.
- Adding push-through-and-break-placeables. Stardew's chest-breaking
  charm is a bug we don't need to import. Phase 6 falls back to
  warp-to-nearest-walkable, not destruction.
- Live-state inputs to the resolver. Friendship and weather are state,
  but they're stable across a midnight replan and known to the
  calendar/flags layer. "What is NPC X doing right now" must never
  feed into the resolver.
- Pre-resolving the entire day's A* paths upfront. The whole point of
  the abstract tick is that we don't pay for offscreen pathfinding.
  Phase 6's morning validation uses the cheap portal graph, not
  tile-level A*.

## Dependencies on existing systems

- Calendar (`src/game/sim/calendar/calendar.ts`) — already provides
  day-of-week, month, season. Resolver consumes this.
- Weather — assumes a global weather state readable as a string key
  (`"rain"`, `"clear"`, etc.). If no weather system exists yet, the
  resolver's weather predicates compile but never match.
- Flags — `agent.flags` and the global flag store. Used as condition
  inputs in phase 2.
- Friendship — if/when added, fits the same predicate shape as flags.
  Phase 2 reserves the syntax; the predicate evaluator is a no-op
  until the data exists.

See `docs/npc-system.md` for the architectural context every phase
assumes.
