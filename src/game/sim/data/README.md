# Sim layer — authoring archetypes, schedules, spawn groups

Three JSON files drive every NPC the registry spawns or replans:

- `npcArchetypes.json` — character classes (tourist, townsfolk, …).
- `schedules/<id>.json` — what an archetype does over a day.
- `spawnGroups.json` — when/where archetypes arrive in the world.

Authored once. Validated at build time by `tools/validate-spawn-refs.mjs`
(wired into `npm run maps`).

## Archetypes (`npcArchetypes.json`)

```json
{
  "tourist": {
    "name": "Tourist",
    "spriteSet": "townsfolk_random",
    "scheduleId": "tourist",
    "defaultTraits": { "wanderlust": 0.6 }
  }
}
```

- `spriteSet` — what the spawn dispatcher uses when minting a body.
  `"townsfolk_random"` picks a random source NPC from the townsfolk pool.
- `scheduleId` — must resolve to a file in `schedules/`.

## Schedules (`schedules/<id>.json`)

A schedule is a *bundle* of named variants. The resolver picks one variant
per agent per day based on calendar / weather / world flags. The single
required key is `default`; everything else is opt-in:

```json
{
  "id": "townsfolk_default",
  "variants": {
    "default": {
      "constraints": { "totalActivitiesRange": [3, 5] },
      "templates": [
        {
          "id": "wander_home",
          "kind": "wander",
          "target": { "kind": "spawnPoint" },
          "weight": 1.0,
          "duration": [30, 90],
          "wanderRadiusTiles": 4
        },
        {
          "id": "patron_tavern",
          "kind": "patronTavern",
          "target": { "kind": "businessArrival", "businessId": "rusty_anchor" },
          "weight": 0.4,
          "windowMinute": [720, 1320]
        }
      ]
    },
    "Sunday": {
      "constraints": { "totalActivitiesRange": [4, 6] },
      "templates": [/* a different mix for Sundays */]
    },
    "rain": { "alias": "default" }
  }
}
```

### Variant resolution priority

The resolver walks this list and picks the first key that (a) has a variant
defined and (b) satisfies its optional `when` predicate:

1. `flag_<name>` — world flag is set
2. `<season>_<dayOfMonth>` — exact date (e.g. `summer_15`)
3. `<weather>_<dayOfWeek>` — e.g. `rain_Lunaday`
4. `<weather>` — e.g. `rain`
5. `<season>_<dayOfWeek>` — e.g. `summer_Lunaday`
6. `<dayOfWeek>` — e.g. `Lunaday`
7. `<season>` — e.g. `summer`
8. `default` (required)

A variant body is either `{ constraints, templates, when? }` or
`{ alias: "<otherKey>" }`. Aliases follow up to depth 4.

### Conditional `when` clauses

Beyond the priority key, a variant can carry a `when` predicate gating it on
runtime state (flags, friendship, calendar predicates). Predicate types:

- `{ "flag": "<name>" }` — global world flag is set.
- `{ "notFlag": "<name>" }` — sugar for `{ "not": { "flag": "..." } }`.
- `{ "agentFlag": "<name>" }` — per-agent flag is set.
- `{ "friendship": { "npc": "<id>", "gte": <n> } }` — reserved syntax.
  Returns `false` until the friendship system is implemented.
- `{ "season": "<name>" }` / `{ "dayOfWeek": "<name>" }` / `{ "weather": "<name>" }`
  — useful inside compound predicates.
- `{ "all": [predicate, ...] }` — AND.
- `{ "any": [predicate, ...] }` — OR.
- `{ "not": predicate }` — NOT.

Examples:

```json
"Sunday": {
  "when": {
    "all": [
      { "flag": "tavern_repaired" },
      { "friendship": { "npc": "cook", "gte": 4 } }
    ]
  },
  "templates": [...]
}
```

Predicates evaluate once at midnight per agent — runtime cost is negligible
even for hundreds of agents.

`kind`: one of `wander | browse | idle | standAround | patronTavern | goTo`.

`target.kind`:
- `spawnPoint` — wherever the agent arrived. Self-referential: the
  scheduler's cursor starts here.
- `businessArrival` — front-door anchor. The world load registers these
  under both the interior key and the `businessId`, so either form works.
- `namedTile` — generic anchor (e.g. `town_square`). Authored as a Tiled
  object with `class: "namedTile"` and a `name` custom property.

