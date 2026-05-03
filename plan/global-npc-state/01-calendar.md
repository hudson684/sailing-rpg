# Phase 1 — Calendar + day-of-week

## Goal

Add the time concepts the rest of the system needs. No NPC behavior
change yet; this is pure foundation.

## Why first

Schedules are keyed by day-of-week and (eventually) season. Every
downstream phase assumes `CalendarContext` exists. Cheap to add now,
expensive to retrofit.

## Deliverables

- `src/game/sim/calendar/calendar.json` — week names and length, month
  names and lengths, season mapping. Default to a 7-day week and
  whatever month structure feels right; swappable later.
- `src/game/sim/calendar/calendar.ts` — pure functions:
  - `dayOfWeek(dayCount): string`
  - `monthOfYear(dayCount): { name, dayOfMonth }`
  - `season(dayCount): string`
  - `calendarContextFor(dayCount): CalendarContext` — bundles the above
- `src/game/time/constants.ts` — extend `TimeManager` to emit
  `onMidnight(calendarCtx)` alongside existing minute/hour ticks.
- Dev console: a debug overlay line showing
  `Day {N} • {dayOfWeek} • {monthName} {dayOfMonth} • {season}`.

## Validation

- Game runs unchanged.
- Dev overlay shows correct day-of-week ticking forward across midnight.
- Manually advance time multiple days; week wraps correctly; month
  rollover works.
- `onMidnight` fires exactly once per midnight crossing, with the
  correct context.

## Risks / mitigations

- **Risk:** existing code reads `dayCount` directly; introducing
  calendar shouldn't break that. **Mitigation:** calendar is purely
  derived; `dayCount` stays as the canonical counter.
- **Risk:** time compression edge cases (crossing midnight in a partial
  tick). **Mitigation:** `onMidnight` triggered on integer-day boundary
  detection in the existing tick loop, not on a separate timer.

## Out of scope

- Year-end / new year handling. Add when first needed.
- Holidays / festivals. Calendar can be extended; nothing consumes them
  in phase 1.
- Weather. Independent system.
