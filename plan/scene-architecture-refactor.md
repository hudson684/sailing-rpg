# Scene Architecture Refactor

Cleaning up ownership across `WorldScene`, `InteriorScene`, `GameplayScene`,
and `SystemsScene`. The goal is that anything that should "just work" in
both the world and an interior actually does, without copy-pasted setup.

## Diagnosis (current state)

WorldScene has accreted game-scoped responsibilities that other scenes
either duplicate or silently lack. Concrete map:

| System | Lives in | Status in interior |
|---|---|---|
| Combat / hotbar / projectiles | `GameplayScene` base | shared, OK |
| Ground-item sprites + pickup | base | OK |
| `DroppedItemsState` | booted in `bootSave.ts`, registry | OK |
| Authored ground-item persistence on pickup | World writes; **Interior is no-op** (`InteriorScene.ts:953`) | broken — items respawn on re-entry |
| NPC `SpriteReconciler` + walkable register | duplicated in both scenes | works, double-maintained |
| `bootstrapNpcs` from `npcs.json` | **WorldScene only** (`:464`) | broken — interior-tagged NPCs never spawn |
| Hired-staff spawn | InteriorScene only | OK |
| Movement / Zoom controllers, keys, virtual input | duplicated | works, double-maintained |
| Dialogue (`activeDialogue`, advance/close/emit) | duplicated | works, double-maintained |
| HUD emission | duplicated; interior is a stripped variant | inconsistent prompts |
| `setActiveSaveController` + scene hooks | **WorldScene only** (`:386`) | latent: `getSceneKey` lies while interior is foreground; F5 path differs (direct vs bus) |
| Bus listeners: `inventory:action`, `chest:*`, `crafting:*`, `skin:apply`, `cutscene:play`, `jobs:xpGained`, `player:resetSpawn`, `ships:resetAll` | **WorldScene only** (`:665–679`) | broken — all dead in interior |
| CutsceneDirector | WorldScene only | broken in interior |
| Day/night lighting + torches | WorldScene only | broken — interiors uncolored |
| Time / foot / stamina / playtime / worldTicker | `SystemsScene` (always-on) | OK |
| Tilemap loading | World streams chunks; Interior loads once | **correct asymmetry — keep separate** |
| Door transitions | ad-hoc `checkAutoEnter` / `checkAutoExit` | works, no shared helper |
| `activeWorldScene` global (`WorldScene.ts:196`) | World | smell, replace |

## Design principles

A first cut at this plan reached for a fatter `GameplayScene` base and
service-locator lookups via `game.registry` and
`scene.manager.getScenes(true).find(...)`. That trades one set of bad
couplings for a slightly nicer-named set. The principles below are what
the actual refactor follows:

1. **Composition over inheritance.** `GameplayScene` stays a thin shell.
   Subsystems are plain classes (`DialogueSystem`, `HudPresenter`,
   `SaveBinder`, `MovementController`, `ZoomController`, `LightingController`)
   that each scene constructs in `create()`. When InteriorScene needs
   different HUD prompts it swaps the presenter — it does not override
   a hook on a base class.
2. **Ownership by lifecycle, not by lookup.** No `getActiveGameplayScene()`
   or `activeWorldScene` global. Cross-cutting bindings are bound to a
   scene via Phaser's `SCENE_WAKE` / `SCENE_SLEEP` / `SCENE_SHUTDOWN`
   events. The thing sending a command knows who currently receives it.
3. **Phaser plugins for cross-scene services**, not the string-keyed
   `game.registry` bag. `this.plugins.get('save')` is the framework's
   own DI and survives tests.
4. **Don't add scenes for non-rendering systems.** A class with
   `tick(delta)` called by the foreground scene beats a parallel scene
   for things like cutscenes or lighting. `SystemsScene` is justified
   because it owns always-on stores; nothing else gets that promotion
   without a concrete reason.
5. **Resist new abstractions until two real callers exist.** Define
   `MapHost` from what bus handlers actually need, not from what
   `WorldScene` happens to expose today.
6. **Dependency direction points inward.** Domain logic (combat,
   dialogue, inventory) does not import Phaser scenes. Scenes are
   thin adapters.
7. **Don't touch what's correctly asymmetric.** World chunk streaming
   vs. interior single-shot tilemap stays separate; this is not
   duplication.

## Target architecture

- **`SystemsScene`** (always-on, parallel) — keep as-is. Time, foot,
  stamina, playtime, worldTicker. Resist piling more onto it.
- **Phaser plugins** (installed once at game boot):
  - `SavePlugin` — wraps `SaveController`. `getSceneKey` resolves via
    Phaser's active-scene query at call time.
  - `BusPlugin` — owns the single set of subscriptions for game-scoped
    UI commands (`inventory:action`, `chest:*`, `crafting:*`,
    `skin:apply`, `cutscene:play`, `jobs:xpGained`, `player:resetSpawn`,
    `ships:resetAll`). Internally it tracks the current `MapHost`,
    rebound on `SCENE_WAKE` / `SCENE_SLEEP`.
- **`MapHost` interface** — defined by what `BusPlugin` and
  `CutsceneDirector` need: `dropItem`, `openChest`, `openCrafting`,
  `applySkin`, `playCutscene`, `getActorByRef`, `emitDialogue`. Both
  `WorldScene` and `InteriorScene` implement it.
