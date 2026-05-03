# Phase 5 — PatronTavern + customerSim refactor

## Goal

The tavern's existing customer FSM accepts NPCs from the registry
instead of spawning its own. First delegated activity. Behavior in
the tavern is identical to before.

## Why fifth

`GoTo` (phase 4) gives an NPC the ability to arrive. This phase proves
the body-handle delegation pattern with a real subsystem, against the
most complex existing FSM in the codebase. If the pattern works here,
`WorkAt` in phase 8 is mechanical.

## Deliverables

- `src/game/business/customerSim/patronService.ts` — public API:
  - `requestSeat(npc: NpcAgent, handle: BodyHandle): Accepted | Queued | Rejected`
  - `releasePatron(npcId: string): void`
  - Event: `onPatronComplete(handler)` — fires when a patron leaves;
    delivers the body handle back to the activity.
- Refactor `src/game/business/customerSim.ts`:
  - Remove `spawnCustomer()` and the synthetic `NpcDef` creation path.
  - 14-state FSM is preserved; `currentCustomer` references swap from
    "owned synthetic NPC" to "borrowed `NpcAgent` + held `BodyHandle`."
  - All position/animation writes go through the handle.
  - On patron completion, FSM calls `service.releasePatron(npcId)`
    which invokes `onPatronComplete`, returning the handle.
- `src/game/sim/activities/patronTavern.ts`
  - On enter: walks to tavern door (via inner `GoTo`), then calls
    `patronService.requestSeat`.
  - `Accepted`: hands `BodyHandle` over via `transfer`; sleeps until
    `onPatronComplete` fires; reclaims handle; marks complete.
  - `Queued{eta}`: idles near the door for up to `eta + slack`; if
    not accepted by deadline, marks complete (failure flag set).
  - `Rejected`: marks complete with failure flag; planner may pick a
    fallback next activity.
  - Abstract: collapses to "patron is in tavern for ~D minutes" using
    the existing FSM's typical duration; live takes over on
    materialize.
- **Feature flag** `npcRegistryPatrons` (default off in this phase).
  - Off: existing `spawnCustomer` path runs unchanged.
  - On: `spawnCustomer` is a no-op; tavern customers come from
    registry NPCs running `PatronTavern`.
  - Allows side-by-side comparison; flag removed in phase 9.

## Validation

- Flag off: existing tavern behavior 100% unchanged.
- Flag on, manual probe: dev console spawns a registry NPC at the
  tavern door with `[PatronTavern(rusty_anchor)]`. Observe:
  - Walks in.
  - Approaches bartender, places order.
  - Walks to seat (or stays at bar in self-serve mode).
  - Eats.
  - Pays.
  - Leaves.
- Sprite, anim, ticket states all match flag-off baseline.
- Capacity full: trigger 12 simultaneous registry patrons against an
  8-seat tavern. Verify `Queued` and `Rejected` paths behave; no
  patron stuck forever.
- Save / reload mid-meal: patron resumes from correct FSM state.
- `npx tsc --noEmit` and `npx vite build` clean.

## Risks / mitigations

- **Risk:** subsystem holds handle past completion → next activity
  can't drive the body. **Mitigation:** `onPatronComplete` is
  guaranteed-called from FSM exit states; activity asserts handle
  reclaim within one tick.
- **Risk:** existing `customerSim` has implicit assumptions about
  owning the customer's lifecycle (e.g. despawn on tavern close).
  **Mitigation:** "despawn" becomes "release patron"; the registry
  NPC continues with their next activity (probably `GoTo(home)`).
  Audit existing despawn paths during the refactor.
- **Risk:** flag drift — the two paths diverge in a subtle way that
  passes manual checks but breaks later. **Mitigation:** flag lifetime
  is one phase. Phase 6 turns it on; phase 9 deletes it and the old
  path.

## Out of scope

- New patron behaviors (party seating, regulars, etc.). Same FSM.
- Tavern queueing UI. Backend supports it; UI later.
- Migrating staff. Phase 8.
