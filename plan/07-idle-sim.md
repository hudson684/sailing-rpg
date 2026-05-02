# Step 7 — Idle closed-form sim

When the player isn't inside a business interior, money still moves. On
each `time:hourTick`, every owned business runs a closed-form sales
calculation matched to the live-mode math.

## Goals

- `idleSim.tick(businessId, hourCtx)` produces the same expected revenue
  as live mode would have, on average.
- Hooks `time:hourTick` (fires 6× per phase, 12× per cycle).
- Wage settlement still happens on `time:phaseChange` (day rollover) —
  shared with step 5.
- Daily ledger commits on day rollover with combined live+idle data.

## Files

- **New** `src/game/business/idleSim.ts`
- **Edit** `src/game/business/businessStore.ts` — `applyIdleHour(businessId,
  ctx)` action.
- **Edit** boot wiring (probably `bootSave.ts` or a new `businessBootstrap.ts`)
  — subscribe `time:hourTick` once at game start; iterate owned businesses.

## Math (must mirror live mode)

```
expectedSalesPerHour(businessId) =
  Σ over customerProfiles weighted by spawnWeight × phaseMultiplier
    × spawnRatePerSecond × 3600
    × P(buys revenue source unlocked & staff present & stock available)
    × avgPricePerSale

expectedRevenueThisHour = expectedSalesPerHour ÷ HOURS_PER_PHASE-as-real-hours
                        ≈ expectedSalesPerHour × (hourDurationMs / 3_600_000)
```

Keep one shared helper `getHourlyExpectedRevenue(businessId, phase)` used
by both `idleSim` and (for the Overview chart) live projections.

## Live-vs-idle exclusivity

Don't double-count. Two approaches:

- **(A)** Skip idle tick if the player is currently inside the business
  interior (live mode already spawning).
- **(B)** Always run idle tick; live mode subtracts its own counter.

Recommendation: **(A)**. Simpler, matches player mental model ("I sat
in there for an hour and made what idle would've"). Implementation: at
hour-tick time, check `currentInteriorKey === business.interiorKey` and
skip if so.

## Stockouts in idle

If `requiresStock` items are below threshold, scale that source's
contribution to expected revenue down (or to 0). Same logic as live mode
WALKOUT — keep both reading from a single helper.

## Wages settlement vs hour ticks

Wages are **per day**, not per hour. Triggered on `time:phaseChange` from
"night" → "day" (dayCount++). This is the same hook step 5 uses; share
the listener.

## Catch-up after long absence

If the game was closed, on load `lastTick` will be far behind current
time. Two options:

- **(A)** Replay all missed hours one by one. Accurate but expensive on
  long absences.
- **(B)** Compute a single closed-form summary: `(elapsedHours × avg
  hourly rate) − (elapsedDays × wages)`. Approximate but O(1).

Recommendation: **(B)** with a cap of ~7 in-game days of catch-up to
avoid exploits. Store catch-up summary as one `ledger` entry per day so
the books still look continuous.

## Open questions

1. Cap on catch-up — what's fair? 7 days is a guess.
2. Should the player see a "while you were away…" toast on load if idle
   gains were nontrivial? (Probably yes, polish later.)

## Done when

- `tsc` + `vite build` clean.
- Manual: sit in tavern for an in-game hour, note revenue. Leave, sit
  outside, wait an hour — coffers should rise by approximately the same
  amount. Match within ±15% (variance from RNG is fine).
- Save, close tab, wait, reopen — catch-up entry appears in the ledger,
  bounded by the cap.
