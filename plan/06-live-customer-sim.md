# Step 6 — Live customer sim

When the player is inside an owned business interior, customers walk in
on a timer, get served, pay, and leave. Sales credit the coffers in real
time.

## Goals

- One customer profile in `tavern` (`drinker`) end-to-end.
- Phaser timer-driven spawning, scaled by reputation/capacity/phase.
- Customer NPC state machine with existing pathing primitives.
- `recordSale` action on `businessStore`.
- Ledger entry per in-game day (rolling).

## Files

- **New** `src/game/business/customerSim.ts` — spawn loop + state machine.
- **Edit** `src/game/business/businessStore.ts` — `recordSale(businessId,
  sourceId, amount)`, `getEffectiveStats(businessId)`.
- **Edit** `src/game/scenes/InteriorScene.ts` — start `customerSim` on
  enter for owned business interiors, stop on exit.
- **Edit** `src/game/data/businessKinds.json` — add `tavern.revenueSources`
  and `tavern.customerProfiles`.

## Schemas

### `RevenueSourceDef`

```ts
{
  id: string,                  // "drinks_basic", "stew_basic", ...
  displayName: string,
  requiresRole: string,        // role id that must be on staff
  requiresStock?: { itemId: string, qtyPerSale: number }, // step 8
  pricePerSale: number,
  serviceTimeMs: number,       // how long staff takes to fulfill
}
```

### `CustomerProfileDef`

```ts
{
  id: string,                  // "drinker"
  displayName: string,
  spawnWeight: number,         // relative weight in the spawn pick
  phaseMultiplier: { day: number, night: number },
  buys: string[],              // revenue-source ids; pick one weighted on entry
  satisfactionFactors?: string[], // step 9
}
```

### Effective stats (derived)

```ts
getEffectiveStats(businessId) → {
  capacity: number,
  spawnRatePerSecond: number,    // scaled by rep × capacity × phaseMult
  unlockedRevenueSourceIds: string[],
  staffByRole: Record<string, HiredNpc[]>,
}
```

`spawnRatePerSecond` formula (initial):
```
base = capacity / 60                              // ~one customer per minute per slot
repMult = 0.5 + reputation/100                    // 0.5..1.5 from 0..100
phaseMult = profile.phaseMultiplier[currentPhase]
rate = base × repMult × phaseMult
```

Tunable later; keep all magic numbers in one constants block.

## State machine (per customer NPC)

```
ENTER  → walk to a free seat object (Tiled `seat:<n>`) or queue point
ORDER  → pick a revenue source from `buys` ∩ unlockedRevenueSourceIds,
         filtered by role-staff-present and stock-available (step 8)
         if none available: WALKOUT with rep hit
WAIT   → consume nearest idle staff of source.requiresRole for serviceTimeMs
PAY    → coffers += source.pricePerSale; recordSale()
LEAVE  → walk to door, despawn
WALKOUT → walk to door immediately, recordWalkout() (step 9)
```

Reuse existing `NpcModel` movement; customers are just NPCs with a
custom controller. May need a small "claim seat" reservation table to
prevent two customers heading to the same seat — store `Set<seatId>` on
the sim instance.

## Spawning loop

In `customerSim.start(businessId, scene)`:
```
let acc = 0
const ev = scene.time.addEvent({
  delay: 250, loop: true,
  callback: () => {
    if (sceneIsPaused) return
    const stats = getEffectiveStats(businessId)
    acc += stats.spawnRatePerSecond * 0.25
    while (acc >= 1) {
      acc -= 1
      if (currentCustomerCount() >= stats.capacity) break
      spawnCustomer(pickProfileWeighted(stats))
    }
  }
})
return () => ev.destroy()
```

## Sale recording

```ts
recordSale(businessId, sourceId, amount):
  state.coffers += amount
  todaysLedger.revenue += amount
  todaysLedger.salesByCe[sourceId] = (...||0) + 1
  reputation += SMALL_BUMP                      // step 9
```

Today's ledger entry is a draft on `BusinessState` (not yet in `ledger[]`);
on `time:phaseChange` to "day" with new `dayCount`, draft is committed
to `ledger[]` (capped at 30) and a fresh draft started.

## Customer sprites

Per locked decision: pick from existing generic NPC sprite pool with
random variation. Add `pickRandomTownsfolkSprite(seed)` helper somewhere
sensible.

## Open questions

1. **Seat objects** — confirm Tiled supports named seat objects we can
   query. Otherwise use a hand-coded seat list per interior.
2. **Service time animation** — can staff NPCs play a "working" anim
   while busy, or just stand at workstation? OK to skip animation in v1.

## Done when

- `tsc` + `vite build` clean.
- Manual: enter the tavern with a hired bartender and `repair_bar`
  unlocked → customers spawn over ~1 min → walk to seats → wait → pay
  → coffers tick up → leave → save mid-cycle preserves coffers but
  despawns customers (acceptable; sim restarts on re-enter) → exit
  interior, return: coffers held, no live spawning.
