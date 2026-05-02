# Step 4 — Layer-visibility upgrade gating + first repair node

Make the tavern interior visibly change as upgrades are bought. One
"repair the bar" upgrade end-to-end so we can validate the pipeline
before authoring the full tree.

## Goals

- Tiled layer naming convention `<name>@tier:<nodeId>` parsed by
  `interiorTilemap.ts`.
- Locked layers hidden, visible when `unlockedNodes` includes the node.
- Same rule applies to Tiled object layers (so a "broken bar" object on
  the base layer and "repaired bar" object on the gated layer swap).
- An interactable on a broken object opens a repair prompt that calls
  `unlockNode` (with cost deduction).
- Upgrade DSL applier so `unlockNode` triggers declarative effects.

## Files

- **New** `src/game/business/upgradeEffects.ts` — applies effect tuples.
- **Edit** `src/game/world/interiorTilemap.ts` — parse `@tier:<id>`, gate
  visibility, re-evaluate when `unlockedNodes` changes (subscribe to
  `businessStore`).
- **Edit** `src/game/business/businessStore.ts` — `tryUnlockNode(businessId,
  nodeId)` that checks cost + prerequisites, deducts from coffers, applies
  effects, sets visibility. (Distinct from raw `unlockNode` from step 2.)
- **Edit** `src/game/data/businessKinds.json` — add `upgradeTree` for
  tavern with at least one repair node.
- **Edit** Tiled `.tmj` for the tavern interior — add a layer named
  `bar_counter@tier:repair_bar` containing the repaired bar tiles.
- **Edit** `interiorInstances.json` — add a `repair_target` interactable
  at the broken bar with `{ businessId, nodeId: "repair_bar" }`.

## Upgrade tree schema

```ts
type UpgradeNodeDef = {
  id: string,
  displayName: string,
  description: string,
  kind: "repair" | "upgrade",
  cost: number,
  requires: string[],          // other node ids
  effects: UpgradeEffect[],
};

type UpgradeEffect =
  | { op: "+capacity";       val: number }
  | { op: "+revenuePerSale"; val: number }
  | { op: "unlockRole";      val: string }    // role id
  | { op: "unlockMenu";      val: string }    // revenue source id
  | { op: "+spawnMultiplier"; val: number };
```

Effects are pure — they read `BusinessState` and produce a new derived
view. We compute "effective stats" on demand (`getEffectiveStats(state, kind)`)
rather than mutating state. Keeps replays/saves stable.

## First node

```json
{
  "id": "repair_bar",
  "displayName": "Repair the bar",
  "description": "The bartop is splintered. Fix it before serving drinks.",
  "kind": "repair",
  "cost": 250,
  "requires": [],
  "effects": [{ "op": "unlockMenu", "val": "drinks_basic" }]
}
```

Until `repair_bar` is unlocked, the `drinks_basic` revenue source is
unavailable, so even after hiring a bartender there's no revenue. Forces
the player through repairs before operations.

## Layer parsing

```
parseLayerName(name):
  m = /^(.+)@tier:([a-zA-Z0-9_]+)$/.exec(name)
  if !m: return { base: name, gateNodeId: null }
  return { base: m[1], gateNodeId: m[2] }
```

`interiorTilemap.ts` builds layers as today, then walks all tile + object
layers and sets `visible = false` on any with a `gateNodeId` not in
`unlockedNodes` for the business owning this interior.

To find the owning business: lookup by `interiorKey`. Add an index to
`businessStore`: `byInteriorKey: Record<string, businessId>`.

## Live updates

When `unlockNode` fires, the tilemap needs to re-flip visibility without
reloading. Two options:

- **(A)** `interiorTilemap.ts` subscribes to `businessStore` (zustand
  `subscribe`) and on change re-evaluates layer visibility. Cheapest.
- **(B)** Emit `business:nodeUnlocked` and have `InteriorScene` listen.

Recommendation: A. The tilemap module already owns layer references;
piping through a scene event adds nothing.

## Repair interactable

E-prompt on a `repair_target` object:
```
"Repair the bar — 250 coin? (coffers: 1,200)"
[Yes] [No]
```
On Yes: `tryUnlockNode("rusty_anchor", "repair_bar")` →
- Insufficient coffers: toast "Not enough coin in the till."
- Success: deduct, add to `unlockedNodes`, layer flips, toast "Bar repaired!".

## Done when

- `tsc` + `vite build` clean.
- Manual: enter the tavern → broken bar visible → "Press E to repair" →
  pay 250 → broken layer disappears, repaired layer appears in the same
  spot → save/load preserves repaired state → withdraw all coffers and
  try to repair another node → blocked with a clear message.
