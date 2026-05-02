# Step 8 — Stock + stocker role

Revenue sources can require ingredients. Stock can be filled manually
(player drops items in a chest) or automatically by a hired `stocker`.

## Goals

- `revenueSources` honor `requiresStock` — both live and idle sims gate
  on it.
- `stocker` role autobuys stock at a markup, paid from coffers, on each
  `time:hourTick`.
- Storeroom chest object in the interior — drop-only chest that pushes
  items into `BusinessState.stock`.
- Stock tab in `BusinessManager` showing current quantities + policy.

## Files

- **New** `src/ui/business/tabs/Stock.tsx`
- **Edit** `src/game/business/businessStore.ts` — `addStock`, `consumeStock`,
  `setStockPolicy`.
- **Edit** `src/game/business/customerSim.ts` — call `consumeStock` on PAY.
- **Edit** `src/game/business/idleSim.ts` — gate expected revenue on stock.
- **Edit** `InteriorScene.ts` (or wherever chests register) — add a
  "storeroom" chest type that, on item drop, calls `addStock` rather
  than holding the items as world loot.
- **Edit** `src/game/data/businessKinds.json` — add `stocker` role and
  flesh out `requiresStock` on `drinks_basic` etc.
- **Edit** Tiled tavern map — add a chest with `name: "storeroom"`.

## Schemas

### `RevenueSourceDef.requiresStock` (already stubbed)

```ts
requiresStock?: { itemId: string, qtyPerSale: number }
```

### Stock policy

```ts
stockPolicy: {
  mode: "manual" | "auto",
  autoBuyMarkup: number,       // 1.5 = pay 150% of base price
}
```

Default: `manual` until stocker hired, then `auto`.

## Auto-stocker behavior

On `time:hourTick`, for each owned business with a stocker on staff and
`stockPolicy.mode === "auto"`:

```
for each unlocked revenueSource with requiresStock:
  target = capacity × 4   // ~4 sales per slot per hour buffer
  current = state.stock[itemId] ?? 0
  if current < target:
    needed = target - current
    cost = needed × itemBuyPrice(itemId) × stockPolicy.autoBuyMarkup
    if coffers >= cost:
      coffers -= cost; state.stock[itemId] += needed
      ledger.expenses += cost
    else:
      partial = floor(coffers / unitCost); top up what we can
      ledger.expenses += partialCost
```

If no stocker on staff, skip auto. Manual chest still works regardless.

## Manual stocking

The "storeroom" chest is a chest that **only accepts deposits** from the
player. Drop an item → `addStock(businessId, itemId, qty)`. UI confirmation:
existing chest UI is fine; just configure it as deposit-only and target
the business's stock map instead of a normal chest inventory.

## Stock tab UI

- Current stock: itemId • icon • qty • "needed for capacity" hint.
- Stock policy: [Manual] / [Auto] toggle (Auto disabled if no stocker hired).
- Auto markup display (read-only for now).
- Recent restock log (last 5 entries from ledger expenses).

## Stockouts in sims

- **Live:** customer goes to ORDER, picks a buys[] source, finds it
  out of stock, falls through to next available. If none, WALKOUT.
- **Idle:** when computing expected hourly revenue, scale each source's
  contribution by `min(1, currentStock / (qtyPerSale × salesPerHour))`.

### Carry-over from step 7

Step 7 shipped `idleSim.getHourlyExpectedRevenue` without a stock
gate — every unlocked revenue source with staff is treated as fully
stocked. Wire stock in here:

- In `getHourlyExpectedRevenue`, for each eligible source compute its
  per-source customer share (uniform across `eligible.length`), then
  scale that share's revenue by `min(1, currentStock / (qtyPerSale ×
  shareOfCustomers))`. Sources without `requiresStock` keep their
  full share.
- Have the live sim's PAY → `consumeStock` and the idle sim's hourly
  application both decrement the same `BusinessState.stock` map so
  the two paths stay symmetric.

## Open questions

1. Where does `itemBuyPrice` come from? Reuse existing Shop pricing?
2. Auto-restock cadence — every hour might be too granular; could be
   every phase change. Hour is fine for v1; tune later.

## Done when

- `tsc` + `vite build` clean.
- Manual: drop ale ingredients into storeroom chest → stock tab shows
  them → live customers consume on each sale → run out → customers
  walk out, ledger logs walkouts → hire stocker, set policy auto →
  stock refills next hour, coffers tick down for ingredients.
