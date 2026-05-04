# NPC system reference

How NPCs work in Sailing RPG. Read this before touching anything in
`src/game/sim/`, `src/game/entities/agentBinding.ts`, `npcProxy.ts`,
`sceneNpcBinder.ts`, `WorldTicker`, or the `customerSim` /
`staffService` borrowed-body paths.

The system was built across nine phases (`plan/global-npc-state/`) and
the implementation log lives in `plan/global-npc-state/decisions.md` —
reach for that when a "why is it like this?" question doesn't have an
obvious answer in the code.

## Mental model

Every NPC in the world is an `NpcAgent` in a single global registry
(`src/game/sim/npcRegistry.ts`). The agent owns:

- canonical position (`body`)
- canonical scene (`location`)
- a `dayPlan: Activity[]` — the sequence of things they're doing today
- the activity currently in flight (`currentActivity`)

Activities are the verbs. They drive the agent's body and decide when
they're "done." Subsystems (the tavern's customer FSM, the staff
service) don't own NPCs — they *borrow* an NPC's body for the duration
of an activity (e.g. `PatronTavernActivity` hands the body to
`patronService` while the patron is inside).

Two ticks run in parallel:

| Tick | When | Cost | Drives |
|---|---|---|---|
| **Abstract** | every `time:simTick` (10 sim-min) | cheap, every agent in the world | bookkeeping (timers, day-plan progress) |
| **Live** | every frame, only the player's scene | full pathfinding + animation | the agent's `NpcModel` you actually see |

When the player walks into a scene, the binder calls `materialize` on
every active activity in that scene; on leave it calls `dematerialize`.
That's how an abstract patron mid-meal becomes a live patron when the
player walks in.

## The three layers

```
src/game/sim/                  ← pure data, no Phaser
  npcRegistry.ts               singleton; ticks, events, save
  npcAgent.ts                  agent record + ReadonlyBody
  bodyHandle.ts                exclusive write-token
  location.ts                  WorldLocation + SceneKey
  calendar/calendar.ts         day-of-week / month / season
  activities/                  Wander, Patrol, GoTo, Sleep, Idle,
                               Browse, PatronTavern, WorkAt, Noop
  planner/                     scheduler + dispatcher + anchors +
                               residences + browseWaypoints
  data/*.json                  archetypes, schedules, spawn groups
  data/schedules/*.json

src/game/entities/             ← Phaser bridge
  agentBinding.ts              register an NpcAgent for an NpcDef
  npcProxy.ts                  per-frame body→model mirror
  npcBootstrap.ts              load NPCs from data/npcs.json
  WorldTicker.ts               legacy NpcModel.tick driver

src/game/world/
  sceneNpcBinder.ts            per-scene tick + proxy lifecycle
  pathfinding.ts               A* over the active map

src/game/business/             ← borrowed-body subsystems
  customerSim.ts               tavern FSM
  customerSim/patronService.ts requestSeat / releasePatron
  staff/staffService.ts        clockIn / clockOut
  staff/staffAgentBootstrap.ts hire → registered NpcAgent
```

## Body ownership — the one rule

`agent.body` is publicly `ReadonlyBody`. The only way to mutate it is
through a `BodyHandle` claimed via `ctx.claimBody(npc, claimant)`.

- Two systems holding handles for the same NPC at the same time is
  forbidden. `claimBody` throws if there's already an active driver.
- Hand off a borrowed body via `handle.transfer(toClaimant)` — the old
  handle is invalidated; only the new one is valid.
- Always release on activity exit. `BodyHandle.release()`.
- Dev builds assert every write came from the active driver.

The proxy mirrors `agent.body → NpcModel` each frame, then
`NpcSprite.syncFromModel` finally pushes to Phaser. So the pipeline
is: **activity → body (via handle) → model → sprite**.

There is one documented bypass — `npcRegistry.setBodyExternal(npcId,
patch)` — used by `NpcProxy` to mirror **model→body** when
`model.scripted === true` (cutscenes, the legacy customerSim staff
arrival/departure walks). Treat it as a transitional wart; if you find
yourself reaching for it, you're probably writing scripted-driver code
that should go through the activity/handle path instead.

