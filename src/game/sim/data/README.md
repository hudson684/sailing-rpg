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

```json
{
  "id": "townsfolk_default",
  "constraints": {
    "totalActivitiesRange": [3, 5],
    "mustEndAt": "spawnPoint"
  },
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
}
```

`kind`: one of `wander | browse | idle | patronTavern | goTo`.

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

## Adding browse waypoints

`InteriorScene` parses Tiled `npcBrowseWaypoint` objects and registers
them with `BrowseWaypointRegistry`. Each waypoint object has an optional
`browseGroupId` custom property (default `"all"`); 4–6 per shop is
ideal so a `BrowseActivity` has interesting tiles to wander between.
