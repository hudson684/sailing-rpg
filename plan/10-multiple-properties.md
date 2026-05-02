# Step 10 — Multiple-property polish

The store and sims already key by `businessId`, so this step is mostly
content + UI polish. Adds a second tavern property and shakes out the
multi-business code paths.

## Goals

- Add a second buyable tavern (different town, different sign).
- `BusinessManager` portfolio picker actually exercised.
- Idle sim runs on every owned business in parallel.
- Ledger / books segregated per business.

## Files

- **Edit** `src/game/data/businesses.json` — add `harborside_tap` (or
  similar) referencing a different `interiorKey`.
- **Edit** Tiled — second tavern interior + sign in a different overworld
  chunk.
- **Edit** `src/ui/business/BusinessManager.tsx` — portfolio picker
  always rendered when `ownedIds().length > 1`.
- **Edit** `src/ui/business/tabs/Overview.tsx` — confirm all selectors
  take `businessId` and don't accidentally global-aggregate.

## Things to validate (this is the test, more than the code)

- [ ] Can own two businesses simultaneously without crosstalk.
- [ ] Live sim only runs for the interior the player is in; idle sim
      handles the other.
- [ ] Wages settle on the same day rollover for both, drawn from each's
      own coffers.
- [ ] Save/load round-trips both states.
- [ ] Hiring a candidate at business A removes them from business B's
      slate the same day (slate is per-business but candidates are
      single-hire — confirm step 5's `slate()` filter excludes globally-
      hired).
- [ ] Switching properties in the picker doesn't tear React state
      (e.g. open input fields in the Stock tab don't keep stale value).

## New decisions

- **Cross-business candidate exclusivity.** A hired NPC works for one
  business at a time. Slate filter must check **all** owned businesses'
  staff, not just the current one.
- **Picker affordance.** A dropdown is fine. If we have ≥4 properties
  later, switch to a tab strip or scrollable list.

## Open questions

1. Should there be a "global" tab summarizing all properties (combined
   coffers, total wages/day, total daily net)? Nice-to-have, not blocking.
2. Different `BusinessKindDef` per property? Step 10 still keeps both as
   `tavern` — step 11 introduces a second kind.

## Done when

- `tsc` + `vite build` clean.
- Manual: buy both properties → manage both → switch picker → numbers
  update correctly → idle 5 minutes → both ledgers grow independently.