## Activities

A small fixed vocabulary, each in `src/game/sim/activities/`:

- `Wander` — random tile-radius pacing. Optional `durationMinutes` for
  bounded use (tourists). Without it, loops forever (legacy townsfolk
  wander).
- `Patrol` — fixed waypoint loop. Authored townsfolk patrols.
- `GoTo` — A* path with portal awareness. Cross-scene capable.
- `Sleep` — stand at a tile for N minutes. Used at the start/end of
  townsfolk and staff days.
- `Idle` — stand-with-occasional-fidget. Generic dwell.
- `Browse` — random walks between authored `npcBrowseWaypoint` tiles
  inside a shop. Falls back to `Idle`-equivalent when no waypoints
  exist.
- `PatronTavern` — composes a `GoTo`, hands the body to
  `patronService.requestSeat`, waits for the `complete` event.
- `WorkAt` — same shape as `PatronTavern` but for `staffService`.
- `Noop` — fixed-duration "stand still." Used by the planner as a
  placeholder dwell.

Every activity:

1. Implements the `Activity` interface (`activities/activity.ts`).
2. Self-registers a deserializer in `activities/registry.ts` so saves
   round-trip.
3. Optionally implements `materialize`/`dematerialize` for graceful
   abstract↔live transitions.

Cross-scene activities (`PatronTavern`, `WorkAt`) **compose** an inner
`GoToActivity` rather than extending `WalkAndThenDo`. The base class
only models in-scene walks.

## Day plans + the planner

A day plan is just `Activity[]`. Built two ways:

**Authored data** — `src/game/sim/data/schedules/<id>.json` declares
templates. The scheduler (`planner/scheduler.ts`) picks a deterministic
subset per day using a seeded RNG (`hashSeed(npcId) ^ dayCount`),
inserts implicit `GoTo` legs between non-adjacent locations, and
appends a closing `GoTo` if `mustEndAt: spawnPoint`. This is what
tourists, townsfolk, and the `staff:` archetypes use.

