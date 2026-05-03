# Phase 3 — Hard arrival times + idle padding

## Goal

Let schedule templates declare "this activity must start by HH:MM."
The planner inserts `Idle` padding when an NPC would otherwise arrive
early; the registry recovery-warps when abstract walk overshoots.
Stardew's `1300 Town 47 87` semantics — without a string DSL.

## Why

Today, plans are duration-driven: `Browse(20m) → GoTo(tavern) →
PatronTavern`. There's no way to author "the cook must be at the
tavern by 18:00" — you tune browse durations and hope. This makes
"shop opens at 9:00" emergent and fragile. With explicit arrival
times, authors get to think in clock terms and the system handles the
filler.

## Background

Two modes of "arrival":

- **Soft (existing):** plan is a sequence; each activity's duration
  determines when the next one starts. Walk durations come from
  `estimatedWalkMinutes`. Slack accumulates.
- **Hard (new):** an activity is annotated `mustStartAt: 1080`
  (minute-of-day). The planner builds the day so this is the start
  time, padding earlier activities or trimming their durations as
  needed.

This is opt-in per template. Existing templates (which don't declare
`mustStartAt`) keep the soft semantics.

## Deliverables

### 1. Template schema addition

```json
{
  "id": "patron_tavern_dinner",
  "kind": "patronTavern",
  "target": { "kind": "businessArrival", "businessId": "rusty_anchor" },
  "mustStartAt": 1080,
  "weight": 1.5
}
```

Mutually exclusive with `windowMinute` on the same template: a
`mustStartAt` template either runs at that time or is skipped for the
day. The build validator enforces exclusivity.

### 2. Planner pass: hard-time anchoring

In `scheduler.planDay`, after templates are sampled but before the
final activity list is emitted:

1. Sort sampled templates by `mustStartAt` (templates without it stay
   in their original order, slotted between hard anchors).
2. For each hard-anchored template, compute the expected arrival time
   based on accumulated durations + estimated walk time of the
   preceding `GoTo`.
3. If expected arrival < `mustStartAt`: insert `Idle` padding (or
   extend the previous flexible activity's duration) to land exactly
   at the anchor.
4. If expected arrival > `mustStartAt` AND the overrun is within a
   tolerance (e.g. ≤ 30 min): trim the previous flexible activity's
   duration. If the overrun exceeds tolerance, drop earlier flexible
   activities until it fits, or drop the hard-anchored template
   entirely (with a dev-console warning).

The seeded RNG runs *before* this pass — so identical seeds still
produce identical plans.

### 3. Activity-level execution

`GoToActivity` gains `mustArriveBy?: number`. On `tickAbstract`, if
the abstract walk timer has overshot `mustArriveBy` by more than the
quarter-hour tick granularity, call `ctx.registry.setLocation(npc.id,
target)` to teleport and mark the activity complete. This matches
Stardew's "warp on the next 10-min tick to recover" behavior.

In live mode, no teleport — the player can see the NPC. They just
arrive a bit late. The hard time is a soft constraint when the player
is watching.

### 4. Dev visualization

When the planner inserts padding or trims, log to dev console once
per midnight per agent: `[plan] cook: padded 18m before patron_tavern_dinner`.
Useful for tuning during authoring.

## Validation

- A schedule with one `mustStartAt: 1080` activity always has the
  agent's `currentActivity` = that activity at minute 1080 (within the
  quarter-hour tick granularity), regardless of how long the preceding
  activities take.
- Two `mustStartAt` activities at 0900 and 1700 — both hit their
  times; flexible activities in between scale to fit.
- A `mustStartAt` activity that's reachable only by skipping every
  flexible activity gets dropped, with a dev warning.
- Live mode: walking with the player watching, the agent doesn't
  teleport. They arrive late if necessary.
- Abstract mode: a 6-hour walk in the plan, but `mustStartAt: 1080`
  fires at minute 1080 on the dot.
- Save mid-walk-with-mustArriveBy, reload: the agent resumes correctly.

## Risks / mitigations

- **Risk:** Live arrival lateness diverges visibly from abstract
  arrival precision. **Mitigation:** This is intentional. Abstract is
  a coarse model; the player-watching case takes priority on smooth
  visuals over clock precision. Document in `docs/npc-system.md`.
- **Risk:** padding inserts `Idle` activities at locations that don't
  make sense for idling (e.g. the middle of a road). **Mitigation:**
  the padded `Idle` happens *before* the preceding `GoTo` to the next
  location, so the agent idles at their previous location, not in
  transit. If they're already at the destination and need to wait,
  that's fine — `Idle` works anywhere.
- **Risk:** schedule densities make padding/trim infeasible.
  **Mitigation:** the planner emits warnings; authors see them at
  midnight in the dev console and tune. No silent failures.

## Out of scope

- Mid-day re-anchoring after a delay. Once the day plan is built, it's
  built. If a player conversation makes the cook 30 minutes late,
  downstream `mustStartAt` activities just teleport-recover via the
  abstract overshoot path.
- `mustEndAt` per template. The constraint object already supports
  `mustEndAt: spawnPoint` at the bundle level; per-template end times
  aren't authored anywhere yet. Add when first needed.
- Pre-resolved A* path budgets for accurate walk duration estimates.
  Phase 6 area.

## Files touched

- Edited: `src/game/sim/activities/goTo.ts`
- Edited: `src/game/sim/planner/scheduler.ts`
- Edited: `src/game/sim/data/README.md`
- Edited: `tools/validate-schedule-bundles.mjs`
- Edited: `docs/npc-system.md` (note the live/abstract divergence)
