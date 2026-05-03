# Implementation decisions

Running log of decisions made during implementation that weren't
explicitly spelled out in the phase plans. Each phase appends its
own section. Older sections are not edited unless a later phase
overrides the decision (in which case note the override inline).

---

## Phase 1 — Calendar + day-of-week

- **"Midnight" = day-boundary, not literal 00:00.** The existing
  time system increments `dayCount` at the night→day phase rollover
  (in-game 06:00). `time:midnight` fires there rather than at a
  mid-night fractional check, because (a) `dayCount` is the canonical
  day counter the plan keeps, (b) it's where downstream schedule
  logic will want to plan the next day, and (c) the plan's risk
  note explicitly steered toward "integer-day boundary detection in
  the existing tick loop." A separate true-00:00 hook can be added
  later without breaking this one.

- **Year-end = soft wrap.** `monthOfYear` cycles months indefinitely
  via modulo and reports a 1-based `year` field. The plan defers
  year-end handling; nothing changes when the year flips except the
  `year` field. No "new year" event yet.

- **Calendar flavor.** Picked nautical/elemental month names
  (Frostmoon, Thawmoon, Bloomtide, Sunmoon, Hightide, Embermoon,
  Stormtide, Longnight) and weekday names that fit the sailing/
  forging theme (Lunaday, Forgeday, Tideday, Windsday, Emberday,
  Stormday, Sunday). Year is 8×28 = 224 days. Trivial to swap —
  it's data only.

- **DEV-only HUD surface.** The plan said "debug overlay line";
  implemented as the existing Clock tooltip text in DEV (zero new
  HUD chrome) plus a `dev.calendar()` console command. Avoided
  adding a new HUD widget for a foundation-only phase.

- **`time:midnight` fires before `time:phaseChange`** on the day
  boundary, so listeners that reset daily counters do so before
  "new phase" handlers run.

---

## Phase 2 — Registry skeleton + body handles + activity interface

- **Abstract tick is wired to `time:hourTick` at 60 sim-minutes per
  fire**, not a literal per-minute event. The architecture doc and
  phase plan both say "per-minute," but the time system today only
  emits per-phase and per-hour events, and adding a finer event
  with no consumer would be premature. 60-minute granularity is
  ample for the abstract layer's purpose (planner-level state
  bookkeeping); finer ticks are only needed once activities care
  about sub-hour deadlines, at which point a `time:minuteTick`
  event can replace this without changing the registry API
  (`tickAbstract(simMinutes)` is already minute-based). When that
  happens, also re-evaluate using `time:midnight` to flush any
  end-of-day catch-up.

- **Singleton + auto-wire on import**, mirroring the `bus` module.
  `npcRegistry.ts` exports a global `npcRegistry` and subscribes
  itself to `time:hourTick` at module load. Avoids a separate
  bootstrap step and keeps parity with how other cross-cutting
  systems (bus, time store) are accessed.

- **`BodyHandle` constructor restriction via factory function.**
  TypeScript can't make a public class's constructor private to
  one other module, so `bodyHandle.ts` exports a `createBodyHandle`
  factory that the registry uses internally. Documented as
  "registry-only" in JSDoc; not exported from `sim/index.ts`. The
  registry's `_writeBody` / `_isActiveDriver` / `_transferDriver` /
  `_releaseDriver` methods are likewise leaked structurally (as
  `BodyHandleRegistry`) so handles can validate themselves without
  importing the registry concretely (avoids a cycle).

- **Stale-handle write is an error in DEV, a console-warn no-op in
  PROD.** The plan said dev assertion only; chose to keep a soft
  warn in prod rather than crash the player out of the game on a
  programmer mistake that has already been written to the wrong
  body once anyway.

- **Day plan exhaustion auto-unregisters the agent.** Phase 2 has
  no scheduler / planner / re-plan-at-midnight loop yet, so once
  an agent's `dayPlan` is exhausted with no follow-up activity it
  is unregistered from the world. Lets the dev no-op test loop
  terminate cleanly. Phase 6 (scheduler + tourist archetype) will
  replace this with planner-driven re-planning at `time:midnight`
  rather than removing the agent.

- **Activity hydration uses an explicit kind→deserializer registry
  (`activities/registry.ts`).** Snapshots store `{ kind, data }`
  pairs; loading dispatches by kind. Built-ins (currently just
  `noop`) self-register at module import. Every later phase that
  adds an activity has to register its deserializer alongside it.

- **`ActivityCtx.live` carries scene/pathfinder as opaque `object`
  refs**, not as `Phaser.Scene` / pathfinder types. The sim layer
  has zero Phaser imports. Adapters cast on the way in. The
  binder phase can tighten this if a stronger contract turns out
  to be useful.

- **Scene event order on `setLocation` cross-scene moves: `npcLeftScene`
  fires before `npcEnteredScene`.** Lets the previous scene's
  binder tear down its proxy before the new one tries to spawn
  one (avoids a moment of double-presence).

---

## Phase 3 — SceneNpcBinder + migrate Wander

- **Old `NpcModel.tick` AI is gated on agent presence, not deleted.**
  The phase plan said "old tick path deleted in this phase, not
  flagged off." In practice deleting it would freeze every
  customerSim-spawned customer (and, secondarily, the staff path)
  because those NPCs are constructed with `new NpcModel(def, mapId)`
  outside `bootstrapNpcs` and don't yet have agents. Phases 5 and 8
  will migrate customerSim and the staff service. Until then,
  `WorldTicker.tick` skips models whose `id` resolves to an existing
  agent (via `npcRegistry.get(model.id)`) and runs the legacy AI for
  the rest. Both paths can never run for the same NPC in the same
  frame, which matches the "no double-update" risk note in the phase
  plan. This is the override flagged in the Phase 3 plan; remove the
  gate in Phase 9 once every NPC creation path goes through
  `registry.register`.

