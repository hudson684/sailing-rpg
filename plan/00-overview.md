# Business System — Plan Index

Generic business-ownership system. "Tavern" is one `BusinessKind`; the engine
is kind-agnostic so blacksmiths/fisheries/stores plug in via data.

## Locked decisions (from design conversation)

- **Multiple properties** supported from day one. `businessStore` is keyed.
- **Time system** required prerequisite. 1h day / 20m night, **12 in-game
  hours per cycle** (6 day + 6 night), implemented in `src/game/time/`.
- **Reputation hidden** from UI; affects spawn rates only.
- **Upgrades use layer visibility** in Tiled (`@tier:<nodeId>` suffix on
  layer/object names; `interiorTilemap.ts` hides locked layers).
- **Coffers separate from player coin.** Withdraw/deposit moves funds.
- **Upkeep = wages only.** No flat building upkeep. Implies upgrade nodes
  must carry meaningful upfront cost and gate revenue, not cosmetics, or
  there's no reason not to instantly max every property.
- **Customer art:** reuse generic townsfolk pool with random variation;
  per-kind flavor is a later polish pass.
- **Bankruptcy:** coffers clamp at 0; unpaid wages → reputation hit + per-
  staff daily quit roll. Recoverable.

## Build order

| Step | Status | File |
|------|--------|------|
| 1. Time system + HUD clock | ✅ done | (shipped) |
| 2. `businessStore` + Saveable | pending | `02-business-store.md` |
| 3. Purchase flow + Overview UI | pending | `03-purchase-and-manage-ui.md` |
| 4. Layer-visibility upgrade gating + first repair node | pending | `04-upgrade-layer-gating.md` |
| 5. Hire flow + staff NPC spawn | pending | `05-hire-flow.md` |
| 6. Live customer sim | pending | `06-live-customer-sim.md` |
| 7. Idle closed-form sim | pending | `07-idle-sim.md` |
| 8. Stock + auto-stocker | pending | `08-stock-and-stocker.md` |
| 9. Reputation + bankruptcy effects | pending | `09-reputation.md` |
| 10. Multiple-property polish | pending | `10-multiple-properties.md` |
| 11. Second `BusinessKind` (blacksmith) | pending | `11-second-business-kind.md` |

Step 11 is the design-validation gate: if adding blacksmith requires touching
engine code beyond `businessKinds.json` + a new interior, the abstractions
are wrong and we should refactor before going further.

## Core abstractions

```
BusinessKind   (data: "tavern" | "blacksmith" | ...)
  ├─ roles[]            staff roles + what they unlock
  ├─ revenueSources[]   what customers buy / what's produced
  ├─ customerProfiles[] who shows up + when
  └─ upgradeTree        kind-specific repair + upgrade nodes

BusinessDef    (data: one specific property)
  ├─ kind: BusinessKindId
  ├─ interiorKey, signObjectId, purchasePrice
  └─ overrides (capacity, starting tier, custom upgrades)

BusinessState  (runtime, in store)
  ├─ owned, unlockedNodes: Set<nodeId>, coffers
  ├─ staff: HiredNpc[], stock: Record<itemId, qty>
  ├─ reputation (0-100, hidden), ledger: DailyEntry[]
  └─ lastTickAt: { dayCount, phase, hourIndex }
```

## File layout (target end state)

```
src/game/
  time/                  ✅ shipped
    constants.ts
    timeStore.ts
  business/
    businessTypes.ts
    businessStore.ts     # Zustand + Saveable
    upgradeEffects.ts    # declarative effect DSL applier
    customerSim.ts       # live + idle
    hireables.ts         # candidate-slate logic
  data/
    businessKinds.json
    businesses.json
    hireables.json
src/ui/
  Clock.tsx, Clock.css   ✅ shipped
  business/
    BusinessManager.tsx
    BusinessManager.css
    tabs/Overview.tsx
    tabs/Staff.tsx
    tabs/Upgrades.tsx
    tabs/Stock.tsx
    tabs/Books.tsx
```
