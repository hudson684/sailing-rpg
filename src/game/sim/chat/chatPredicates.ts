import type { CalendarContext } from "../calendar/calendar";
import { festivalForDay } from "../festivals/festivalRegistry";
import type { FlagStore } from "../../flags/FlagStore";
import type { NpcAgent } from "../npcAgent";

// Static, AND-combined predicate vocabulary for chat eligibility.
// Mirrors the schedule-enrichments shape so authors see one syntax in
// both systems; we don't share the evaluator yet (premature DRY across
// two callers), only the JSON spelling.

export type ChatPredicate =
  | { activity: string | string[] }
  | { time: { phase?: "day" | "night"; hours?: { from: number; to: number } } }
  | { flag: { key: string; equals?: string | number | boolean; truthy?: boolean } }
  | {
      calendar:
        | { weather: string | string[] }
        | { festival: string | string[] }
        | { season: string | string[] }
        | { dayOfWeek: string | string[] };
    };

export interface ChatPredicateContext {
  agent: NpcAgent;
  now: { hour: number; phase: "day" | "night"; dayCount: number };
  calendar: CalendarContext;
  flags: FlagStore;
  /** Live weather id; null when no weather system exists yet. */
  weather: string | null;
}

function asList(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

/** Author-time validator. Throws on unknown predicate keys; called by the
 *  chat index loader so author errors surface at startup. */
export function validateChatPredicate(p: unknown, where: string): asserts p is ChatPredicate {
  if (!p || typeof p !== "object") {
    throw new Error(`${where}: predicate must be an object`);
  }
  const keys = Object.keys(p as object);
  if (keys.length !== 1) {
    throw new Error(`${where}: predicate must have exactly one kind key, got [${keys.join(",")}]`);
  }
  const k = keys[0];
  if (k !== "activity" && k !== "time" && k !== "flag" && k !== "calendar") {
    throw new Error(`${where}: unknown predicate kind '${k}' (expected activity|time|flag|calendar)`);
  }
}

function inHourRange(hour: number, range: { from: number; to: number }): boolean {
  // Inclusive `from`, exclusive `to`. Wraparound supported: from > to means
  // the range crosses midnight (e.g. 22 → 4 covers 22,23,0,1,2,3).
  const { from, to } = range;
  if (from === to) return false;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

export function evaluatePredicate(p: ChatPredicate, ctx: ChatPredicateContext): boolean {
  if ("activity" in p) {
    const want = asList(p.activity);
    const cur = ctx.agent.currentActivity?.kind ?? null;
    return cur !== null && want.includes(cur);
  }
  if ("time" in p) {
    const t = p.time;
    if (t.phase && t.phase !== ctx.now.phase) return false;
    if (t.hours && !inHourRange(ctx.now.hour, t.hours)) return false;
    return true;
  }
  if ("flag" in p) {
    const f = p.flag;
    const v = ctx.flags.get(f.key);
    if (f.truthy !== undefined) {
      return f.truthy ? Boolean(v) : !v;
    }
    if (f.equals !== undefined) {
      return v === f.equals;
    }
    // Bare `{ flag: { key } }` — treat as truthy check.
    return Boolean(v);
  }
  // calendar
  const c = p.calendar;
  if ("weather" in c) {
    if (ctx.weather === null) return false;
    return asList(c.weather).includes(ctx.weather);
  }
  if ("festival" in c) {
    const fest = festivalForDay(ctx.calendar);
    if (!fest) return false;
    return asList(c.festival).includes(fest.id);
  }
  if ("season" in c) {
    return asList(c.season).includes(ctx.calendar.season);
  }
  if ("dayOfWeek" in c) {
    return asList(c.dayOfWeek).includes(ctx.calendar.dayOfWeek);
  }
  return false;
}

export function evaluateAll(
  ps: ChatPredicate[] | undefined,
  ctx: ChatPredicateContext,
): boolean {
  if (!ps || ps.length === 0) return true;
  for (const p of ps) {
    if (!evaluatePredicate(p, ctx)) return false;
  }
  return true;
}
