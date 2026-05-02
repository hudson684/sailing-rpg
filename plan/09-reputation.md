# Step 9 — Reputation + bankruptcy effects

Reputation is hidden but real: it scales spawn rate, drives staff quit
rolls, and reacts to operational failures. Bankruptcy = unpaid wages,
not negative coffers (coffers clamp at 0).

## Goals

- Reputation moves on hour ticks based on the hour's events.
- Staff with `unpaidDays > 0` roll daily for quitting.
- Walkouts and stockouts inflict reputation hits.
- A handful of UI tells leak reputation indirectly (Overview shows
  "patron interest" as a vague indicator, not the number).

## Files

- **Edit** `src/game/business/businessStore.ts` — `adjustReputation`,
  `rollStaffQuits`, hooks for events.
- **Edit** `src/game/business/customerSim.ts` — emit `walkout` events.
- **Edit** `src/game/business/idleSim.ts` — apply rep deltas in idle mode
  using expected counts.
- **Edit** `src/ui/business/tabs/Overview.tsx` — render "patron interest"
  pip indicator (5 pips, derived from reputation buckets).

## Mechanics

### Reputation deltas (initial tuning)

| Event                              | Δ rep |
|------------------------------------|-------|
| Successful sale                    | +0.05 |
| Customer walkout (no staff/stock)  | -0.5  |
| Stockout during peak hour          | -0.3  |
| Wages unpaid (per staff per day)   | -2.0  |
| Repair completed                   | +1.0  |
| Hour with all roles staffed + stocked | +0.1 |

Clamp 0..100. Defaults to 50 on purchase.

### Staff quit roll

Each in-game day rollover, for each `staff` with `unpaidDays > 0`:
```
quitChance = min(0.8, 0.15 × unpaidDays)
if random() < quitChance:
  removeStaff(); ledger.note("Bartender Pinta quit (unpaid)")
  reputation -= 1.0
```

Staff who quit are removed from `state.staff`. Their NPC is despawned
from the interior on next `business:staffChanged` emit.

### Spawn-rate coupling (already stubbed in step 6)

```
repMult = 0.5 + reputation/100   // 0.5..1.5
```

So a 0-rep tavern still gets some patrons (drunks aren't picky), but a
100-rep tavern gets 3x the traffic of the floor.

### "Patron interest" pip in Overview

Map reputation to 5 buckets:
```
< 20  → 1 pip "Few visitors"
< 40  → 2 pips "Quiet"
< 60  → 3 pips "Steady"
< 80  → 4 pips "Popular"
≥ 80  → 5 pips "Famous"
```

The bucket label is the only player-visible signal. The 0-100 number
stays internal — keep it out of devtools-friendly places too if we
want to enforce "hidden". (In practice, fine to expose in the store
since it's saved.)

## Open questions

1. **Per-staff vs aggregate unpaid tracking** — step 5 has `unpaidDays`
   per staff. Confirm we're settling that consistently here.
2. **Idle-mode walkouts** — idle math approximates walkouts via
   `expected_walkouts = expected_demand × P(unmet)`. Compute a single
   delta per hour rather than per-event.
3. **Recovery curve** — should rep slowly trend toward 50 when nothing's
   happening, or stay flat? Recommend a tiny daily nudge toward 50 (±0.1)
   so abandoned businesses don't stay at 0 forever.

## Done when

- `tsc` + `vite build` clean.
- Manual: deliberately starve coffers → wages unpaid → next day, at
  least one staff quits → Overview pip drops a level. Restock + repair →
  pip recovers over a few in-game days.
