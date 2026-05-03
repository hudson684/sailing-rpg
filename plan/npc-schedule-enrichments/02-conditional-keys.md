# Phase 2 — Conditional schedule keys

## Goal

Extend the resolver so a variant can declare conditions beyond
day/season/weather: friendship thresholds, world flags, agent flags,
calendar predicates. This is what makes schedules feel reactive to the
player's progress — Stardew's 1.6 condition syntax minus the Turing-
completeness.

## Why second

Phase 1 stands up the resolution machinery. Adding conditional
predicates is a strictly additive layer on the same dispatch table;
doing it as a separate phase keeps the diff small and the behavior
testable in isolation.

## Background

Stardew supports keys like:

```
spring_Mon_abigail_friendship_4
summer_<buildingName>_completed
NOT friendship abigail 6
```

We want the same expressiveness, but as structured data instead of a
string DSL. Variants get an optional `when` clause. The resolver
evaluates `when` against current state; the first variant whose key
priority matches AND whose `when` evaluates true wins.

## Deliverables

### 1. `when` clause schema

```json
{
  "Mon": {
    "when": {
      "all": [
        { "flag": "tavern_repaired" },
        { "friendship": { "npc": "cook", "gte": 4 } }
      ]
    },
    "templates": [...]
  }
}
```

Predicate types (initial set):

- `{ "flag": "<name>" }` — global world flag is set.
- `{ "agentFlag": "<name>" }` — `agent.flags[name]` is set.
- `{ "notFlag": "<name>" }` — sugar for `{ "not": { "flag": "..." } }`.
- `{ "friendship": { "npc": "<id>", "gte": <n> } }` — reserved syntax;
  evaluator returns `false` until friendship data exists, so authoring
  works ahead of the system.
- `{ "season": "<name>" }` — redundant with the season key but useful
  inside compound predicates.
- `{ "dayOfWeek": "<name>" }` — same.
- `{ "weather": "<name>" }` — same.
- `{ "all": [predicate, ...] }` — AND.
- `{ "any": [predicate, ...] }` — OR.
- `{ "not": predicate }` — NOT.

The schema is a discriminated union; Zod parses it at load. Unknown
keys fail at build time.

### 2. Resolver evaluator

`scheduleResolver.ts` gains:

```ts
export interface PredicateInputs {
  readonly calendar: CalendarContext;
  readonly weather: string | null;
  readonly worldFlags: ReadonlySet<string>;
  readonly agentFlags: ReadonlyMap<string, boolean>;
  readonly friendship: (npcId: string) => number;  // 0 if unknown
}

function evaluatePredicate(p: Predicate, ins: PredicateInputs): boolean;
```

Resolver loop becomes: walk priority list, for each candidate variant
check both the key match AND `evaluatePredicate(variant.when ?? TRUE)`.

### 3. Friendship hook (stub)

Add `npcRegistry.getFriendship(npcId): number` returning 0 by default.
Real implementation lands when relationships are designed; the stub
keeps phase 2 shippable now.

### 4. Determinism guard

The predicate inputs all come from sources that are stable across a
midnight tick (calendar, weather, flags, friendship — none of which a
mid-day tick should change for resolver purposes). Add a dev assertion
in the predicate evaluator: if a predicate input changes between a
plan resolution and its execution within the same day, log a warning.
Cheap, catches subtle authoring bugs.

### 5. Authoring docs

Update `src/game/sim/data/README.md` with predicate examples for the
common patterns: "this NPC only goes to the tavern on weekends after
you've befriended them," "this shop opens late on rainy days."

## Validation

- A variant with `{ "when": { "flag": "x" } }` matches only when flag
  `x` is set.
- An unknown predicate type fails the build validator.
- A friendship predicate evaluates `false` (because friendship is
  stubbed at 0) — variants gated on friendship don't activate, but
  authoring them passes validation.
- Save/load round-trip with a flag-conditional variant: set the flag,
  save, load, verify the same variant still resolves.
- An agent's mid-day flag flip does NOT cause a replan (that's
  intentional; the warning above fires).
- Snapshot test: a townsfolk with no `when` clauses behaves identical
  to phase 1.

## Risks / mitigations

- **Risk:** predicate evaluator becomes a hairy DSL nobody can extend
  safely. **Mitigation:** discriminated union + Zod schema means
  adding a predicate is a typed, localized change. Resist string-DSL
  pressure forever.
- **Risk:** authors add expensive predicates (friendship lookups
  over many NPCs). **Mitigation:** predicate evaluation runs once per
  agent at midnight, not per frame. Cost is negligible.
- **Risk:** `friendship` stub returns 0 silently masks bugs.
  **Mitigation:** dev console warns once per session if any predicate
  reads friendship before the system is implemented. Single-line nag.

## Out of scope

- Quest-completion predicates. Add when a quest system exists.
- Time-of-day predicates. The schedule already addresses time via
  `windowMinute` on individual templates; conditional keys are a
  day-granularity tool.
- Mid-day re-resolution. The resolver runs at midnight only.

## Files touched

- Edited: `src/game/sim/planner/scheduleResolver.ts`
- Edited: `src/game/sim/planner/scheduleResolver.test.ts`
- Edited: `src/game/sim/npcRegistry.ts` (friendship stub)
- Edited: `src/game/sim/data/README.md`
- Edited: `tools/validate-schedule-bundles.mjs`
