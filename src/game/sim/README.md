# Sim layer — global NPC state management

Pure-data, scene-agnostic NPC system. Owns the canonical record for every
NPC in the world (`NpcAgent`), the daily plan they're executing
(`Activity[]`), and the registry that ticks both abstractly (per in-game
hour, every NPC) and live (per frame, only the active scene).

Layout:

- `npcRegistry.ts` — singleton master registry. Owns agents, drives ticks,
  fires `npcEnteredScene` / `npcLeftScene`, hydrates from save.
- `npcAgent.ts` — agent record + `ReadonlyBody`.
- `bodyHandle.ts` — exclusive write-token. The sole way to mutate
  `agent.body` from outside the registry.
- `location.ts` — `WorldLocation` + `SceneKey` discriminated string type.
- `calendar/` — day-of-week / month / season derived from `dayCount`.
- `activities/` — the verbs an NPC can run. Each one self-registers a
  deserializer in `activities/registry.ts` so saves round-trip.
- `planner/` — pure-input scheduler that turns an archetype + calendar
  into an ordered `Activity[]`.
- `data/` — JSON authoring surface (archetypes, schedules, spawn groups).
  See `data/README.md` for the authoring contract.

## Authoring a new activity

1. Create `activities/<name>.ts`. Implement the `Activity` interface from
   `activities/activity.ts`. The minimum:

   ```ts
   class MyActivity implements Activity {
     readonly kind = "myActivity";
     enter(npc, ctx) { /* claim body if you'll write to it */ }
     tickAbstract(npc, ctx, simMinutes) { /* per-hour state advance */ }
     tickLive(npc, ctx, dtMs) { /* per-frame; reads abstract state */ }
     exit(npc, ctx) { /* release body, drop listeners */ }
     isComplete() { return /* ... */; }
     canInterrupt() { return true; }
     serialize() { return { /* JSON-safe state */ }; }
     // optional: materialize / dematerialize for scene load/unload
   }
   ```

2. Add a deserializer + register it in `activities/registry.ts`:

   ```ts
   export function deserializeMyActivity(data) {
     return new MyActivity(/* rebuild from data */);
   }
   registerActivityKind("myActivity", deserializeMyActivity);
   ```

3. Body mutations always flow through a `BodyHandle`. Claim once in
   `enter` (or on first need) and release on `exit`. The dev-build
   assertion catches stale handles.

4. If the activity is cross-scene (uses portals, walks the player from
   world → interior), compose a `GoToActivity` instance internally
   rather than extending `WalkAndThenDo` — see `patronTavern.ts` and
   `workAt.ts` for the pattern.

## Authoring an archetype + schedule

See `data/README.md`.

## Persistence

`npcRegistry.serialize()` produces a `RegistrySnapshot` that the save
system writes under the `npcRegistry` saveable id (see
`src/game/save/npcRegistrySaveable.ts`). On load, `hydrate(snap)` rebuilds
every agent and calls each activity's deserializer to restore mid-flight
state. Subsystem-side state (tavern queue, ticket list, hired roster)
serializes alongside the business in `business`-keyed saveables, not the
registry.

Schema currently at `SCHEMA_VERSION = 1`. Bump only when the
`RegistrySnapshot` *outer* shape changes — per-activity payloads are
opaque to the saveable schema and migrate via per-activity
`deserialize` functions.

## Midnight re-plan

Persistent agents (anyone whose `flags.unregisterOnPlanExhaustion` is
*not* set) get their day plan rebuilt at every `time:midnight`.
Subsystems opt their archetype in via `registerReplanner(archetypeId,
fn)` — the function receives the agent and the new day count and
returns either a fresh `Activity[]` or null (skip).

`registerReplanner` matches by exact archetype id first, then by
longest matching `<prefix>:` form, so e.g. `staff:` covers every hired
staff archetype (`staff:cook`, `staff:server`, etc.).
