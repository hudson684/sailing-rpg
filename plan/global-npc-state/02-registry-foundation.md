# Phase 2 — Registry skeleton + body handles + activity interface

## Goal

Stand up the empty foundation. Nothing in the game uses it yet, but
every type and contract from `architecture.md` is real code.

## Why second

The shape of `Activity`, `BodyHandle`, and `NpcRegistry` ripples through
every later phase. Locking them in (and reviewing them) before any
behavior depends on them is the cheap moment to course-correct.

## Deliverables

- `src/game/sim/npcAgent.ts` — `NpcAgent`, `ReadonlyBody` types.
- `src/game/sim/location.ts` — `WorldLocation`, `SceneKey`, helpers
  (`sameScene`, `tileDistance`, `isChunkScene`, `isInteriorScene`).
- `src/game/sim/bodyHandle.ts` — `BodyHandle` class. Construction
  restricted to the registry. `setPosition` / `setFacing` / `setAnim` /
  `transfer` / `release`. Runtime active-driver assertion in dev builds.
- `src/game/sim/activities/activity.ts` — `Activity` interface,
  `ActivityCtx`, base classes:
  - `BaseActivity` (handles `kind` + serialization scaffolding)
  - `WalkAndThenDo` (common pattern: pathfind to location, then
    delegate to a sub-step)
- `src/game/sim/activities/noop.ts` — minimal activity for testing;
  completes after N sim-minutes.
- `src/game/sim/npcRegistry.ts` — `register` / `unregister` /
  `npcsAt` / `setLocation` / `tickAbstract` / `tickLive` / `on` /
  `serialize` / `hydrate`. Wired to `TimeManager.onMinute`.
- `src/game/sim/index.ts` — barrel export.
- Dev console command: `sim.spawnNoop(sceneKey, tileX, tileY, minutes)`
  registers a no-op agent and verifies tick + completion.

## Validation

- Spawn a no-op agent via dev console; it registers, ticks for the
  configured duration, completes, and is unregistered.
- `serialize` → `hydrate` round-trips an agent with an in-progress
  no-op activity (state preserved exactly).
- `BodyHandle` runtime check fires when a stale handle attempts a
  write after `transfer` or `release`.
- `npcsAt` returns the right set after `setLocation` calls; events
  fire in the right order.

## Risks / mitigations

- **Risk:** the `Activity` interface is wrong in a subtle way. Every
  later phase pays. **Mitigation:** review this file with extra care
  before leaving the phase; sketch one delegated activity (even
  pseudocode) to prove the interface fits.
- **Risk:** registry tick perf at scale (hundreds of NPCs * abstract
  ticks). **Mitigation:** abstract tick is per-minute, not per-frame;
  budget is generous. Profile only if it shows up later.

## Out of scope

- Any actual NPC migration. Phase 3.
- Cross-scene movement. Phase 4.
- Save/load wired to the game's save system. Phase 9.
