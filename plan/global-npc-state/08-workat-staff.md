# Phase 8 — WorkAt + staff service refactor

## Goal

Hired staff become registry NPCs driven by `WorkAt` activities, mirror
of `PatronTavern`. Staff now exist as world citizens with homes and
commutes, not just appearing at the tavern at open time.

## Why eighth

The pattern is proven by phase 5. This is a mechanical migration of a
known-working FSM. Doing it after the tourist system is shipping
means the registry has been exercised under realistic load before
staff (a critical user-facing feature) gets touched.

## Deliverables

- `src/game/business/staff/staffService.ts` — public API:
  - `clockIn(npc: NpcAgent, handle: BodyHandle, role: RoleId): Accepted | Rejected`
  - `clockOut(npcId: string): void`
  - Event: `onShiftComplete(handler)` — returns the body handle.
- Refactor `customerSim.ts` staff portions:
  - Remove `reconcileStaffSchedule`'s synthetic-NPC creation.
  - Staff agent FSM (cook / server / bartender) preserved; references
    swap to borrowed `NpcAgent` + held `BodyHandle`.
  - "Departing" state ends by calling `clockOut`, which invokes
    `onShiftComplete` and returns the handle.
- `src/game/sim/activities/workAt.ts`
  - On enter: `GoTo` workstation tile; on arrival, `clockIn`; transfer
    handle; sleep until `onShiftComplete`; reclaim handle; complete.
  - Abstract: agent is "at workstation working" for the shift duration.
- Hired staff get:
  - A residence tile in town (Tiled object class `npcResidence` with
    `npcId` property linking to the hired staff record). Author one
    per current hireable in a sensible spot.
  - Baseline schedule (built into staff archetype, not data-driven
    yet): `Sleep(home)` → `GoTo(business)` → `WorkAt(business, role)`
    → `GoTo(home)` → `Sleep(home)`.
- `Sleep(home)` activity (minimal): NPC stands/lies at home tile,
  abstract for the duration; live just shows them at the tile.
- **Feature flag** `npcRegistryStaff` (default off in this phase).
  - Off: existing staff path runs unchanged.
  - On: hired staff are registry NPCs running `WorkAt`.

## Validation

- Flag off: hired staff behavior 100% unchanged.
- Flag on:
  - Existing hired staff arrive at the right time, work their shift,
    leave on close (matching baseline behavior).
  - Difference: between shifts, they're visible at their home tiles
    in town instead of vanishing.
  - Walking past the residence shows them at home; walking past at
    work hours shows them commuting or at workstation.
- Hire a new staffer mid-game: registry registers a new agent;
  schedule applies starting next shift.
- Fire / quit a staffer: agent unregistered, residence freed.
- Save / reload: staff in correct location for time of day.
- `npx tsc --noEmit` and `npx vite build` clean.

## Risks / mitigations

- **Risk:** breaks the hire feature. **Mitigation:** flag protects
  release; A/B comparison required before flipping.
- **Risk:** wage / unpaid-day tracking lives in the business store
  and may assume staff are tied to the business, not the registry.
  **Mitigation:** wage logic stays in business store; registry adds
  no opinions. The agent is just the "body" that walks around.
- **Risk:** staff homes overlap or sit on unwalkable tiles.
  **Mitigation:** Tiled validator extended to check `npcResidence`
  tiles are walkable.

## Out of scope

- NPC-authored staff schedules (e.g. part-time, days off). Baseline
  schedule for now; data-drive in a future phase.
- Staff-staff interactions (chat, training). Future.
- Player-NPC interactions at the residence (visit, give gift). Future.