- **`GameplayScene`** (thin shell base) — constructs the subsystem set
  every gameplay scene needs and exposes them as fields. No game logic
  beyond construction wiring. Subsystems:
  - `MovementController`, `ZoomController`, key + virtual-input binding
  - `DialogueSystem`
  - `HudPresenter` (constructor takes a prompt-source so subclasses can
    swap behavior without overriding hooks)
  - `SaveBinder` (registers this scene's saveables; reads the save
    plugin)
  - `NpcReconcilerHost` (constructs reconciler, registers walkable)
  - `LightingController` (`attachToScene(this)`; gives interiors tint
    + torch support)
- **`WorldScene`** — only world-unique systems: chunk streaming,
  ships / wind / sails, helm mode, beach footprints, business signs,
  palms, world chests / stations, door→interior transition.
- **`InteriorScene`** — only interior-unique: interior tilemap, repair
  targets, hired-staff spawn, exit handling.
- **NPC bootstrap** moves to game boot. `bootstrapNpcs` runs once for
  every map; each scene's reconciler already filters by `mapId`.

## Staged plan

Each step is independently mergeable and leaves the game working.
Verification after every step: `npx tsc --noEmit`, `npx vite build`,
hand off to user for in-browser smoke (no dev server from Claude).

### Step 1 — `MapHost` interface, defined by callers

Inventory, write `MapHost` based on what the bus handlers in
`WorldScene.ts:665–679` and `CutsceneDirector` actually call. Both
scenes implement it; nothing else changes yet. This is pure typing
work that unblocks step 2.

Verification: tsc passes; both scenes compile against the interface.

### Step 2 — `BusPlugin` with lifecycle-bound active host

Create a Phaser plugin that owns the current set of game-scoped bus
subscriptions. It holds an `activeHost: MapHost | null`. Each gameplay
scene calls `plugin.bind(this)` on `create` and `plugin.unbind(this)`
on `SCENE_SLEEP` / `SCENE_SHUTDOWN`; the plugin uses `SCENE_WAKE` to
re-bind. Move the listeners from `WorldScene.ts:665–679` into the
plugin.

Fixes: interior drop, interior chest open, interior crafting station,
interior skin apply, interior cutscene trigger, interior jobs:xpGained,
interior reset-spawn.

### Step 3 — `SavePlugin`

Replace `setActiveSaveController` / `setSceneHooks` /
`getActiveSaveController` indirection with a plugin. `getSceneKey`
asks Phaser for the active gameplay scene at call time. Both scenes
register their saveables on `create`; F5 / F9 always go through the
bus. Removes the latent `getSceneKey` lie.

### Step 4 — Extract subsystem classes

In order, with one subsystem per PR (each step independently
mergeable):

  4a. `DialogueSystem` — owns `activeDialogue`, advance / close /
      emit, bus subscription. Constructed in both scenes; duplicates
      deleted.
  4b. `MovementController` + `ZoomController` + key / virtual-input
      binding — constructed in both scenes; duplicates deleted.
  4c. `HudPresenter` — constructor accepts a prompt-source callable
      so the interior variant differs by injection, not override.
  4d. `NpcReconcilerHost` — wraps reconciler construction +
      walkable registration; both scenes use it.

After 4d the two scenes shed roughly the duplicated controller blocks
they currently both carry.

### Step 5 — `GameplayScene` as thin shell

With subsystems extracted, `GameplayScene` becomes a small class that
constructs the standard subsystem set in `create` and tears them
down in `shutdown`. World and Interior subclass it for *scene wiring
only*, not for shared logic.

### Step 6 — `bootstrapNpcs` to boot

Move the call out of `WorldScene.create` into `bootSave` (or a sibling
`bootEntities`). Run for every map. Interior reconciler already
filters by `mapId`, so interior-tagged NPCs appear automatically.

### Step 7 — `LightingController`

Extract `DayNightLighting` into a plain class with
`attachToScene(scene)`. Both scenes attach in `create`. Interiors
receive tint + torch support.

### Step 8 — Interior authored-pickup persistence

Introduce `InteriorGroundItemsState` (registry-scoped, keyed by
interior id). Wire `onStaticPickedUp` in InteriorScene to persist.
Decision to make at implementation time: one bucket per interior id,
or a single registry keyed by `(interiorId, itemId)`. Pick whichever
matches how `DroppedItemsState` is shaped.

### Step 9 — Delete `activeWorldScene` global (`WorldScene.ts:196`)

By this point everything that consulted it goes through `BusPlugin`,
`SavePlugin`, or the scene's own subsystems. Remove it and its
consumers.

### Stop and reassess

The following were in the first draft but are deferred:

- **`CutsceneScene` as a parallel scene.** Once `CutsceneDirector` is
  portable (it falls out of step 2 — the director receives a
  `MapHost`), promoting it to its own scene is design-on-spec.
  Revisit only if a concrete need (e.g. cross-scene cutscene actors)
  appears.
- **`SceneTransitions` helper.** Door enter / exit happens in two
  places. Extract only after steps 1–5 reveal the real shared shape.
- **`MapHost` brand on `scene.manager`.** Step 2 binds the active host
  via lifecycle events; a registry brand is unnecessary.

## What stays separate (intentional asymmetry)

- World chunk streaming vs. interior single-shot tilemap.
- World ships / wind / sails / helm / beach / palms / business signs.
- Interior repair targets, hired-staff spawn, exit auto-step.

These are not duplication. The refactor must not collapse them.

## Risk and verification notes

- The user runs the dev server. Every step's "leaves the game working"
  claim relies on `npx tsc --noEmit` + `npx vite build` plus the user
  smoke-testing world↔interior transitions, save/load, and at least
  one bus-driven action (drop from inventory, open chest) from inside
  an interior.
- Steps 2 and 3 are the load-bearing ones. If either lands wrong,
  save or UI commands break game-wide. They should ship in isolation,
  not bundled with subsystem extraction.