**Hand-built** — for special cases (cutscenes, dev-console probes,
the staff bootstrap's calendar-aligned day plan) you can construct
the array directly.

Plans are seedable and pure: same `(archetype, calendar, npcId,
dayCount)` → same plan. This is what makes mid-day reload reproducible.

### Anchors

Templates address tiles symbolically. Three anchor flavors:

- `spawnPoint` — wherever the agent arrived (the dispatcher fills this
  in per-arrival).
- `businessArrival` — front-door tile. Registered under both the
  interior key and the business id, so `"general_store"` and
  `"interior_general_store"` both resolve.
- `namedTile` — generic anchor (`town_square`, etc.). Tiled object
  with `class: "namedTile"` and a `name` property.

`WorldAnchorRegistry` (in `planner/anchors.ts`) is rebuilt from world
data on every load — there's no save state.

## Spawn pipeline (tourists)

```
Tiled npcSpawnPoint (spawnGroupId)
        ↓ (chunk-ready)
spawnDispatcher.registerSpawnPoint
        ↓ (time:midnight builds today's per-group arrival schedule)
spawnDispatcher.flushPending           (hour ticks + new-point registrations)
        ↓
spawnArrival → planner.planDay → npcRegistry.register
        ↓ (agent.flags.unregisterOnPlanExhaustion = true)
agent runs day plan → final mustEndAt: spawnPoint → unregisters
```

## Persistent agents

Townsfolk and hired staff are persistent — they don't set
`unregisterOnPlanExhaustion`. The registry's `time:midnight` listener
walks every persistent agent and calls the registered replanner for
their archetype to rebuild the day plan.

```ts
import { registerReplanner } from "../sim/npcRegistry";

registerReplanner("staff:", (agent, dayCount) => {
  // return Activity[] | null
});
```

Replanner key matching: exact archetypeId first, then longest
`<prefix>:` match. So `staff:cook` falls through to `staff:`.

The registry's `replaceDayPlan(npcId, plan)` does the swap atomically:
exits the current activity, drops any held driver claim, resets the
cursor, enters the new first activity. **Don't write your own re-plan
loop** — go through the registry so the lifecycle ordering is right.

## Borrowed-body subsystems

`patronService` (tavern) and `staffService` (jobs) are the two
subsystems that take borrowed bodies today.

The handshake (using patron as the example):

1. `PatronTavernActivity.tickLive` calls `requestSeat(npc, handle)`.
2. `requestSeat` either accepts (capacity available), queues, or
   rejects.
3. On accept, the handle is `transfer`'d into the customerSim's claim.
   The activity drops its handle reference. The FSM drives the body
   from there.
4. When the FSM finishes, it calls `releasePatron(npcId)` →
   `emitPatronComplete(businessId, npcId)`.
5. The activity's listener marks itself complete; the registry
   advances to the next activity in the day plan.

Same shape for `staffService.clockIn` / `emitShiftComplete`.

If the player leaves the interior mid-meal, the service's `stop()`
fires `complete` for every borrowed agent so the activity rolls
forward — the in-flight FSM progress (queue position, ticket state) is
lost. This is intentional: serializing FSM state would mean tying the
business state machine into the registry snapshot, which Phase 5 / 9
chose not to do.

## Save/load

`npcRegistry.serialize()` produces `RegistrySnapshot`. The
`npcRegistrySaveable` (`src/game/save/npcRegistrySaveable.ts`) registers
under the save id `"npcRegistry"`, version 1.

Registration order in `bootSave.ts` matters: businesses, flags, and
quests must hydrate before the registry, so that when an activity's
deserializer looks up its service (e.g. PatronTavern → patronService),
the service is already wired up.

The schema is intentionally permissive on activity payloads
(`data: z.unknown()`); each activity's own deserializer is the
authoritative validator. So adding a field to a single activity does
**not** require bumping `RegistrySnapshot.schemaVersion` — only outer
shape changes do.

A missing `npcRegistry` block in an old save is treated as "no NPCs"
and the spawn pipeline repopulates on the next midnight.

## Where to plug in

Most common tasks:

- **Add a new activity** → `src/game/sim/activities/<name>.ts` + register
  the deserializer in `activities/registry.ts`. See
  `src/game/sim/README.md` for the contract.
- **Add a new archetype** → entries in `npcArchetypes.json` +
  `schedules/<id>.json`. See `src/game/sim/data/README.md`.
- **Add a new spawn group** → `spawnGroups.json` + a Tiled
  `npcSpawnPoint` object with the matching `spawnGroupId`. The
  build-time validator (`tools/validate-spawn-refs.mjs`) catches
  missing references.
- **Add a new borrowed-body subsystem** → mirror `patronService.ts` /
  `staffService.ts`: `register*Service`, `*ServiceProvider` interface
  (with `requestX(npc, handle): Result`), `emit*Complete` event.
  Compose a `GoToActivity` inside your activity — see
  `PatronTavernActivity` as the template.
- **Make an existing townsfolk follow a real schedule** → author an
  `npcResidence` Tiled object with the def id as the residence key.
  `agentBinding.registerAgentForNpcDef` will pick it up and switch the
  agent to the `townsfolk_default` archetype.

## Gotchas

- **Don't write to `agent.body` without a `BodyHandle`.** The runtime
  dev assertion will catch it; the prod warn won't.
- **Don't read live state from a planner.** Planners are pure: archetype
  + calendar + flags in, activity list out. No "what is NPC X
  currently doing" lookups.
- **Don't run live-tick logic for NPCs in a scene the player isn't in.**
  The binder enforces this; activities should only need `tickAbstract`
  to advance state when the scene isn't loaded.
- **`tickAbstract` fires every hour, not every minute.** Same caveat
  for `Browse` / `Idle` durations — they round up to the next hour
  boundary on the abstract side. Phase 9's "minute tick if needed"
  upgrade auto-tightens this without code changes once a consumer
  needs sub-hour precision.
- **A static NPC has no agent.** `agentBinding.buildActivity` returns
  null for `movement.type === "static"`, so the registry never sees
  them. They're driven by `NpcModel` directly (and `NpcModel.tick`
  early-returns for static, so they just stand there).
