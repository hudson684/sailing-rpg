# Step 2 — `businessStore` + Saveable

Generic store for owned businesses. No UI yet, no sim yet. Just the data
model + persistence + read/write actions everything else will call.

## Goals

- One Zustand store keyed by `businessId`.
- Coffers separate from player coin.
- Saveable v1.
- Pure data — no Phaser/scene imports so it can be called from anywhere.

## Files

- **New** `src/game/business/businessTypes.ts` — TS types.
- **New** `src/game/business/businessStore.ts` — Zustand store + actions.
- **New** `src/game/data/businessKinds.json` — initial `tavern` kind (skeleton).
- **New** `src/game/data/businesses.json` — one tavern property.
- **New** `src/game/business/registry.ts` — load + validate JSON via the
  existing `createRegistry.ts` pattern (zod).
- **Edit** `src/game/save/systems.ts` — add `businessSaveable()`.
- **Edit** `src/game/save/bootSave.ts` — register it (alongside `timeSaveable`).

## Schemas

### `BusinessKindDef`

```ts
{
  id: string,
  displayName: string,
  roles: RoleDef[],                  // see step 5
  revenueSources: RevenueSourceDef[],// see step 6
  customerProfiles: CustomerProfile[],// see step 6
  upgradeTree: UpgradeNodeDef[],     // see step 4
  defaultCapacity: number,
}
```

For step 2, `roles`/`revenueSources`/`customerProfiles`/`upgradeTree` can
be empty arrays — they're filled in by later steps. Just lock the shape.

### `BusinessDef`

```ts
{
  id: string,                  // e.g. "rusty_anchor"
  kindId: string,              // → BusinessKindDef.id
  displayName: string,
  interiorKey: string,         // matches existing interior key
  signObjectId: string,        // object in interiorInstances or world chunk
  purchasePrice: number,       // in coin
}
```

### `BusinessState` (runtime)

```ts
{
  id: string,
  owned: boolean,
  coffers: number,
  unlockedNodes: string[],     // upgrade-tree node ids
  staff: HiredNpc[],           // shape stubbed in step 2; filled step 5
  stock: Record<string, number>,
  reputation: number,          // 0-100, hidden; default 50
  ledger: DailyEntry[],        // capped at 30 entries; filled step 7
  lastTick: { dayCount: number, phase: "day"|"night", hourIndex: number } | null,
}
```

### Saveable v1 schema (zod)

Mirror the runtime state. Migrations: none yet.

## Actions

```ts
purchase(businessId): { ok: boolean, reason?: "alreadyOwned"|"insufficientCoin" }
deposit(businessId, amount): boolean   // pulls from gameStore coin
withdraw(businessId, amount): boolean  // pushes to gameStore coin
setCoffers(businessId, n): void        // for sim/tests
unlockNode(businessId, nodeId): void   // step 4 calls this
appendLedger(businessId, entry): void  // step 7 calls this
get(businessId): BusinessState | null
all(): BusinessState[]
ownedIds(): string[]
```

`purchase` deducts from `useGameStore.getState()` coin via existing inventory
helpers (find how `Shop.tsx` does it and reuse).

`deposit`/`withdraw` ensure separate-wallet semantics — they never let
player coin go negative; they never let coffers go negative.

## Hydration

On first load with no save, walk `businesses.json` and seed each entry:
`{ owned: false, coffers: 0, unlockedNodes: [], stock: {}, ledger: [],
reputation: 50, lastTick: null, staff: [] }`.

On save load, merge: any `BusinessDef` that didn't exist in the save (added
in a later patch) gets the seeded default; any `BusinessState` in the save
whose def was deleted is dropped with a `console.warn`.

## Open questions for this step

1. **Player wallet API** — confirm the right way to add/subtract coin. I
   suspect `useGameStore.getState().inventory` has helpers for the coin
   item; verify before writing `deposit`/`withdraw`.
2. **Registry pattern** — confirm `createRegistry.ts` is the right entry
   for new JSON, or if `businessKinds.json` should be loaded ad-hoc.

## Done when

- `tsc --noEmit` clean.
- `vite build` clean.
- Manual: in browser console, `useBusinessStore.getState().purchase("rusty_anchor")`
  succeeds, deducts coin, persists across save/load.
