# Phase 3 — SceneNpcBinder + migrate Wander

## Goal

Migrate the existing `NpcModel` wander/patrol AI into the activity
system. First real proof that the architecture handles a live behavior
without regression.

## Why third

`Wander` is the simplest live activity that exercises the full stack:
registry → activity → body handle → proxy → scene. If this round-trips
cleanly, the foundation is sound. If it doesn't, the bugs surface here
before they're tangled up with cross-scene movement.

## Deliverables

- `src/game/sim/activities/wander.ts`
  - Live: pick random tile in radius, pathfind, walk, pause, repeat.
  - Abstract: every minute, randomly nudge the agent's tile within
    radius (cheap; no real pathfinding).
  - `materialize`: snap proxy to current tile + idle anim.
  - `dematerialize`: collapse pixel-precise position to nearest tile.
- `src/game/sim/activities/patrol.ts` — same treatment for patrol.
- `src/game/world/sceneNpcBinder.ts`
  - `attach(scene, sceneKey)` — subscribe to registry events,
    materialize all current NPCs in the scene, drive `tickLive`.
  - `detach()` — dematerialize all proxies, unsubscribe.
  - Per-frame `update(dtMs)` calls `registry.tickLive(sceneKey, dtMs)`.
- `src/game/entities/npcProxy.ts` — Phaser GameObject wrapping
  sprite + animator + collider, bound to an `NpcAgent`. Reads body
  state on update; writes nothing (writes go through the activity's
  body handle).
- `src/game/entities/NpcModel.ts` — strip out wander/patrol AI.
  What remains is rendering glue used by `npcProxy`. Consider renaming
  in a later cleanup phase; keep file path stable for now.
- `src/game/entities/npcBootstrap.ts`
  - Instead of instantiating `NpcModel`, construct `NpcAgent`s and
    `register` them. Existing wander/patrol NPCs get a single-activity
    day plan: `[Wander(area)]` or `[Patrol(waypoints)]`, looped.
- `WorldScene.ts` / `InteriorScene.ts` — `binder.attach` in `create`,
  `binder.update(dt)` in `update`, `binder.detach` in `shutdown`.

## Validation

- All existing wander NPCs in the game look and behave identically to
  before the refactor (same speed, same pause cadence, same collision
  feel).
- Patrol NPCs cycle through waypoints as before.
- Walking out of and back into a scene with NPCs in it: NPCs are at
  plausible positions on return (not teleported, not frozen).
- Dev probe: spawn 10 wander NPCs in a chunk, switch scenes for 5
  in-game minutes, return — they've moved a believable amount.
- `npx tsc --noEmit` and `npx vite build` clean.

## Risks / mitigations

- **Risk:** every existing NPC routes through new code; one bug →
  visible regression. **Mitigation:** keep diff focused on AI
  extraction; rendering and collision sampling unchanged. Test with a
  small authored test scene before declaring done.
- **Risk:** `materialize` after long abstract gap leaves NPCs
  clustered or out-of-bounds. **Mitigation:** abstract tick clamps
  position to walkable tiles in the original radius; materialize
  re-validates.
- **Risk:** double-update if both old `NpcModel.tick` and new
  `tickLive` run. **Mitigation:** old tick path deleted in this phase,
  not flagged off.

## Out of scope

- Cross-scene movement. Phase 4.
- Inter-NPC collision avoidance (NPCs walking through each other in
  live mode is acceptable for now).
- Save/load. Phase 9.
