# Architecture — Global NPC State Management

This document captures the structural decisions. Phase plans
(`01-…` through `09-…`) reference back to it for shared types and
contracts.

## Three layers

### 1. Sim (pure, no Phaser)

Lives outside any scene; owns every NPC; survives scene loads and saves.

```
src/game/sim/
  npcRegistry.ts        // master tick + npcsAt + spawn/despawn + events
  npcAgent.ts           // data record per NPC
  location.ts           // WorldLocation + addressing helpers
  bodyHandle.ts         // exclusive write-token to an agent's body
  calendar/
    calendar.ts         // dayOfWeek / month / season from dayCount
    calendar.json       // week names+length, month names+lengths, seasons
  planner/
    scheduler.ts        // (archetype, calendarCtx, flags) → Activity[]
    archetypes.ts       // load + index npcArchetypes.json + schedules/
  activities/
    activity.ts         // interface + base classes
    goTo.ts
    wander.ts
    patrol.ts
    sleep.ts
    idle.ts
    browse.ts
    patronTavern.ts     // delegated to patronService
    workAt.ts           // delegated to staffService
  portals.ts            // door registry: scene A door → scene B entry
  data/
    npcArchetypes.json
    spawnGroups.json
    schedules/
      tourist.json
      ...
```

### 2. Adapters (Phaser-aware bridge)

Thin. No game logic.

```
src/game/world/
  sceneNpcBinder.ts     // per-scene: subscribe to registry, manage proxies
  pathfinding.ts        // unchanged
src/game/entities/
  NpcModel.ts           // SHRINKS — visual proxy only (sprite + animator)
  npcProxy.ts           // attaches/detaches an NpcAgent to a GameObject
  npcBootstrap.ts       // registers agents with the registry on world load
src/game/scenes/
  WorldScene.ts         // binder.attach(this, sceneKey) on create
  InteriorScene.ts      // same
```

### 3. Subsystem services

The "borrowed body" handlers. Existing business code becomes services
with a small public API.

```
src/game/business/
  customerSim.ts                 // FSM kept; spawn path removed
  customerSim/
    patronService.ts             // requestSeat / releaseAfter / events
  staff/
    staffService.ts              // clockIn / clockOut
```

## Core types

### `WorldLocation`

```ts
type SceneKey = `chunk:${string}` | `interior:${string}`;

interface WorldLocation {
  sceneKey: SceneKey;
  tileX: number;
  tileY: number;
  facing: "up" | "down" | "left" | "right";
}
```

Tile resolution at the registry level. Pixel-precision lives on the body
when materialized; abstract collapses back to tile on dematerialize.

### `NpcAgent`

```ts
interface NpcAgent {
  id: string;
  archetypeId: string;            // "tourist", "townsfolk_baker", ...
  body: ReadonlyBody;             // mutated only via BodyHandle
  location: WorldLocation;
  dayPlan: Activity[];
  currentActivityIndex: number;
  currentActivity: Activity | null;
  traits: Record<string, unknown>;
  flags: Record<string, boolean>;
  inventory: ItemStack[];
}

interface ReadonlyBody {
  readonly px: number;
  readonly py: number;
  readonly facing: "up" | "down" | "left" | "right";
  readonly anim: string;
  readonly spriteKey: string;
}
```

Plain data. Serializable. No methods that touch Phaser.

### `BodyHandle`

```ts
class BodyHandle {
  // construction restricted to NpcRegistry
  setPosition(px: number, py: number): void;
  setFacing(f: Facing): void;
  setAnim(name: string): void;
  // hand off to a subsystem; this handle is invalidated, new one returned
  transfer(toClaimant: object): BodyHandle;
  release(): void;
}
```

Runtime check on every write: handle must be the agent's current active
driver. Subsystems passed a handle through `transfer` get the only valid
handle until they return it.

### `Activity` interface

```ts
interface Activity {
  readonly kind: string;                      // for serialization

  enter(npc: NpcAgent, ctx: ActivityCtx): void;

  // canonical state advance (per-minute, scene-agnostic)
  tickAbstract(npc: NpcAgent, ctx: ActivityCtx, simMinutes: number): void;

  // per-frame; reads abstract state, drives sprite, may invoke tickAbstract
  tickLive(npc: NpcAgent, ctx: ActivityCtx, dtMs: number): void;

  exit(npc: NpcAgent, ctx: ActivityCtx): void;

  isComplete(): boolean;
  canInterrupt(): boolean;                    // default true
  serialize(): unknown;

  // optional — called when a scene loads/unloads mid-activity
  materialize?(npc: NpcAgent, ctx: ActivityCtx): void;
  dematerialize?(npc: NpcAgent, ctx: ActivityCtx): void;
}

interface ActivityCtx {
  registry: NpcRegistry;
  time: TimeManager;
  calendar: CalendarContext;
  claimBody(npc: NpcAgent, claimant: object): BodyHandle;
  scene?: Phaser.Scene;          // present in live mode only
  pathfinder?: Pathfinder;       // present in live mode only
}
```