- **`npcRegistry.setBodyExternal` is a documented hole.** Don't reach
  for it from new code — write through a `BodyHandle` instead.

## Transitional warts (post-Phase-9)

Honest list of things Phase 9 didn't finish, with why and what unlocks
the cleanup:

- `npcRegistryStaff` flag in `staffService.ts`. Default OFF; legacy
  `reconcileStaffSchedule` synthetic-spawn path is alive. Unlock:
  authored `npcResidence` Tiled objects for every hireable. Then
  delete the flag and the legacy synthetic spawn path.
- `npcRegistry.setBodyExternal` and `NpcProxy.sync()`'s reverse
  branch. Used by cutscenes + the legacy staff arrival/departure
  walks. Unlock: migrate cutscene-driven NPCs and any remaining
  scripted-mode legacy drivers to the activity/handle path.
- `WorldTicker.tick`'s `if (npcRegistry.get(model.id)) continue` gate.
  Unlock: delete `NpcModel.tick` (and the wander/patrol logic in
  `NpcModel`) entirely once nobody depends on it.

When in doubt, check `plan/global-npc-state/decisions.md` — every
non-obvious choice in the implementation is logged there with the
reason.

## Phase additions (post-Phase-9 enrichments)

The plan in `plan/npc-schedule-enrichments/` layered the following
extensions on top of the Phase 9 architecture without changing the
registry / body-ownership model:

- **Schedule key resolver** (Phase 1). `data/schedules/<id>.json` is
  now a *bundle* of named variants keyed by day-of-week, season,
  weather, world flags, etc. Resolved per agent per midnight; the
  result is a normal `ScheduleDef` the planner consumes as before.
  Pure, deterministic, save-safe.
- **Conditional `when` clauses** (Phase 2). Variants can carry a
  typed predicate (AND/OR/NOT over `flag`/`agentFlag`/`friendship`/
  `season`/`weather`). Predicates evaluate at midnight only; mid-day
  flag flips do NOT trigger replans (deterministic by design).
- **Hard arrival times** (Phase 3). Templates can declare
  `mustStartAt: <minute>`. The planner pads earlier flexible
  activities with `Idle` to land on the anchor, or trims by up to
  30m. The preceding `GoTo` gets `mustArriveBy` set; abstract
  overshoot warps to the target. Live walks don't teleport — the
  player sees the NPC arrive a little late instead.
- **Festivals as replanner override** (Phase 5). A festival is just a
  high-priority replanner that swaps every participant's day plan on
  the festival day. No parallel system; reuses the Phase 9
  `registerReplanner` machinery.
- **Path robustness** (Phase 6). Materialize-time fallback when live
  A* can't path through player-placed obstacles: try static-only
  collision, then nearest walkable adjacent tile, then warp as last
  resort. Never break placed objects.

The dev schedule overlay (`F9` toggle, behind `import.meta.env.DEV`)
is a fixed-position list of every registered agent — id, scene, mode,
current activity, ETA. Right-click a row to dump the full agent state
to console (resolved variant key, plan annotations, etc.).

## Ambient chats

Two-NPC speech-bubble vignettes that fire when the player is nearby.
Runtime in `src/game/sim/chat/` (director, playback, cooldown store,
predicate evaluator); content in `src/game/sim/data/chats/*.json`.
The director ticks at ~1 Hz from `SceneNpcBinder.update`, narrows
proxies to a ~10-tile radius around the player, walks pairs against
a compile-time index, and hands a winner off to playback. Playback
locks both participants via `model.scripted` (the same flag
cutscenes use), faces them at each other, paces lines through the
typed `npc:speak` / `player:speak` bus events, and aborts on
participant departure / proximity break / `npc:interacted`.

Cooldowns are global per chat-id, persisted alongside other sim
state, and pruned at midnight. See `src/game/sim/data/chats/README.md`
for the data format and authoring guide.