- **`NpcModel` is kept whole, not stripped to "rendering glue."** The
  plan envisioned `NpcModel` shrinking to just the rendering contract
  used by `NpcProxy`. But cutscenes, `customerSim`, and the editor
  all interact with `NpcModel.scripted`, `setPositionPx`,
  `faceToward`, `returnHome`, and `rebindHome`, and the legacy AI is
  still required for un-migrated NPCs (above). So `NpcModel.ts` is
  unchanged in shape; the file-path-stable rename mentioned in the
  phase plan is deferred. The `tick` method survives but is no-op for
  agent-managed NPCs because `WorldTicker` skips them before calling.

- **Scripted NPCs short-circuit the activity tick at the binder
  level, not inside activities.** When `NpcModel.scripted === true`
  (set by cutscenes, customerSim, the staff service, or any other
  legacy driver), the binder passes a `skip` predicate to
  `registry.tickLive` so the activity is paused without any awareness
  of the legacy contract. The proxy then mirrors model→body each
  frame so the activity resumes from a consistent position when
  scripting ends. This keeps `Activity` ignorant of legacy concerns
  and concentrates the bridging logic in one place.

- **Body↔model mirror is bidirectional in the proxy, with a
  documented bypass for scripted NPCs.** Default direction is body→
  model (canonical sim → presentation). Under `scripted=true` the
  direction reverses, using a new transitional bypass
  `npcRegistry.setBodyExternal(npcId, patch)` that writes the body
  without holding a `BodyHandle`. This is a deliberate, documented
  hole in the "exactly one driver" invariant — the cost of
  half-migrating customerSim/staff/cutscenes. Phases 5 and 8 remove
  it once those drivers go through the activity/handle path.

- **`LiveCtxBindings` carries a `walkable` probe.** `architecture.md`
  only mentions `pathfinder` on the live ctx, but the legacy
  Wander/Patrol movement uses an axis-projected wall slide against a
  walkability oracle, not full pathfinding. Adding `walkable` to the
  live bindings (typed as `(px, py) => boolean`, no Phaser dep) is
  cheaper than threading the pathfinder for what each activity
  actually needs. `pathfinder` stays on the interface for Phase 4's
  `GoTo`.

- **`tickLive` accepts an optional `skip` predicate.** Needed for the
  scripted-NPC short-circuit above. The alternative (binder loops
  manually and calls `act.tickLive` directly, exposing
  `maybeAdvanceCompleted` publicly) leaks more registry internals.
  `opts.skip` keeps the registry's public surface small.

- **`materializeScene` / `dematerializeScene` on the registry.**
  Added so the binder doesn't have to iterate `npcsAt` and call
  `act.materialize?.(...)` itself — keeps the per-scene lifecycle
  symmetric with `tickLive`. Optional `materialize`/`dematerialize`
  on `Activity` are unchanged from `architecture.md`.

- **`MapId.world` → `SceneKey "chunk:world"`.** The current world
  scene is a single map (chunked under the hood, but presented as one
  scene). Phase 4's portal/cross-scene work will likely split this
  per-chunk, at which point `sceneKeyForMapId` switches to a chunk
  coordinate. Until then, `chunk:world` is a single bucket — every
  authored world NPC is at that scene key.

- **Legacy `def.spawn` mutation + `rebindHome` in `customerSim` no
  longer reaches the wander activity.** customerSim writes to
  `model.def.spawn` and calls `rebindHome()` so the wander radius
  re-centers on the workstation when staff arrives. The new
  `WanderActivity` snapshots its `home` at activity-creation time and
  doesn't re-read `def.spawn`. For staff this is currently a no-op
  because `synthesizeStaffNpc` passes the workstation tile in as
  `def.spawn` (so the activity is already centered there); the
  rebind path matters for "depart entry → walk to workstation"
  flows. Phase 5/8 service-rewrites of customerSim/staff will replace
  this with explicit activity replacement. Documented here so the
  silent semantic shift is on the record.

- **Activity claimant marker is a plain object, not `Symbol`.**
  `BodyHandle.claimant: object` doesn't accept `symbol`. Each
  activity defines a private `const CLAIMANT = { name: "..." }`
  singleton — uniqueness comes from object identity, not a symbol.
  Trivial; noted only because the architecture doc didn't pin this.

