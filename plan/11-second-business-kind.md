# Step 11 — Second `BusinessKind` (blacksmith)

Design-validation gate. If adding a blacksmith requires changes to engine
code (`businessStore.ts`, `customerSim.ts`, `idleSim.ts`,
`upgradeEffects.ts`, `interiorTilemap.ts`), the abstractions are wrong
and we should refactor before going further.

The expected change set is **only**:

- New entry in `businessKinds.json`.
- New entry in `businesses.json` (the buyable smithy).
- Tiled interior + interiorInstances rows.
- (Optional) new sprite/icon assets.

Anything else is a smell.

## Goals

- A buyable blacksmith property in the overworld.
- New roles: `smith` (works the forge), `apprentice` (assists, increases
  throughput).
- New revenue source pattern: **production** instead of retail. Customers
  arrive wanting an output item (e.g. iron nails), staff converts inputs
  (iron ingots, charcoal) into outputs, customer pays for output.
- New customer profile: `villager_buyer` with different phase weights
  (active during day, dead at night).

## Files

- **Edit** `src/game/data/businessKinds.json` — `blacksmith` entry.
- **Edit** `src/game/data/businesses.json` — one smithy property.
- **Edit** `src/game/data/hireables.json` — candidates with `smith` /
  `apprentice` role tags.
- **Edit** Tiled — smithy interior + sign.

## Production-vs-retail unification

Today's `RevenueSourceDef` has `requiresStock` (one item in). Production
needs multi-input → output. Extend the schema:

```ts
type RevenueSourceDef = {
  id: string,
  displayName: string,
  requiresRole: string,
  pricePerSale: number,
  serviceTimeMs: number,

  // Retail mode (existing):
  requiresStock?: { itemId: string, qtyPerSale: number },

  // Production mode (new):
  produces?: {
    inputs: { itemId: string, qty: number }[],
    outputItemId?: string,        // for inventory-shape symmetry; optional
  },
}
```

Sims call a single helper:
```
canFulfill(state, source) → boolean
consumeForSale(state, source) → void
```
…that handles either branch. **This is the only engine change** allowed
in step 11. If anything else needs to change, stop and audit.

## Customer profile differences

`villager_buyer.phaseMultiplier = { day: 1.5, night: 0.0 }` — smithies
are dead at night. Live sim already honors phase multipliers; idle
sim already does too. No code change.

## Upgrade tree

Different nodes from tavern:
- `repair_forge` — repair (gates `nails_basic`, `horseshoes_basic`).
- `upgrade_anvil` — `+spawnMultiplier`.
- `unlock_bellows` — `unlockMenu: "weapons_basic"`.

All expressible in existing effect DSL. Good — that's the validation.

## Acceptance criteria

After completing step 11, run a brief audit:

- [ ] No diffs in `businessStore.ts`, `customerSim.ts`, `idleSim.ts`,
      `upgradeEffects.ts`, `interiorTilemap.ts` other than the
      `canFulfill`/`consumeForSale` unification, which is one PR.
- [ ] Blacksmith works end-to-end: buy → repair forge → hire smith →
      villagers walk in during the day → smith consumes ingots/charcoal
      → coffers tick up → night arrives, traffic dies, idle sim respects
      it.
- [ ] Both businesses can be owned simultaneously without crosstalk.

If the audit fails, write down what was missing from the abstractions
and fix it before adding a third kind. This is the moment to spend
unrelated polish time on architecture instead.

## Open questions

1. **Inventory tie-in.** Should produced outputs ever land in the player's
   inventory (e.g. "I want to make 10 horseshoes for my own quest")?
   v1 says no — the smithy only sells to NPCs. Add a player-craft path
   later if needed.
2. **Visible queue at the counter.** Smithies feel different if customers
   queue at the counter rather than sit. Possibly worth a visual tweak
   (use existing seat-claim logic but with "queue point" objects), but
   not blocking.