`windowMinute` (optional) — `[lo, hi]` sim-minute-of-day window during
which the template is eligible. Outside the window the template is
skipped (not retried).

`duration` (optional) — `[lo, hi]` sim-minute uniform-pick range. Used by
`wander` / `browse` / `idle` for their dwell counter.

`mustStartAt` (optional) — sim-minute-of-day at which the activity must
start. The planner pads earlier flexible activities with `Idle` to land on
the anchor exactly, or trims them by up to 30 minutes to recover from
overrun. Mutually exclusive with `windowMinute`. Build-validator-enforced.

`constraints.mustEndAt`: `"spawnPoint"` appends a closing `GoTo` back to
the spawn so ephemeral arrivals leave the way they came.

## Spawn groups (`spawnGroups.json`)

```json
{
  "town_tourists": {
    "archetype": "tourist",
    "arrivalsPerDay": 3,
    "arrivalWindow": { "earliestMinute": 480, "latestMinute": 900 },
    "dayWeights": { "saturday": 2.0, "sunday": 2.0 }
  }
}
```

- `arrivalsPerDay` — base count, scaled by today's `dayWeights`.
- `arrivalWindow` — sim-minute-of-day band. Picks land at hour-tick
  granularity (the abstract clock).
- `dayWeights` — multipliers keyed by `calendar.dayOfWeek`. Missing days
  default to 1.0.

A Tiled `npcSpawnPoint` object with property `spawnGroupId: "town_tourists"`
binds a tile to the group. The build-time validator
(`tools/validate-spawn-refs.mjs`) errors if a Tiled `spawnGroupId`
doesn't resolve to an entry here.

## Townsfolk vs tourists

- **Tourists** are ephemeral. Arrive at a spawn point, run a 3–6 step
  plan, depart. Spawned by the dispatcher; carry
  `flags.unregisterOnPlanExhaustion = true` so the registry removes
  them when the plan ends.
- **Townsfolk** are persistent. Authored in `data/npcs.json` (legacy
  layer). When an `npcResidence` Tiled object is authored for them,
  `registerAgentForNpcDef` swaps their wander/patrol activity for a
  `townsfolk_default`-archetype day plan and registers a midnight
  replanner. Without an authored residence, they keep the legacy
  per-NPC wander/patrol behavior.
- **Hired staff** are persistent and dynamic — registered by
  `staffAgentBootstrap` per business when both a residence and a
  business arrival anchor are authored. Their plan is built fresh at
  midnight by the `staff:` replanner.

## Festivals (`festivals/<id>.json`)

A festival replaces every participating NPC's day plan on its calendar
day. The festival replanner runs at midnight *before* the per-archetype
replanner, so the festival's plan wins.

```json
{
  "id": "harvest_festival",
  "calendarDay": { "season": "autumn", "dayOfMonth": 16 },
  "scene": "chunk:world",
  "openHour": 9,
  "closeHour": 22,
  "arrivalAnchor": "town_square",
  "participants": {
    "townsfolk_default": { "kind": "wander_anchor", "anchor": "town_square", "radius": 6 },
    "tourist": { "kind": "wander_anchor", "anchor": "town_square", "radius": 6 }
  },
  "specialAgents": {
    "mayor": [
      { "kind": "goTo", "anchor": "festival_stage" },
      { "kind": "standAround", "anchor": "festival_stage", "duration": 30, "facing": "down" }
    ]
  },
  "touristSpawnGroupOverride": "harvest_festival_tourists"
}
```

- `participants` maps archetype id (or `staff:` prefix) to a small
  template. Most NPCs use this.
- `specialAgents` keys an NPC id to a hand-built ordered step list.
  Used for the mayor's speech, etc.
- Festival anchors (`festival_floor`, `festival_stage`, `town_square`)
  are ordinary `namedTile` Tiled objects — no new anchor type.
- `touristSpawnGroupOverride` (optional) routes that day's tourist
  spawns through a different spawn group, so the festival is always
  populated even on light tourism days.

To test a festival without waiting for the calendar:

```js
__npc.forceFestival("harvest_festival")
__npc.forceFestival(null)  // clear the override
```

## Adding browse waypoints

`InteriorScene` parses Tiled `npcBrowseWaypoint` objects and registers
them with `BrowseWaypointRegistry`. Each waypoint object has an optional
`browseGroupId` custom property (default `"all"`); 4–6 per shop is
ideal so a `BrowseActivity` has interesting tiles to wander between.
