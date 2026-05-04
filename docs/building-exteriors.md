# Building exteriors

State-driven visuals for buildings on the world map (e.g. a tavern that
looks rundown before purchase, repaired after the first investment, and
upgraded once you've sunk further coin into it).

The system has two layers:

- **State layers (B)** — full tile-layer variants painted into a chunk
  TMJ. One layer per state. The runtime shows exactly one variant at a
  time based on the building's `unlockedNodes`.
- **Overlay objects (D)** — individual sprites placed in Tiled,
  positioned where they belong, that toggle on/off based on a
  data-defined predicate. Used for cosmetic flourishes (a new sign, a
  flower box, an animated lantern) on top of a baseline structure.

Tiled owns *placement*. Data owns *visibility* and any gameplay
*effects*. A designer can move a sign 4px in Tiled without touching
code; a programmer can change when the sign appears (or have it grant a
reputation bump) without re-saving the map.

## State layers (option B)

### Authoring

In a chunk TMX, paint each state on its own tile layer named:

```
building@id:<buildingId>:state:<stateId>
```

`buildingId` must match a `BusinessDef.id` from
`src/game/data/businesses.json`. `stateId` must match an upgrade-tree
node id on the corresponding `BusinessKindDef` — the layer is shown
only when that node is in the building's `unlockedNodes`.

Example for the tavern:

```
building@id:rusty_anchor:state:rundown
building@id:rusty_anchor:state:repaired
building@id:rusty_anchor:state:upgraded
```

### Resolution

For one building, the **latest** variant in author order whose
`stateId` is unlocked wins; everything else for that building is
hidden. If no variants are unlocked, the engine falls back to a
default layer named `building@id:<buildingId>` (no `:state:` suffix),
or hides everything for that building if no default exists.

The first variant in the layer list is therefore a natural "starting
state" if you author it as the layer with the lowest-priority node id
(or wire it as the default). Add states later in the list to make them
override earlier ones once unlocked.

### Caveats

- State layers don't currently participate in the overhead-fade system
  (props_high / roof). If a building's roof needs to render above the
  player and fade when they walk under it, paint the roof on the
  existing `roof` layer rather than as a state layer, OR extend the
  overhead set in `chunkManager.ts`.
- Collision is gated alongside rendering — `ShapeCollider` reads
  `gateActive` on each layer and skips inactive ones.

## Overlay objects (option D)

### Authoring

In a chunk TMX, place tile-objects (objects with a `gid`) on the
**`overlays`** object layer. Each object carries:

| Property   | Type   | Required | Notes                                            |
| ---------- | ------ | -------- | ------------------------------------------------ |
| `building` | string | yes      | A `BusinessDef.id`.                              |
| `slot`     | string | yes      | A slot id; unique per building in the registry.  |

Set the object's `type` to `overlay`. Object name is human-readable
only (for editor sanity); the `(building, slot)` pair is the machine
contract.

### Registry

Behavior lives in code, keyed by `(building, slot)`:

```ts
import { registerBuildingOverlay } from "src/game/world/buildingExterior";

registerBuildingOverlay({
  building: "rusty_anchor",
  slot: "new_sign",
  visibleWhen: { owned: true, requiresNodes: ["polished"] },
});
```

`visibleWhen` is an `BuildingOverlayVisibility` predicate over
`BusinessState`:

- `owned: true`  — only when the building is owned.
- `owned: false` — only when not yet owned.
- `requiresNodes: [...]` — every listed node must be in `unlockedNodes`.
- `forbidsNodes: [...]` — none of the listed nodes may be unlocked.

Optional `effects` (reserved): `reputationBonus`, `interactionPrompt`.
Hooks for future systems — wire them from whichever subsystem consumes
them (reputation, interaction prompt UI, NPC dispatcher).

### Resolution & validation

At chunk load, every overlay object is looked up in the registry by
`(building, slot)`:

- Unknown building → warn `"unknown building"`.
- Unknown slot for known building → warn `"unknown slot for building"`.
- Match → subscribe to `useBusinessStore`; create the sprite when the
  predicate passes; hide when it doesn't. Sprites are created lazily
  the first time they become visible.

Sprites use the object's `gid` to pick a frame from the chunk's bound
tilesets — the same texture path tile rendering uses, so any tile in
any tileset bound to the chunk is a valid overlay frame.

## Code layout

- `src/game/world/buildingExterior.ts` — gate parser, state-layer
  resolver, overlay registry + runtime.
- `src/game/world/chunkManager.ts` — calls `applyBuildingStateLayers`
  and `applyBuildingOverlays` from `instantiateChunk`.
- Subscriptions to `useBusinessStore` live for the chunk's lifetime
  (chunks currently never unload). If chunk teardown is added later,
  capture the returned unsubscribe fns and call them.

## Authoring quickstart

1. In Tiled, open the chunk TMX containing the building.
2. Add a tile layer named `building@id:<bid>:state:<stateId>`. Paint
   the building's tiles for that state.
3. Repeat for each state.
4. Add tile-objects to the `overlays` object layer for any cosmetic
   flourishes; set `type: overlay`, `building`, `slot` properties.
5. `npm run maps` to rebuild the TMJs.
6. Register any overlay defs in code with `registerBuildingOverlay`.
7. Drive state by unlocking nodes on the business via
   `useBusinessStore.getState().unlockNode(bid, stateId)` — the
   visuals update automatically.

## Future extensions

- **Per-state overhead/depth**: a custom property on the layer (or a
  layer-name suffix like `@overhead`) to opt a state layer into the
  fadable-overhead set.
- **Generic / wildcard overlays**: a `building: "*"` def that auto-
  applies to every business (e.g. a "for sale" sign whenever
  `owned: false`).
- **Overlay animation**: support per-overlay tweens or sprite
  animations (e.g. fade-in on first appearance).
