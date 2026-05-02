# Step 3 — Purchase flow + Manage UI (Overview tab only)

First user-visible slice. Player walks up to a "for sale" sign, buys the
property, then can open a management panel. Only the Overview tab is wired
in this step — other tabs are stubs.

## Goals

- `for_sale_sign` interactable type that flips to "Manage" once owned.
- `BusinessManager.tsx` panel with a tab strip; only Overview rendered.
- Withdraw / deposit / portfolio picker.

## Files

- **New** `src/ui/business/BusinessManager.tsx` + `.css`
- **New** `src/ui/business/tabs/Overview.tsx`
- **Edit** `src/game/bus.ts` — add `business:open` / `business:close` events
  with `{ businessId }`.
- **Edit** `src/game/scenes/WorldScene.ts` (and `InteriorScene.ts` if signs
  go inside) — handle the `for_sale_sign` interactable in the existing
  E-prompt path. Use existing dialogue confirmation ("Buy The Rusty Anchor
  for 2,500 coin?") via `bus.emitTyped("dialogue:update", ...)` or the
  cutscene director, whichever the codebase already prefers for confirmations.
- **Edit** `src/game/data/interiorInstances.json` (or world chunk JSON,
  wherever signs go) — place a sign for `rusty_anchor`.
- **Edit** `src/game/data/dialogue.json` — purchase confirmation tree.
- **Edit** the React root that mounts `Hud`/`Shop`/etc. to mount
  `BusinessManager`.

## Interactable wiring

The sign object carries `{ kind: "business_sign", businessId: string }`.

```
playerInteract(sign):
  state = useBusinessStore.getState().get(sign.businessId)
  if !state.owned:
    setHud({ prompt: "Press E to inspect" })
    on E: open dialogue tree "business_purchase_<businessId>"
      → confirm → useBusinessStore.purchase(businessId)
      → on success: toast "You own The Rusty Anchor!"
  else:
    setHud({ prompt: "Press E to manage" })
    on E: bus.emitTyped("business:open", { businessId: sign.businessId })
```

Reuse the existing dialogue choice flow (see `cutscenes/` and
`Dialogue.tsx`). If that's overkill for a yes/no, a simpler one-shot
confirmation modal is fine — but check `Shop.tsx` first, the codebase
likely has a pattern.

## Manage UI

```
<BusinessManager />
  open state in uiStore (mirror Shop.tsx pattern):
    business: { open: boolean, businessId: string | null }
  bus listener: on "business:open" → setOpen(true, businessId)

  layout:
    ┌ Portfolio picker (only shown if owned > 1) ──────┐
    │ [The Rusty Anchor ▼]                              │
    ├ Tabs ────────────────────────────────────────────┤
    │ [Overview] [Staff] [Upgrades] [Stock] [Books]     │
    ├ Body ────────────────────────────────────────────┤
    │ <Overview businessId={...} />                     │
    └───────────────────────────────────────────────────┘
```

Stubs for Staff/Upgrades/Stock/Books: a div saying "Coming soon" so the
tab strip renders correctly.

## Overview tab content

- Coffers value (large number, coin icon).
- Today's net (revenue − expenses) — for now show 0 / "no data yet".
- Capacity utilization — show 0% / "no patrons yet".
- Last 7 days bar chart placeholder — empty array → "No history".
- **Withdraw** / **Deposit** buttons → small modal/inline input → calls
  `withdraw(businessId, n)` / `deposit(businessId, n)`. Disable when
  amount would over/underflow.

These metrics will go live once steps 6/7 ship — for now Overview just
displays state from `businessStore` and exercises the wallet API.

## Open questions

1. Do signs live in world chunks (overworld) or interior maps? Suggests
   "both" — overworld sign in front, interior ledger book inside. For
   step 3, just put one outside the tavern.
2. Modal sizing — match `Shop.tsx` viewport conventions.

## Done when

- `tsc` + `vite build` clean.
- Manual: walk to sign → confirm purchase → coin drops → re-interact shows
  "Press E to manage" → opens panel → withdraw/deposit moves coin between
  wallets correctly → save/load round-trips.