A `WalkAndThenDo` base class covers the common pattern.

### `NpcRegistry` (public surface)

```ts
class NpcRegistry {
  register(agent: NpcAgent): void;
  unregister(npcId: string): void;

  npcsAt(sceneKey: SceneKey): readonly NpcAgent[];
  setLocation(npcId: string, loc: WorldLocation): void;   // emits events

  tickAbstract(simMinutes: number): void;                 // wired to onMinute
  tickLive(sceneKey: SceneKey, dtMs: number): void;       // called by binder

  on(event: "npcEnteredScene" | "npcLeftScene",
     handler: (sceneKey: SceneKey, npc: NpcAgent) => void): () => void;

  serialize(): RegistrySnapshot;
  hydrate(snap: RegistrySnapshot): void;
}
```

## Data shapes

### `npcArchetypes.json`

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

### `schedules/tourist.json`

```json
{
  "id": "tourist",
  "constraints": {
    "mustStartAt": "spawnPoint",
    "mustEndAt": ["spawnPoint", "tavern.guestRoom"],
    "totalActivitiesRange": [3, 6]
  },
  "templates": [
    { "kind": "browse", "target": "general_store",
      "weight": 1.0, "duration": [10, 25] },
    { "kind": "browse", "target": "blacksmith",
      "weight": 0.8, "duration": [8, 20] },
    { "kind": "patronTavern", "target": "tavern_rusty_anchor",
      "weight": 1.5, "windowMinute": [600, 1320] },
    { "kind": "wander", "target": "town_square",
      "weight": 0.6, "duration": [5, 15] }
  ]
}
```

### `spawnGroups.json`

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

### Tiled object class `npcSpawnPoint`

Custom properties:
- `spawnGroupId` (string, required) — must resolve to an entry in
  `spawnGroups.json`. Validated at build time.

## Live ↔ abstract handshake

| Player position | Source scene | Dest scene | Behavior |
|---|---|---|---|
| In source | loaded | not loaded | live → dematerialize at portal → abstract |
| In dest | not loaded | loaded | abstract → portal → materialize → live |
| In neither | not loaded | not loaded | abstract throughout |
| In source then walks to dest mid-transit | loaded → not loaded | not loaded → loaded | live → dematerialize → abstract → materialize → live |

`materialize` reads the activity's serializable phase and chooses a
believable starting point (e.g. interpolated position along the abstract
travel segment). `dematerialize` collapses live state to that same phase.

## Body driver guarantees

- `npc.body` is `ReadonlyBody` publicly. No mutation without a handle.
- `claimBody(npc, claimant)` returns a handle and records the claimant.
  Calling it again before release throws.
- `handle.transfer(toClaimant)` is the only way to hand off. The original
  handle is invalidated; only the new one is valid.
- `handle.release()` clears the active driver.
- Dev builds: every write asserts the handle is the agent's active
  driver. Prod: TypeScript prevents the typical mistake; runtime check
  is removed.

## Persistence

`RegistrySnapshot` is JSON-safe:

```ts
interface RegistrySnapshot {
  schemaVersion: number;
  agents: Array<{
    id: string;
    archetypeId: string;
    location: WorldLocation;
    body: ReadonlyBody;
    dayPlan: Array<{ kind: string; data: unknown }>;
    currentActivityIndex: number;
    currentActivityState: unknown | null;
    traits: Record<string, unknown>;
    flags: Record<string, boolean>;
    inventory: ItemStack[];
  }>;
}
```

Activities supply `serialize()`; loading dispatches by `kind`. Visual
proxies are derived; not saved. Subsystem state (tavern queue, ticket
list, hired roster) serializes alongside the business, not the registry.

## Anti-patterns to avoid

- Two systems writing to `agent.body` in the same frame. The handle
  contract exists to prevent this; dev assertion catches violations.
- Activities reaching into each other or into another NPC's state. All
  cross-NPC effects go through the registry or a service.
- Live activity logic for NPCs in a scene the player isn't in. The
  binder must only call `tickLive` for the active scene.
- Subsystems holding handles past completion. Always `release` or
  `transfer` on exit.
- Schedule planner reading live state. Planning is pure: archetype +
  calendar + flags in, activity list out. No lookups into other NPCs'
  current behavior.
