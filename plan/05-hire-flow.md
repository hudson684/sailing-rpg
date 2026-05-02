# Step 5 — Hire flow + staff NPC spawn

Hireable candidate pool + Staff tab + hired staff spawning as real NPCs
inside the business interior.

## Goals

- `hireables.json` with a candidate pool.
- A "candidate slate" that refreshes every N in-game days using `time:phaseChange`.
- Staff tab in `BusinessManager` to hire / fire.
- Hired staff become `NpcModel`s in the interior, parked at workstation
  tags defined in the role.
- Wages deducted on each in-game day rollover (`time:phaseChange` to "day"
  with `dayCount` increment).

## Files

- **New** `src/game/data/hireables.json`
- **New** `src/game/business/hireables.ts` — slate generation, hire/fire,
  daily wage settlement.
- **New** `src/ui/business/tabs/Staff.tsx`
- **Edit** `src/game/business/businessStore.ts` — `addStaff`, `removeStaff`,
  `paywages(businessId, dayCount)`.
- **Edit** `src/game/entities/npcBootstrap.ts` (or whatever spawns NPCs in
  interiors) — accept a "hired-staff source" alongside `npcs.json` so
  `BusinessState.staff` entries spawn into the right interior.
- **Edit** Tiled tavern `.tmj` — add named workstation objects (e.g.
  object with `name: "ws:bar"`, `name: "ws:kitchen"`).

## Schemas

### `HireableDef`

```ts
{
  id: string,
  name: string,
  spritePack: string,         // existing NPC sprite key, picked from generic pool
  roles: RoleId[],            // candidate may fit multiple
  skill: 1 | 2 | 3 | 4 | 5,
  wagePerDay: number,         // in coin
  traits: string[],           // future: e.g. "drunk", "fastlearner"
}
```

### `RoleDef` (on `BusinessKindDef`)

```ts
{
  id: string,                 // "bartender" | "cook" | "server" | "stocker"
  workstationTag: string,     // matches `ws:<tag>` in Tiled object names
  produces: string[],         // revenue-source ids this role enables
  // future: autoStocks?: boolean — used by step 8
}
```

### `HiredNpc` (on `BusinessState.staff`)

```ts
{
  hireableId: string,         // → HireableDef.id
  roleId: string,
  hiredOnDay: number,
  unpaidDays: number,         // > 0 means quit-roll territory (step 9)
}
```

## Slate generation

```ts
slate(businessId): HireableDef[]
  // deterministic per (dayCount, businessId) using a small hash
  // size = 3..5
  // filter pool: must have at least one role this kind cares about
  // exclude already-hired ids
```

Refresh trigger: `time:phaseChange` listener in `hireables.ts` — when
`phase==="day"` and `dayCount` is divisible by `SLATE_REFRESH_DAYS` (start
with 2). The slate is a derived value; we don't store it, we just
recompute. (No save needed.)

## Spawning hired staff as NPCs

`InteriorScene` enter:
1. Build NPCs from `npcs.json` as today.
2. For each owned business with `interiorKey === currentInterior`, walk
   `state.staff` and spawn one `NpcModel` per entry:
   - Sprite: from `HireableDef.spritePack`.
   - Position: find Tiled object `ws:<role.workstationTag>` and place near it.
   - Movement: short-radius wander around the workstation (existing
     wander config takes a center + radius).
3. On `business:staffChanged` event, despawn/respawn that interior's
   staff NPCs. (Add the event in step 5.)

## Wage settlement

Hook `time:phaseChange` (phase becomes "day", dayCount has incremented):
```
for each owned business:
  totalWages = sum(staff.map(s => hireables[s.hireableId].wagePerDay))
  if coffers >= totalWages:
    coffers -= totalWages
    appendLedger({ day, wages: totalWages, ... })
    each staff.unpaidDays = 0
  else:
    pay what we can (clamp to 0) — proportional or all-or-nothing?
    each staff.unpaidDays += 1
    reputation -= UNPAID_REP_HIT
```

Open Q: proportional partial pay vs all-or-nothing. **Recommendation:
all-or-nothing** — simpler, more legible to player, sharper bankruptcy
signal. Step 9 handles the quit roll.

## Staff tab UI

- Hired list: name • role • skill (1-5 stars) • wage/day • [Fire].
- Total daily wages (footer).
- "Hire" button → opens slate panel: candidate cards with role picker
  (since a candidate may fit multiple of the kind's roles), [Hire] button.
- Slate refreshes display: "Next refresh in 2 days".

## Open questions

1. Sprite pool — pick a reasonable default NPC sprite for the candidate
   pool, or do we need new art? Per step-prior decision: reuse townsfolk.
   Confirm there's enough variety in existing sprites.
2. Does `npcBootstrap.ts` already accept dynamic sources, or do we need
   to refactor it? Read first.

## Done when

- `tsc` + `vite build` clean.
- Manual: open Staff tab → see slate of 3 candidates → hire bartender →
  enter tavern → bartender NPC visible behind the bar → save/load keeps
  them hired → next in-game day, wages deducted from coffers → empty
  coffers and roll to next day → ledger logs unpaid wages, reputation
  drops (visible in store devtools, not UI).
