# Phase 6 — Scheduler + Tourist archetype + spawn pipeline

## Goal

Tourists arrive in chunk 1_1 at random times during the day, plan a
day, and live it: walk to shops, visit the tavern, leave. First
end-to-end use of the system. Phase 5's `npcRegistryPatrons` flag is
turned on as part of this phase.

## Why sixth

Phases 1–5 produce machinery; this is where the system earns its
keep. Tourist is the right first archetype: bounded (they arrive and
leave), exercises cross-scene movement (chunk → interior → chunk),
exercises delegated activities (`PatronTavern`), and doesn't depend on
NPCs having homes.

## Deliverables

- `src/game/sim/planner/scheduler.ts`
  - Pure function:
    `(archetype, calendarCtx, npcFlags, worldFlags, seed) → Activity[]`
  - Picks N activities from the archetype's schedule templates using
    weighted random + window/duration constraints.
  - Honors `mustStartAt` / `mustEndAt` constraints (e.g. tourist must
    end at spawn point or guest room).
  - Inserts implicit `GoTo` activities between non-adjacent locations.
  - Deterministic given seed (so save/load reproduces).
- `src/game/sim/planner/archetypes.ts` — loads + indexes
  `npcArchetypes.json` and `schedules/*.json`.
- `src/game/sim/data/npcArchetypes.json` — `tourist` entry.
- `src/game/sim/data/schedules/tourist.json` — templates: arrival,
  browse general store, browse blacksmith, patron tavern, wander town
  square, departure.
- `src/game/sim/data/spawnGroups.json` — `town_tourists` group.
- `src/game/world/spawns.ts` — extend to recognize Tiled object class
  `npcSpawnPoint` with `spawnGroupId` property; chunk loader registers
  spawn points with the registry on chunk-ready.
- `npcRegistry.ts` — at midnight (`onMidnight`), iterate registered
  spawn groups, schedule arrivals for the day:
  - Pick random arrival times within `arrivalWindow`, weighted by
    `dayWeights[dayOfWeek]`.
  - For each arrival, plan the day via scheduler; queue an agent to
    spawn at that minute.
- `tools/validate-spawn-refs.mjs` — build-time check that every
  Tiled `npcSpawnPoint.spawnGroupId` resolves in `spawnGroups.json`.
  Wire into existing build pipeline.
- Tiled edit: place a `npcSpawnPoint` object in chunk 1_1 (suggested
  near the docks) with `spawnGroupId: "town_tourists"`.
- Set feature flag `npcRegistryPatrons = true` (from phase 5).

## Validation

- Play 3 in-game days. Each day:
  - Tourists arrive at varied times within the configured window.
  - Each tourist's day plan is plausible (3–6 activities, ends at
    departure).
  - Tourists visibly walk between locations, enter shops, eat at
    tavern, leave town.
- Tavern fills with a mix of tourists across the evening; queueing
  works when full.
- Saturday/Sunday show ~2× tourist count vs. weekdays.
- Save mid-day, reload: same tourists exist with same plans (seeded).
- `npx tsc --noEmit` and `npx vite build` clean.

## Risks / mitigations

- **Risk:** scheduler produces incoherent plans (tourist visits a
  closed shop, ends in the wrong scene). **Mitigation:** templates
  carry `windowMinute` constraints; scheduler filters by current open
  hours; `mustEndAt` enforced as a hard constraint.
- **Risk:** spawn pipeline races with chunk-load (group registers
  after midnight tick). **Mitigation:** registry tracks "scheduled
  arrivals waiting for a registered spawn point" and resolves on
  spawn-point registration.
- **Risk:** all tourists pick the same tavern visit time → pile-up.
  **Mitigation:** scheduler jitters time choices per agent; tavern
  queueing handles overflow.
- **Risk:** turning on the patron flag exposes a bug missed in phase
  5 manual testing. **Mitigation:** flag is per-build toggle; can be
  flipped off in dev quickly while diagnosing.

## Out of scope

- Tourists with special behaviors (vendors, performers). New
  archetypes later.
- Procedurally generated tourist appearance customization (just reuse
  existing townsfolk sprite pool).
- Inn / overnight tourists (tourists leave by end of day for now).
