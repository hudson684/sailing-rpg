# Phase 3 — Predicate evaluator (activity, time, flag, calendar)

## Goal

Turn the opaque `requires` object on each `ParticipantSpec` into a
typed, statically-analyzable predicate evaluated against an NPC and
the current world context. Four predicate kinds in v1: `activity`,
`time`, `flag`, `calendar`.

## Why third

The director needs to filter eligible chats per-pair. Without
predicates everything matches and the umbrella chat fires whenever
Brom and any tourist are within 5 tiles, regardless of what they're
doing. This phase makes "Brom is tending the shop" expressible.

## Background

The schedule-enrichments plan (`plan/npc-schedule-enrichments/02-conditional-keys.md`)
already designed a similar predicate vocabulary for schedule
resolution. We borrow the predicate object shape so authors see the
same syntax in both systems and a future shared evaluator is trivial.
We do not actually share code yet — premature DRY across two callers
isn't worth the coupling — but the shapes match.

Inputs are all things that already exist:

- Activity → `agent.currentActivity?.kind` (string).
- Time → `timeStore` exposes hour, phase, dayCount.
- Flag → existing flag store (same one quests + schedule resolver use).
- Calendar → `CalendarContext` (weather, festival id, season,
  day-of-week), already passed through `time:midnight`.

## Deliverables

### 1. Predicate shape

`src/game/sim/chat/chatPredicates.ts`:

```ts
export type ChatPredicate =
  | { activity: string | string[] }
  | { time: { phase?: "day" | "night"; hours?: { from: number; to: number } } }
  | { flag: { key: string; equals?: string | number | boolean; truthy?: boolean } }
  | { calendar:
        { weather?: string | string[] }
      | { festival?: string | string[] }
      | { season?: string | string[] }
      | { dayOfWeek?: string | string[] } };
```

`requires` on a `ParticipantSpec` is `ChatPredicate[]` — implicit AND
across the array. No OR / NOT in v1; if needed later, wrap into
`{ any: ChatPredicate[] }` / `{ not: ChatPredicate }` additively.

Update `chatTypes.ts` from phase 2 to type `requires` as
`ChatPredicate[]` and re-validate at index build time (each entry
must match one of the four shapes; reject unknown predicate keys
with a startup error).

### 2. Evaluator

```ts
export interface PredicateContext {
  agent: NpcAgent;
  now: { hour: number; phase: "day" | "night"; dayCount: number };
  calendar: CalendarContext;
  flags: FlagStore;  // existing
}

export function evaluatePredicate(p: ChatPredicate, ctx: PredicateContext): boolean;

export function evaluateAll(ps: ChatPredicate[] | undefined, ctx: PredicateContext): boolean;
```

`evaluateAll` returns `true` when `ps` is undefined or empty. Pure
function; no caching. Called per candidate pair per director tick —
typical hot-path is 0–4 predicates per participant, two participants.

Hour ranges are inclusive `from`, exclusive `to`, with wraparound
support (`{ from: 22, to: 4 }` = 22:00–03:59).

### 3. Per-tick context build

Director (phase 4) builds one `PredicateContext` per tick (cheap;
just reads timeStore + calendar) and passes it into `evaluateAll`
twice per pair — once per slot, with the appropriate `agent`.

### 4. Update the umbrella chat

```json
"shopkeeper": {
  "match": { "npcId": "blacksmith_brom" },
  "requires": [{ "activity": "tend_shop" }]
},
"customer": {
  "match": { "archetype": "tourist" },
  "requires": [{ "activity": "browse" }]
}
```

## Out of scope

- OR / NOT combinators. Add only if a real chat needs them.
- Predicates that read other NPCs' state ("Brom is alone"). Single-
  agent context only; cross-agent constraints belong in the director's
  pair check, not in `requires`.
- Friendship / reputation. The schedule plan reserves the syntax; we
  can adopt the same `flag`-shaped predicate when those land.
- A shared evaluator with the schedule resolver. Tracked as a
  follow-up; not worth the abstraction with one caller.

## Definition of done

- `evaluateAll` correctly accepts/rejects the four predicate kinds
  with unit-testable purity (covered with a small in-file test if
  the project has one, otherwise verified via the director in phase 4).
- The umbrella chat's `requires` parses, validates, and evaluates
  correctly for Brom-tending vs Brom-idle.
- Unknown predicate keys throw at startup with file + field name.
- `npx tsc --noEmit` passes.