- **Wander/Patrol abstract ticks bypass `BodyHandle` for the body
  position update.** Abstract ticks happen with no live driver
  competing for writes (player isn't in the scene), and claiming +
  releasing a handle every minute just to nudge a tile feels like
  ceremony. The activities cast `npc as { body }` and assign
  directly. Documented as a known "transitional" wart; if abstract
  contention ever becomes a real concern, switch to a registry-level
  `setBodyExternal` call (already exists for the proxy bypass).


---

## Phase 4 — GoTo + cross-scene movement

- **Portal registry registers both directions when a door is parsed,
  with a placeholder reverse `fromTile = (entryTx, entryTy + 1)`.**
  The phase plan only spelled out "world → interior at world load."
  But abstract `GoTo` planning needs the reverse link too — the
  "in neither scene" validation case has the player elsewhere while
  an NPC abstractly walks out of an interior, and we don't want
  `GoToActivity.plan` to fail just because the player hasn't visited
  the interior live yet this session. The placeholder is refined to
  the real `interior_exit` tile when `InteriorScene.create` runs (via
  `portalRegistry.registerInteriorExit`). The +1 south fallback
  matches the convention every existing interior follows (entry
  authored 1 tile above the exit), so even un-refined links land on
  a believable threshold.

- **Multi-portal routing is rejected, not chained.** `GoToActivity.plan`
  returns `null` when the source and target scenes are not connected
  by a single portal — the caller is expected to compose two `GoTo`s
  in the planner (Phase 6 work). Plan file lists multi-portal as
  out-of-scope; this is just calling out the API shape.

- **`Pathfinder` is now a typed live-ctx binding, not opaque.** Phase 2's
  `LiveCtxBindings.pathfinder` was typed as `object`. Phase 4 needs to
  actually invoke it for `GoTo` live-mode A*, so a `Pathfinder`
  function type was added in `activities/activity.ts`
  (`(query) => PathWaypoint[] | null`) and the binder wraps
  `pathfindPx` against the active scene's walkability oracle when
  attaching. Sim layer still has zero Phaser imports — `PathWaypoint`
  is a plain `{x,y}` mirror of the adapter's `Waypoint`.

- **Cross-scene `setLocation` body-state bypass on portal traversal.**
  When `GoToActivity.completeLeg` traverses a portal, it calls
  `ctx.registry.setLocation` (which fires leftScene→enteredScene) and
  then writes the entry-tile pixel directly to `npc.body` via a
  `(npc as { body }) = {...}` cast — same wart Wander/Patrol
  documented in Phase 3 for abstract nudges. The justification is
  identical: there's no live driver competing for writes across the
  cross-scene boundary (the source proxy is being torn down and the
  destination one hasn't materialized yet). Switch to the
  `setBodyExternal` registry path if competing writers ever appear.

- **`materializeNpc` / `dematerializeNpc` (single-agent variants).**
  Added to `NpcRegistry` so the binder's `npcEnteredScene` /
  `npcLeftScene` listeners can fire materialize/dematerialize on
  exactly one agent, instead of running the whole-scene variants
  (which would re-run materialize for every NPC already in the scene
  every time anyone crosses the boundary). Symmetric naming with the
  scene-wide variants kept on the registry.

- **Auto-track entity-registry `mapId` on `npcEnteredScene`.**
  `agentBinding.ts` now subscribes once at module load to the sim
  registry's `npcEnteredScene` event and updates the paired
  `NpcModel`'s `entityRegistry.setMap(...)` to match. Without this,
  an NPC crossing a portal mid-`GoTo` would update its agent location
  but its model would stay attached to the source scene's `MapId` —
  the source `SpriteReconciler` would still render the sprite there,
  and the destination's would never see it. Adding the listener at
  the binding layer (rather than inside the binder) keeps it scene-
  load-independent: even if neither scene is loaded when an NPC
  transitions, the model's `mapId` stays correct so the next scene
  load picks it up. Required `mapIdForSceneKey` (the inverse of
  `sceneKeyForMapId`).

- **`portalRegistry.clear()` on world load.** WorldScene's
  initialization clears the registry before the chunk-ready callbacks
  fire, so a hot-reload or re-entry into the title doesn't leave
  stale portals behind. Interior exit refinements re-register on
  next interior load, which is naturally bounded by player travel.

- **Materialize fallback on unwalkable interpolated tile.** The phase
  plan called for "validates against the pathfinder's walkability
  oracle; falls back to nearest walkable tile." Implemented as a
  simpler oracle-only check that snaps to the leg's `startTile`
  when the interpolated point fails — "nearest walkable tile" search
  felt like premature complication for what is a cosmetic-only
  bailout (the activity's first live tick will re-pathfind to the
  leg end from wherever materialize landed). Bump to a real flood-
  fill if a materialize-on-wall bug actually shows up.

- **`PATH_MAX_AGE_MS = 4000` on the live path cache.** The plan's
  "abstract travel-time estimate diverges wildly from live pathfind
  time" risk note didn't suggest a specific live-stale heuristic, but
  without one a wedged path would spin forever. Four seconds is long
  enough that a normal cross-room walk completes on its first cache
  but short enough that a wedged NPC re-pathfinds before it looks
  visibly broken. Tunable.

- **Dev console exposes `sim.testGoTo` and `sim.listPortals`.** Phase
  plan mentions `sim.testGoTo`. `listPortals` was added alongside —
  trivial wrapper, useful for confirming registration during Phase 4
  validation.

- **Day plan replacement on `testGoTo`.** The dev hook overwrites
  `agent.dayPlan` / `currentActivity` directly. This is *not* the
  planner-driven swap path; it's a force-test path. Phase 6's
  scheduler will introduce a proper "interrupt + replan" surface.

---

## Phase 5 — PatronTavern + customerSim refactor

- **Legacy synthetic-spawn path is gated, not removed.** The phase
  plan's deliverables list said "Remove `spawnCustomer()` and the
  synthetic `NpcDef` creation path," but the same plan also
  specifies a feature flag whose flag-off behavior is "existing
  `spawnCustomer` path runs unchanged" — and the flag's lifetime
  spans phases 5–9. Resolution: `spawnCustomer` early-returns when
  `npcRegistryPatrons.enabled` is true, otherwise runs the legacy
  path verbatim. Phase 9 deletes the body of `spawnCustomer` and
  the flag together.

- **`Customer.borrowed: BorrowedDriver | null` discriminator instead
  of two parallel customer types.** The 14-state FSM is shared
  identically between owned and borrowed customers; only the body-
  write side and the despawn side differ. A nullable `borrowed`
  field on `Customer` keeps the FSM single-pathed. Owned customers
  still create a synthetic `NpcDef` + `NpcModel` and write directly
  to model fields; borrowed customers reference an existing
  `NpcAgent` + `BodyHandle`, and writes flow through both the model
  AND the handle so per-tick FSM reads of `c.model.x/y` stay fresh
  within the same frame (the proxy mirror only runs after the
  customerSim tick).

- **`stepNpcToward` and `stepWalker` accept an optional
  `BodyHandle | null` parameter.** The motion functions are shared
  between customers and staff; threading a nullable handle keeps
  one implementation. Customer call sites pass
  `c.borrowed?.handle ?? null`; cook/server/bartender/staff call
  sites use the default `null`. After the customer's normal
  `model.x = nx` write, the function additionally calls
  `handle.setPosition(model.x, model.y)` / `setFacing` / `setAnim`
  when a handle is supplied. Two writes per move (one model, one
  handle) is the "correct" path while the legacy mirror exists —
  Phase 9 removes the model write once owned customers are gone.

- **Borrowed customers stay `model.scripted = false`.** Phase 3
  established that `scripted = true` reverses the proxy mirror to
  model→body via `setBodyExternal`, bypassing the BodyHandle —
  documented as a transitional hole to be closed by Phases 5/8.
  Closing it for customers means writes go through the handle and
  presentation flows body→model normally. The binder's
  `skip` predicate (`model.scripted === true`) therefore does not
  fire for borrowed customers, so `PatronTavernActivity.tickLive`
  runs each frame — by design it's a no-op while the patron is in
  the "inside" phase (the service holds the handle and the
  activity is just waiting on the completion event).

- **`requestSeat` admission gate is the existing capacity check.**
  No new queue data structure; `Queued{etaMs}` is computed from
  current `customers.length - capacity + 1` × an estimated
  per-seat clear time (`MEAN_DWELL_MS / capacity`). The existing
  bar queue inside the FSM still handles in-room queueing for
  ordering / paying. This keeps the capacity contract single-
  sourced and avoids parallel state. Phase 6's scheduler can refine
  the eta heuristic if real numbers turn out to be needed.

- **Body handoff via `BodyHandle.transfer`, not raw reference
  passing.** Inside `requestSeat`, the call
  `handle.transfer(this.serviceProvider)` returns a fresh handle
  bound to the CustomerSim claimant (the `serviceProvider` object
  identity); the activity's old handle reference is invalidated by
  the transfer and the activity is documented to drop it on
  `accepted`. This makes the dev assertion in `BodyHandle.write`
  catch any rogue write from the activity post-transfer.

- **Completion is one-way: `releasePatron` → `emitPatronComplete`
  → activity listener.** No bidirectional handle return. The
  service simply releases the held handle when the FSM finishes,
  and emits a `(npcId)` notification. The activity's onPatronComplete
  listener sets `runtime.phase = "done"`; the registry's
  `maybeAdvanceCompleted` then exits the activity (which would
  re-release a held handle if any survived) and the next activity
  in the day plan claims a fresh body. Cleaner than juggling a
  handle round-trip and matches the architecture doc's "subsystems
  return the handle on completion" intent (release == return).

- **Service teardown calls `emitPatronComplete` per held patron in
  `stop()`.** When the player leaves the interior, `CustomerSim.stop`
  fires the completion event for every borrowed patron currently
  inside, even if they were mid-meal. The activity transitions to
  `done` and the next activity (if any) takes over. This loses the
  in-tavern progress for that visit; preserving it would require
  serialising the FSM state into the activity, which is out of
  scope for Phase 5 (Phase 9's save/load work covers it). The
  `dematerialize` hook on `PatronTavernActivity` is a no-op for
  the same reason — we let the service-side teardown drive
  completion rather than poking the service from the activity.

- **`PatronTavernActivity` owns an inner `GoToActivity`, not a
  base-class `WalkAndThenDo` derivation.** The `WalkAndThenDo`
  base class only models a single in-scene walk; the patron's
  approach is a real cross-scene `GoTo` (world → portal → tavern
  interior) with portal-aware pathfinding. Composing a real
  `GoToActivity` instance and delegating its `enter`/`tick*`/`exit`
  /`materialize`/`dematerialize` is simpler than extending
  `WalkAndThenDo` to understand portals. The same composition
  pattern will be reused by `WorkAt` in Phase 8.

- **Abstract dwell is a flat duration timer (default 40 sim-min).**
  When the player is not in the tavern, the patron's "inside"
  phase is just a countdown; no service interaction happens. This
  matches the plan's "collapses to 'patron is in tavern for ~D
  minutes' using the existing FSM's typical duration" wording.
  Picked 40 minutes as the rough median of the live FSM's path
  (queue 0–10s + order 4s + walk 1–2s + eat 6s + walk 1–2s + pay
  4s, scaled at the current SIM_RATE). Tunable per-config via
  `abstractDwellMinutes`.

- **Materialize while `abstractDining` re-runs `requestSeat`.**
  When a player walks into the tavern with an abstract patron
  mid-dwell, the activity's next live tick calls `requestSeat`
  fresh. If accepted, the FSM picks up from "enter" (i.e. the
  patron walks in from wherever the abstract layer parked them).
  This intentionally drops the abstract dwell-timer remainder;
  the live FSM's natural duration is similar enough that the
  visual effect reads as continuous. An always-correct "resume
  exactly where the abstract sim left off" path needs FSM-state
  serialisation that doesn't exist yet — same Phase 9 gap as
  above.

- **Feature flag is a mutable `{ enabled: boolean }` in
  `patronService.ts` toggled via `dev.sim.setPatronFlag(true)`.**
  Default off. The flag lives in the same module that publishes
  `requestSeat` so legacy and new paths can't drift to different
  flag sources. Phase 9 deletes the flag and the legacy path
  together.

- **Dev console: `sim.testPatron(npcId, businessId, sceneKey, tx,
  ty)` and `sim.setPatronFlag(bool)`.** The plan's manual probe
  ("dev console spawns a registry NPC at the tavern door with
  `[PatronTavern(rusty_anchor)]`") is split into two parts: spawn
  the agent via the existing `sim.spawnNoop` (or wait for
  Phase 6's spawn pipeline), then `sim.testPatron(...)` to swap
  its day plan for a single PatronTavern. Same shape as
  `sim.testGoTo`.

---

## Phase 6 — Scheduler + Tourist archetype + spawn pipeline

- **Anchor resolution lives in a `WorldAnchorRegistry` singleton
  (`sim/planner/anchors.ts`).** The architecture doc spelled out
  template `target` shapes (`spawnPoint`, `businessArrival`,
  `namedTile`) but didn't say where the lookup table lived. Anchor
  keys are namespaced strings (`spawnPoint:<groupId>`,
  `businessArrival:<id>`, `namedTile:<name>`). World load clears it
  in `WorldScene` next to `portalRegistry.clear()`. Door
  registration in `WorldScene` populates `businessArrival:<interiorKey>`
  *and* `businessArrival:<businessId>` (via
  `businessIdForInteriorKey`) so schedules can address either name
  interchangeably — `template.target.businessId` field is treated as
  "interior or business id."

- **Spawn dispatcher: per-day schedule built at midnight, flushed on
  hour ticks.** `sim/planner/spawnDispatcher.ts` self-wires to
  `time:midnight` and `time:hourTick` at module import (mirrors
  `npcRegistry`). Per-group arrival times are picked by a
  deterministic mulberry32 seeded `hashSeed("groupId|day") ^ dayCount`
  so a re-load mid-day reproduces the same arrival schedule. The
  dispatcher also flushes when a new spawn point registers — handles
  the architecture-doc race where chunk-ready arrives after the
  midnight tick.

- **Hour-granularity arrivals.** Plan said arrivals "at random times
  during the day"; abstract clock today only emits `time:hourTick`,
  so an arrival lands within ±1 hour of its target minute. Fine for
  Phase 6 — finer cadence buys nothing visible until Phase 9 wires a
  proper minute tick. The scheduler still records minute-precise
  arrival times so a later finer event can drive them precisely
  without changing the data shape.

- **`flags.unregisterOnPlanExhaustion` opt-in replaces the Phase 2
  auto-unregister.** Tourists are ephemeral — they set the flag at
  spawn time and the registry removes them when their plan ends.
  Persistent agents (Phase 9 townsfolk, Phase 8 hired staff) won't
  set the flag and will idle with `currentActivity = null` until
  Phase 9 introduces per-archetype re-planning. Behavior matches the
  Phase 2 placeholder for tourists; the explicit flag makes it safe
  to register persistent agents without them disappearing on first
  plan exhaustion.

- **No `time:midnight` re-plan loop for existing agents in Phase 6.**
  The plan's "midnight, iterate registered spawn groups" hook is
  implemented; the parallel "iterate existing persistent agents and
  re-plan their day" hook is deferred to Phase 9 because there are
  no persistent registry-managed agents yet (authored townsfolk
  still run wander/patrol via `agentBinding.ts` with no day plan to
  re-roll).

- **`browse` templates declared in `tourist.json` but skipped by the
  Phase 6 planner.** The architecture/plan doc lists "browse general
  store / blacksmith" in the tourist schedule, but `BrowseActivity`
  is Phase 7 work. The schedule data carries the templates; the
  scheduler logs them as `skippedTemplateIds`. Phase 7 registers the
  activity kind and removes the skip — no schedule change required.

- **`wander` / `idle` templates collapse to `NoopActivity` after a
  `GoTo` to the target tile.** The existing `WanderActivity` loops
  forever (its `isComplete` returns false) and isn't suitable as a
  bounded day-plan step. Rather than retrofit a duration onto
  `WanderActivity` mid-phase, the planner emits `GoTo + Noop(d min)`.
  Visually the tourist walks to the spot and stands; the dwell
  collapses correctly under the abstract clock. Phase 7 adds proper
  duration-bounded Wander / Browse / Idle activities and the
  scheduler swaps in those classes.

- **PatronTavern is its own approach — planner never prefixes a
  `GoTo`.** `PatronTavernActivity` already composes an inner cross-
  scene `GoTo` (Phase 5 decision); planner just invokes
  `PatronTavernActivity.plan(npc, config)` with the tavern interior
  arrival anchor. Cursor advances to the arrival tile so any
  follow-up activity computes its travel from there.

- **Final `mustEndAt: spawnPoint` appends a `GoTo` back to the
  arrival tile.** The "departure" template the architecture doc
  mentioned isn't a separate template kind — the planner inserts a
  closing `GoTo` whenever the cursor doesn't already match the
  `mustEndAt` anchor. Tourists therefore always exit via the same
  dock they arrived at, which then triggers the `unregisterOnPlanExhaustion`
  removal. No template authoring required.

- **Synthetic `NpcAgent` for plan-time `GoToActivity.plan` /
  `PatronTavernActivity.plan`.** Both planners read `npc.location`
  (and nothing else) to project a route. The scheduler builds a
  throwaway agent with just enough fields populated, advances its
  `location` cursor as activities are appended, and never registers
  it. Avoids leaking a "planning-only" registry state.

- **Spawn point uid is stamped by `tools/stamp-uids.mjs`.** Added
  `npcSpawnPoint` to `SPAWN_LAYER_TYPES` so the standard
  `npm run maps` pipeline auto-stamps a uid on first build, mirroring
  how doors / item spawns / interior exits are handled. Build-time
  validation (`tools/validate-spawn-refs.mjs`) is wired into
  `validateWorld` rather than living as a separate `npm run` script
  — fewer steps for authors to remember.

- **`npcRegistryPatrons` feature flag default flipped to ON.** Phase 5
  shipped the flag default-off; Phase 6 turns it on now that the
  scheduler can produce real tourist day plans that include
  `PatronTavern`. Legacy `spawnCustomer` is therefore suppressed by
  default. The dev console toggle (`dev.sim.setPatronFlag(false)`) is
  the bail-out switch if a tavern-side bug surfaces. Phase 9 deletes
  the flag and the legacy spawn path.

- **Empty plans are dropped, not spawned.** When the scheduler
  produces zero activities (every template skipped or rejected for a
  given seed/calendar), the dispatcher logs a warning and skips the
  arrival entirely — better than spawning a tourist that registers
  and immediately auto-unregisters because its plan exhausts in a
  single tick.

- **Dev console additions: `sim.listAnchors`, `sim.dispatcher`,
  `sim.previewPlan`, `sim.spawnNow`.** The plan only spelled out
  the spawn pipeline mechanics; these surfaces make Phase 6's "play
  3 in-game days" validation tractable without waiting for the
  midnight tick. `previewPlan` runs the scheduler without spawning,
  and reports both chosen and skipped template ids — useful for
  diagnosing anchor misses.

---

## Phase 7 — Browse + Idle support activities

- **`durationMinutes` is an optional config field on `WanderActivity`,
  not a separate `TimedWander` wrapper.** The phase plan offered both
  options; chose the in-place extension because the live FSM is
  identical and a wrapper would just thread events through. When
  `durationMinutes` is omitted the activity loops forever (preserves
  the legacy townsfolk wander behavior); when set, abstract ticks
  decrement a `remainingMinutes` counter and `isComplete()` returns
  true once it hits zero. Live tick is unchanged. The `materialize`
  reset preserves the remaining counter so a player walking into the
  scene mid-wander doesn't reset the dwell timer.

- **Authored townsfolk Wander callers (`agentBinding.ts`) keep
  `durationMinutes` unset → infinite loop preserved.** Only the
  scheduler emits timed Wanders, so existing patrols/wanders keep
  their pre-Phase-7 behavior.

- **Browse / Idle drain duration via the registry's abstract tick,
  not a live-time accumulator.** The registry's `tickAbstract` fires
  on `time:hourTick` (every in-game hour) for every agent regardless
  of whether the scene is loaded — see Phase 2 decision on hour-tick
  granularity. So a tourist's 10-minute browse completes on the next
  hour boundary even with the player watching, and we don't need a
  parallel real-ms drain inside `tickLive`. Cost: minute-precision
  durations round up to the next hour boundary, same caveat as the
  rest of the abstract layer. Phase 9's "minute tick if needed"
  upgrade auto-tightens this without code changes.

- **`BrowseActivity` has no counter-interaction event in this phase.**
  The plan describes an optional "walk to the counter and trigger a
  browsed event" with low probability and no UI. Skipped because
  there is no consumer (no shopkeeper greeting / sales hook listening
  yet) and the risk note explicitly warns it would land as noise.
  When a consumer appears, add a `counterTile` to `BrowseConfig` and
  a `counterChance` knob; the activity's pause→pick branch is the
  natural place to fire the event. Out of scope for Phase 7's
  validation.

- **Browse waypoints live in their own registry
  (`sim/planner/browseWaypoints.ts`), not under `worldAnchors`.**
  `WorldAnchorRegistry` is 1:1 (`spawnPoint:groupId` → one tile);
  browse needs N tiles per shop+group, so a separate
  `BrowseWaypointRegistry` keyed `<interiorOrBusinessId>:<groupId>`
  with a list value is cleaner than overloading anchors. Same
  dual-key registration pattern as Phase 6's
  `businessArrival:<interiorKey>` / `businessArrival:<businessId>`
  so schedule data can address either name. Default group id is
  `"all"` and is what the scheduler passes when a template doesn't
  specify one.

- **Browse waypoint registration on InteriorScene create / clear on
  shutdown.** Mirrors how `portalRegistry.registerInteriorExit` is
  driven from the interior scene's lifecycle. A re-entry into the
  same interior re-seeds rather than accumulating duplicates. World
  load doesn't clear browse waypoints globally — interior shutdown
  is sufficient because waypoints are interior-local.

- **`npcBrowseWaypoint` Tiled object class added to interior spawn
  parsing and `tools/stamp-uids.mjs`.** Custom property
  `browseGroupId` (string, optional) — defaults to `"all"`. Uid is
  required and stamped automatically by `npm run maps`. No
  build-time validator wired up (unlike `npcSpawnPoint` which
  references `spawnGroups.json`); browse waypoints don't reference
  external JSON, so the parsing-time uid check is sufficient. Map
  authoring (placing 4–6 waypoints per shop) is left to the user as
  it requires Tiled GUI work the agent shouldn't be doing in code.
  Until those waypoints exist, `BrowseActivity` falls back to
  standing-with-occasional-facing-changes — visually equivalent to
  `IdleActivity`, so tourists in shops still read as alive.

- **`BrowseActivity` `livePathAgeMs` budget is `4000ms` (matches
  GoTo's `PATH_MAX_AGE_MS`).** Same justification: long enough that
  a normal cross-room hop completes on first cache, short enough
  that a wedged NPC re-picks before looking glitchy. On timeout the
  activity falls back to a pause and re-picks a different waypoint,
  which is more forgiving than GoTo's "snap to next leg" since
  Browse has no progress to lose.

- **Scheduler dwell-kind dispatch is now an explicit if-cascade, not
  a `Set` membership test.** The Phase 6 `SUPPORTED_DWELL_KINDS` set
  paired with a single `NoopActivity.create` call; Phase 7 needs a
  per-kind class choice (`BrowseActivity` / `WanderActivity` /
  `IdleActivity`) plus per-kind config quirks (browse needs a
  businessId, wander needs a radius), so an explicit if-cascade
  reads better than a lookup table. The `goTo` template branch
  stays separate because it doesn't share the "approach + dwell"
  shape.

- **Dev console probe `sim.listBrowseWaypoints(filter?)`.** Mirrors
  `sim.listAnchors`. Accepts an optional substring filter. Useful
  for confirming map authoring did register waypoints under both
  the interior key and the business id form.


---

## Phase 8 — WorkAt + staff service refactor

- **`npcRegistryStaff` flag default is OFF.** Per the phase plan; the
  legacy `reconcileStaffSchedule` synthetic-spawn path runs unchanged
  out of the box. Phase 9 deletes the flag and the legacy path
  together (mirroring how Phase 6 flipped the patron flag on after
  the scheduler could feed it real day plans). The bootstrap that
  registers per-hire NpcAgents is also flag-gated, so flag-off
  bundles produce zero registry-driven staff agents.

- **`WorkAtActivity` mirrors `PatronTavernActivity` rather than
  extending `WalkAndThenDo`.** Same justification as Phase 5: the
  approach is a real cross-scene `GoTo` (residence → portal →
  business interior), and `WalkAndThenDo` only models a single
  in-scene walk. Composing a real `GoToActivity` instance and
  delegating its `enter`/`tick*`/`materialize`/`dematerialize` is
  simpler than teaching `WalkAndThenDo` about portals. This is now
  the second activity using the pattern; it's effectively the
  template for any future "walk somewhere cross-scene, hand body to
  a service, await completion event" activity.

- **`SleepActivity` is its own kind, not an `IdleActivity` alias.**
  The plan called for "minimal: NPC stands/lies at home tile."
  `IdleActivity` already does the standing-around bit, but it has a
  pacing radius / pose-cycle FSM that the activity layer's
  abstract-tick contract doesn't actually need for Sleep. A
  dedicated `SleepActivity` is ~110 lines vs. the wrapper-with-knobs
  alternative, and a distinct `kind` ("sleep" vs. "idle") makes
  serialized day plans readable. The future bedroll/lying anim and
  "rests at table when home tile is in a tavern" will live here.

- **Borrowed staff stay `model.scripted = false`; role-agent step
  writes thread the held BodyHandle.** Same pattern Phase 5
  established for borrowed customers — closes the documented
  "transitional hole" in the `setBodyExternal` proxy bypass for
  every cook/server/bartender clocked in via `WorkAtActivity`. The
  step functions (`stepWalker`/`stepNpcToward`) already accepted an
  optional handle parameter; Phase 8 just supplies one for borrowed
  staff. Legacy synthetic-spawn staff (flag off) keep
  `model.scripted = true` and the proxy mirror, unchanged.

- **`unscriptCook` / `unscriptServer` / `unscriptBartender` are
  skipped for borrowed staff.** They write `model.scripted = false`
  + `animState = "idle"` — fine for owned synth NPCs but, for
  borrowed bodies, the handle is the canonical writer, so calling
  `unscript*` after a step would be redundant. The role-agent ticks
  branch on `handle === null` to choose between the legacy unscript
  path and a direct handle write of `idle`. Pre-existing
  unscript* helpers are untouched (still used by `stop()` /
  `releaseAll*Scripting()` in non-borrowed teardown paths).

- **`clockIn(npc, handle, role)` extracts the hireable id from the
  npc id (`npc:staff:<bizId>:<hireableId>`).** Avoided adding a
  `hireableId` field to `NpcAgent` for one consumer. The bootstrap
  in `staffAgentBootstrap.ts` constructs agents with that exact id
  format, mirroring `synthesizeStaffNpc`. If a future consumer
  needs a stronger contract, promote it to `npc.archetypeId` or
  `npc.flags`.

- **Hire-pipeline gating: agent registered only when a residence
  exists.** `staffAgentBootstrap.ts` subscribes to
  `business:staffChanged` and reconciles per business; it
  registers an agent only when the residence registry has a tile
  for the hireable AND the business arrival anchor is registered.
  No residence → no agent, even with the flag on; the legacy
  `reconcileStaffSchedule` path still runs (because customerSim
  doesn't see a borrowed staffer for that hire). This means
  authoring a residence opts a single hireable into the new path
  without affecting others — useful for incremental rollout
  before Phase 9 finishes the migration. Authoring residences is
  left to the user (Tiled GUI work), per CLAUDE.md.

- **`reconcileAllStaffAgents()` fires on every chunk-ready, not
  just once at world load.** Mirrors how `worldAnchors` and
  `residences` get populated as chunks become ready — by hooking
  the same callback the bootstrap can register agents for hires
  whose residence happens to live in a chunk that loads later.
  Idempotent: re-registering an existing agent unregisters the
  old one first.

- **Baseline schedule is a fixed-duration template, not
  calendar-aligned.** Phase 8's day plan is `Sleep(360min) →
  WorkAt(480min) → GoTo(home) → Sleep(600min)`. The activity
  layer's abstract clock advances each step; sleep duration loosely
  approximates morning/evening rest without consulting the
  business's `openMinute`/`closeMinute`. Once the plan exhausts
  the agent idles with `currentActivity = null` (the
  `unregisterOnPlanExhaustion` flag from Phase 6 stays unset for
  staff so they don't disappear). Phase 9's "midnight re-plan"
  will replace this with a calendar-aligned schedule. The
  WorkAt service's clock-in is the safety net: rejected when the
  business is closed → activity marks done → next day-plan step
  fires.

- **`reconcileStaffSchedule` close-edge clocks out borrowed staff
  via `clockOutImpl`.** Symmetric with Phase 5's `stop()` →
  `emitPatronComplete` for patrons. When the staff-present window
  ends and the legacy path would walk owned staff out the door,
  the new path emits shift-complete for every borrowed staffer so
  their `WorkAtActivity` finishes and the day plan rolls forward
  to `GoTo(home)`. Fired-mid-shift is handled in the same place:
  any borrowed staffer whose `hireableId` is no longer in
  `state.staff` gets `clockOut` called.

- **`stop()` (scene exit) drops the held handle and emits
  shift-complete per borrowed staffer.** Same pattern as the
  patron path — preserves the activity contract that
  "subsystems return the handle on completion." Loses any
  in-flight FSM progress (mid-cook, mid-pour) for that visit;
  acceptable for Phase 8, mirrors the patron-side gap that
  Phase 9's save/load will close.

- **Dev console: `sim.testWorkAt`, `sim.setStaffFlag`,
  `sim.listResidences`, `sim.listStaffAgents`.** Same surface as
  Phase 5/6's testPatron/setPatronFlag. `listResidences` is the
  fastest way to confirm `npm run maps` stamped the
  `npcResidence` uids correctly; `listStaffAgents` shows what
  the bootstrap registered (per-business npcId list). The
  legacy spawn path stays the default until the user opts in via
  the flag.


---

## Phase 9 — Townsfolk migration + cleanup + save/load

- **Save/load wiring is a stand-alone `npcRegistrySaveable`, registered
  last in `bootSave.ts`.** Order matters: businesses + flags + quests
  hydrate first, so when the registry's hydrate restores a mid-meal
  `PatronTavernActivity` and the activity's deserializer looks up the
  patron service for that business, the service is already wired up.
  Schema validation is permissive on the activity payload (`data:
  z.unknown()`) — each activity's deserializer is the authoritative
  validator. Bumping the registry's `SCHEMA_VERSION` is therefore only
  required when the *outer* shape changes, not when an activity adds
  fields.

- **Mid-FSM resume vs. reset on reload.** Phases 5 and 8 deferred this:
  a `stop()` mid-meal / mid-shift drops the held handle and emits the
  completion event so the activity rolls forward. Phase 9 keeps that
  policy. The registry snapshot preserves the *activity* (so the patron
  is still recorded as "in PatronTavern at business=rusty_anchor"), and
  on rehydrate `materialize` re-runs `requestSeat` from scratch when
  the player walks back into the tavern. Lost: the in-tavern
  per-visit FSM progress (queue position, ticket-in-flight). Acceptable
  because the live FSM's natural duration is short relative to typical
  save cadence, and a "resume exactly where the abstract sim left off"
  path needs FSM-state serialization that doesn't exist for the
  business-side state machine. Same trade for hired staff: WorkAt
  resume re-runs `clockIn` cleanly; in-flight cook ticket goes back
  to "ordered."

- **Midnight re-plan is registry-driven, archetype-keyed.** Added
  `npcRegistry.registerReplanner(archetypeId, fn)` plus a `time:midnight`
  loop that walks every persistent agent (no
  `flags.unregisterOnPlanExhaustion`) and asks the matching replanner
  for a fresh `Activity[]`. Replanner key matching is exact-first then
  longest-prefix (`staff:cook` falls through to a `staff:` registration).
  The registry's `replaceDayPlan(npcId, plan)` does the swap atomically:
  exits the current activity, drops any held driver claim, resets the
  cursor, enters the new first activity. Picked this over a re-emit-
  the-event approach because the replanner needs the registry to own
  the lifecycle ordering — e.g. so the staff replanner doesn't run
  while the agent is mid-WorkAt with a held handle.

- **Townsfolk migration is gated on authored residences, not a flag.**
  `agentBinding.registerAgentForNpcDef` checks `residences.get(def.id)`
  per townsfolk: if a residence exists at the same scene, the agent is
  registered under archetype `townsfolk_default` with a planner-driven
  day plan (Sleep → schedule → Sleep, bookended); without one, it falls
  back to the legacy single-activity wander/patrol behavior. This lets
  the migration roll out per-NPC as Tiled `npcResidence` objects are
  authored, without a project-wide cutover. Authoring residences for
  every existing townsfolk is left to the user — Tiled GUI work, per
  CLAUDE.md.

- **Townsfolk replanner re-rolls the full day plan at midnight.** The
  replanner reads the def from `entityRegistry` (via `NpcModel.def`) so
  it can re-call `planDayById` with the current calendar. Same
  bookend-with-Sleep pattern as the initial registration. This means a
  townsfolk's Saturday plan differs from their Tuesday plan as soon as
  schedules grow `dayWeights`-style metadata — currently the
  `townsfolk_default` schedule uses uniform weights, so day-to-day
  variation is mostly seed-driven.

- **`npcRegistryPatrons` flag deleted; legacy spawn loop ripped out.**
  Phase 6 had already flipped the flag to default-on (so the legacy
  `spawnCustomer` was already an early-return no-op). Phase 9 deletes
  the flag, the `maybeSpawn` 250 ms timer, and the entire legacy
  `spawnCustomer` body. `customerSim.spawnSeatedCustomer` (the
  rehydration-from-snapshot path) is left intact — it's the reload
  fallback when the player re-enters a tavern with mid-meal customers
  whose agent records were lost; not a "synthetic spawn" in the same
  sense. The dev console's `setPatronFlag` and `patronFlag` references
  are removed alongside.

- **`npcRegistryStaff` flag survived as a transitional wart.** Phase 9
  was supposed to delete this flag and the legacy `reconcileStaffSchedule`
  synthetic-spawn path. With the flag default OFF (Phase 8), every
  business currently runs the legacy synthetic spawn for its hires
  because no `npcResidence` objects have been authored yet. Flipping
  the flag ON unconditionally would leave residence-less businesses
  with no staff at all — a regression. Resolution: the flag stays as
  the runtime opt-in (still toggled via `dev.sim.setStaffFlag`), and
  the legacy path stays as fallback. Once residences are authored for
  every hire, the flag and the fallback can both be deleted in a
  follow-up — this is the only Phase 9 deliverable that didn't ship
  fully.

- **Other transitional warts that survived Phase 9 cleanup.** All for
  the same root reason: scripted-direction NPC drivers (cutscenes,
  legacy staff arrival/departure walks in `reconcileStaffSchedule`,
  the customer FSM's owned-customer rehydrate path) still write to
  `NpcModel.x/y` directly. Removing the bypasses below requires
  migrating those drivers to the activity/handle path, which is out
  of scope for Phase 9:
  - `npcRegistry.setBodyExternal(npcId, patch)` — the proxy uses this
    to mirror scripted model→body so an activity resumes from the
    right place when a script ends.
  - `NpcProxy.sync()`'s reverse-direction branch under
    `model.scripted === true`.
  - `WorldTicker.tick`'s `if (npcRegistry.get(model.id)) continue`
    gate. With every wander/patrol NPC now agent-bound, the legacy AI
    on the model is reached only by static NPCs (where `tick` returns
    early), but the gate is the explicit guarantee against double-
    drive and stays until `NpcModel.tick` is deleted entirely.

- **Calendar-aligned staff schedule.** The Phase 8 fixed-duration
  baseline (`Sleep(360) → WorkAt(480) → GoTo(home) → Sleep(600)`) is
  replaced by a derivation from the business's `openMinute` /
  `closeMinute`: pre-shift Sleep runs midnight → `openMinute`,
  abstract WorkAt covers the open window, post-shift Sleep covers
  `closeMinute` → next midnight. Both sleep durations are clamped to
  `[60, 720]` minutes so a business with a degenerate schedule
  doesn't hand the registry a 0-minute or multi-day plan. Businesses
  with no schedule fall back to a noon-centered 8-hour shift. The
  `staff:` replanner runs this every midnight so a schedule edit
  (or a calendar tick into a different day-of-week, once schedules
  consume that) takes effect on the next sleep cycle.
