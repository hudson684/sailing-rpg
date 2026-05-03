# Phase 4 — GoTo + cross-scene movement

## Goal

An NPC can walk from a chunk tile into an interior tile (or vice versa)
under registry control, with the player either present in the source
scene, the destination scene, or neither. Materialize/dematerialize
hand-off is clean.

## Why fourth

Highest architectural risk in the project. Get it working before
delegated activities (`PatronTavern`, `WorkAt`) need it — patrons must
*get to* the tavern before the tavern can serve them.

## Deliverables

- `src/game/sim/portals.ts`
  - Registry of door links: `{ fromSceneKey, fromTile } → { toSceneKey, toTile }`.
  - Populated at world load by walking existing `DoorSpawn` data.
  - API: `findPortal(from, to): PortalLink | null`,
    `portalsFrom(sceneKey): PortalLink[]`.
- `src/game/sim/activities/goTo.ts`
  - Plans a multi-leg route: same-scene segments + portal traversals.
  - Live (per leg in current scene): A* path via existing pathfinder,
    walk along it, fire portal traversal when reaching a door tile.
  - Abstract (per leg): travel-time estimate based on tile distance +
    fixed door-traversal cost; advances phase/leg index per minute.
  - `materialize`: read current leg + progress, place proxy at
    interpolated tile position along the leg.
  - `dematerialize`: collapse pixel position to nearest tile of current
    leg; preserve leg index and progress.
- `npcRegistry.ts`
  - `setLocation` change to a different `sceneKey` emits
    `npcLeftScene(oldKey)` then `npcEnteredScene(newKey)`, in that order.
- `sceneNpcBinder.ts`
  - On `npcLeftScene` for the active scene: dematerialize + destroy
    proxy.
  - On `npcEnteredScene` for the active scene: materialize + create
    proxy at the entry tile.
  - Mid-walk dematerialize: NPC walks visually through the door before
    proxy disappears (last frame of live = at door tile).
- Dev console: `sim.testGoTo(npcId, targetSceneKey, targetTile)` —
  forces a cross-scene `GoTo` for an existing NPC.

## Validation

Run all four scenarios with a debug NPC:

| Player position | Expected |
|---|---|
| In source scene the whole walk | NPC walks live, disappears through door, reappears correctly when player follows |
| In destination scene the whole walk | NPC abstractly travels, materializes at entry tile when their abstract clock arrives |
| In source then walks to dest mid-transit | live → portal → abstract briefly → materialize at correct interpolated point |
| In neither scene | NPC abstractly arrives; player visiting later finds them at destination |

Plus:
- 5 NPCs simultaneously crossing the same portal don't pile up or
  duplicate proxies.
- Save mid-cross-scene (manual snapshot via dev console), reload,
  verify activity resumes from correct leg + progress.
- `npx tsc --noEmit` and `npx vite build` clean.

## Risks / mitigations

- **Risk:** materialize chooses a wall tile or unwalkable spot.
  **Mitigation:** materialize validates against the pathfinder's
  walkability oracle; falls back to nearest walkable tile.
- **Risk:** event ordering bug — proxy created before `npcEnteredScene`
  fires. **Mitigation:** registry guarantees event order in
  `setLocation`; binder is the only consumer; covered by an explicit
  test probe.
- **Risk:** proxy lingering after scene shutdown. **Mitigation:**
  `binder.detach` is idempotent and called from scene `shutdown` AND
  `destroy`.
- **Risk:** abstract travel-time estimate diverges wildly from live
  pathfind time, so NPCs feel wrong when player switches scenes mid-trip.
  **Mitigation:** estimate uses tile distance × measured average speed;
  acceptable noise for now. Refine if visible.

## Out of scope

- Multi-portal routing across more than 2 scenes (e.g., walking from
  one interior to another via a chunk). Compose two `GoTo`s in the
  scheduler if needed; deferred.
- Avoiding other moving NPCs in-flight. Same as phase 3.
- Door animation / sound. Existing system.
