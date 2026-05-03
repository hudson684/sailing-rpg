# Phase 7 — Browse + Idle support activities

## Goal

Flesh out the activity vocabulary so tourists do more than walk and
patron the tavern. Adds `Browse(business, duration)` for shop visits
and `Idle(area, duration)` for standing around / pacing.

## Why seventh

Phase 6 ships with `Browse` as a placeholder (mostly "stand inside
the shop for D minutes"). This phase makes it look alive: NPCs
wander between browse waypoints, pause at the counter, occasionally
trigger a shopkeeper greeting.

## Deliverables

- `src/game/sim/activities/browse.ts`
  - Live: pick random browse waypoint inside the business interior,
    pathfind, pause for a few seconds, repeat until duration expires.
  - Abstract: just decrements duration; agent's location is "inside
    business X."
  - Optional counter interaction: with probability P, walks to the
    counter and triggers a "browsed" event the business can react to
    (future hook for sales).
- `src/game/sim/activities/idle.ts`
  - Live: stand or short-pace inside a tagged area; periodic facing
    changes; occasional anim flourish.
  - Abstract: decrements duration.
- Tiled object class `npcBrowseWaypoint` (interior maps): tags points
  inside shops as browse-worthy. Tagged with optional
  `browseGroupId` for multi-zone shops.
- General store and blacksmith interiors: place 4–6 browse waypoints
  each (existing Tiled edits).
- Schedule template enhancement (`tourist.json`): `browse` entries
  reference `browseGroupId` (defaults to "all").

## Validation

- Tourist's full day plan plays out with believable shop visits
  (NPCs visibly drift around inside the shop, not glued to one tile).
- Multiple tourists in a shop at once don't all stand on the same
  waypoint (probabilistic distribution).
- `Idle` activity used at the docks looks plausible (waiting tourists
  don't appear catatonic).
- `npx tsc --noEmit` and `npx vite build` clean.

## Risks / mitigations

- **Risk:** browse waypoints clustered in a corner → NPCs look
  glitchy. **Mitigation:** authoring guideline: ≥3 waypoints, spread
  across the shop floor.
- **Risk:** shopkeeper "browsed" events fire too often and become
  noise. **Mitigation:** probability tunable per business; default
  low; no UI hookup yet.

## Out of scope

- Actual purchases by NPCs (browse is cosmetic for now). Integrate
  with business revenue when balancing the economy later.
- `Converse(npc)` activity. Stub for future.
- Per-shop browse animations (item-pickup, examine). Future polish.
