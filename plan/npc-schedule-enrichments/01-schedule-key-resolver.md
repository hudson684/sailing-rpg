# Phase 1 — Schedule key resolver + GOTO aliases

## Goal

Replace the current "one `ScheduleDef` per archetype" mapping with a
keyed dictionary the planner resolves by priority each day. Authoring
becomes: "here are several schedule variants; pick by day-of-week,
season, or weather." Plus alias entries that redirect one key to
another to cut duplication.

## Why first

Every other phase in this plan either builds on the resolver
(conditions, festivals) or is independent of it. Doing this first
means each later phase plugs into a single resolution layer instead of
each one inventing its own way to vary schedules.

## Background

Today (`src/game/sim/planner/scheduler.ts` + `data/schedules/<id>.json`):

```ts
planDay({ archetype, calendar, npcId, dayCount }) → Activity[]
```

`archetype` points at one `ScheduleDef` by id. The scheduler samples
templates from that single def. There's no fallback chain.

After this phase: `archetype` points at a *bundle* of named schedule
variants. The resolver picks one variant per day. The scheduler keeps
working unchanged on the resolved variant.

## Deliverables

### 1. Data shape change

`data/schedules/<id>.json` becomes a keyed object instead of a single
def. Old shape stays valid via a `default` key fallback:

```json
{
  "id": "townsfolk_default",
  "variants": {
    "default": { "templates": [...], "constraints": {...} },
    "Sun":     { "templates": [...], "constraints": {...} },
    "rain":    { "alias": "default" },
    "summer":  { "templates": [...], "constraints": {...} }
  }
}
```

A variant can be either a full `ScheduleDef` body (templates +
constraints) or an `{ "alias": "<otherKey>" }` redirect.

### 2. Resolver

New file: `src/game/sim/planner/scheduleResolver.ts`.

```ts
export interface ScheduleResolverInputs {
  readonly bundle: ScheduleBundle;        // parsed JSON
  readonly calendar: CalendarContext;
  readonly weather: string | null;        // "rain" | "clear" | null
}

export function resolveScheduleVariant(
  inputs: ScheduleResolverInputs,
): ResolvedScheduleDef;
```

Priority order (first match wins):

1. `<season>_<dayOfMonth>` — exact date override (e.g. `summer_15`)
2. `<weather>_<dayOfWeek>` — e.g. `rain_Mon`
3. `<weather>` — e.g. `rain`
4. `<season>_<dayOfWeek>` — e.g. `summer_Mon`
5. `<dayOfWeek>` — e.g. `Mon`
6. `<season>` — e.g. `summer`
7. `default` (required; build-time validator enforces)

Aliases follow up to a small fixed depth (e.g. 4) before erroring; an
alias cycle is a build-time validation failure.

Phase 2 inserts `friendship_*`, `flag_*`, and `festival_<id>` keys in
front of this list — leave room.

### 3. Scheduler integration

`scheduler.planDay` takes a resolved variant directly. Wire the
resolver call inside the existing entry point:

```ts
function planDay({ archetypeId, calendar, weather, npcId, dayCount }):
  Activity[] {
  const bundle = loadScheduleBundle(archetypeId);
  const variant = resolveScheduleVariant({ bundle, calendar, weather });
  return sampleTemplates(variant, npcId, dayCount);
}
```

Existing seeded RNG (`hashSeed(npcId) ^ dayCount`) stays inside
`sampleTemplates` and is unchanged.

### 4. Build-time validator

Extend `tools/validate-spawn-refs.mjs` (or add a sibling) to check
each schedule bundle:

- `default` exists.
- Every `alias` resolves to a real key without cycling.
- Every key is one of the recognized shapes (day name, season name,
  weather, `<season>_<day>`, `<weather>_<day>`, `<season>_<dayOfMonth>`).
- No unknown weather strings beyond a small allow-list.

### 5. Migration

`tourist.json` and `townsfolk_default.json` get a one-liner migration
to the new shape — both wrap their existing content under the
`default` key. No behavior change.

## Validation

- Existing tourist + townsfolk plans behave identically (same seed,
  same dayCount, same calendar → same `Activity[]`). Snapshot test.
- Authoring a `Sat` variant on `townsfolk_default` produces a different
  plan only on Saturdays.
- Authoring a `rain` variant produces the rainy plan only when weather
  reports rain; switches back to the day/season default when it
  clears.
- Authoring `summer_15` runs only on summer day 15 across multiple
  in-game years.
- Alias `"rain": { "alias": "Sun" }` produces the Sunday plan on rainy
  days.
- Alias cycle / missing target / missing `default` all fail the build
  validator with a useful message.

## Risks / mitigations

- **Risk:** weather hook doesn't exist yet. **Mitigation:** the
  resolver takes `weather: string | null`; pass `null` everywhere
  until weather lands. Weather-keyed variants compile but never
  match — a no-op authoring escape hatch.
- **Risk:** save reproducibility breaks if the resolved variant
  changes between save and load. **Mitigation:** the resolver is pure
  and its inputs (calendar, weather, flags) are all serialized or
  derivable from `dayCount` + flag store. Hydrating an old save
  re-resolves identically.
- **Risk:** mid-day weather changes cause plans to seem stale.
  **Mitigation:** out of scope. The resolver runs at midnight (and at
  hydrate time); mid-day weather flips don't replan. If this becomes a
  problem, add a `bus.onTyped("weather:changed", ...)` replanner
  later — same machinery as the midnight replanner.

## Out of scope

- Conditional predicates (friendship, flags). Phase 2.
- Per-NPC schedule overrides keyed on agent id. The bundle is per
  archetype; agent-level overrides are festival territory (phase 5).
- A separate "today's chosen variant" field on the agent for debug
  display. Phase 4's overlay calls the resolver directly with the
  same inputs.

## Files touched

- New: `src/game/sim/planner/scheduleResolver.ts`
- New: `src/game/sim/planner/scheduleResolver.test.ts`
- Edited: `src/game/sim/planner/scheduler.ts`
- Edited: `src/game/sim/data/schedules/tourist.json`
- Edited: `src/game/sim/data/schedules/townsfolk_default.json`
- Edited: `src/game/sim/data/README.md` (document the variant shape)
- New or edited: `tools/validate-schedule-bundles.mjs`
