import type { CalendarContext } from "../calendar/calendar";
import {
  getScheduleBundle,
  type ScheduleBundle,
  type ScheduleConstraints,
  type ScheduleDef,
  type ScheduleTemplate,
  type ScheduleVariantBody,
} from "./archetypes";

/** Phase 1+2: typed predicate language for variant `when` clauses. Discriminated
 *  union; Zod isn't strictly necessary at the JSON boundary because TypeScript
 *  + the build-time validator (`tools/validate-schedule-bundles.mjs`) cover
 *  the same ground. Nodes evaluate against `PredicateInputs`. */
export type Predicate =
  | { readonly flag: string }
  | { readonly notFlag: string }
  | { readonly agentFlag: string }
  | { readonly friendship: { readonly npc: string; readonly gte: number } }
  | { readonly season: string }
  | { readonly dayOfWeek: string }
  | { readonly weather: string }
  | { readonly all: readonly Predicate[] }
  | { readonly any: readonly Predicate[] }
  | { readonly not: Predicate };

export interface PredicateInputs {
  readonly calendar: CalendarContext;
  readonly weather: string | null;
  readonly worldFlags: ReadonlySet<string>;
  readonly agentFlags: ReadonlyMap<string, boolean>;
  /** Returns 0 when friendship is unknown — phase 2's stub. */
  readonly friendship: (npcId: string) => number;
}

/** Phase 2: friendship predicate stub warning latch. Fires once per session
 *  if a predicate evaluator reads friendship before the system exists. */
let friendshipNagged = false;

/** Reset the once-per-session friendship warning latch. Test-only. */
export function _resetFriendshipNag(): void {
  friendshipNagged = false;
}

export function evaluatePredicate(p: Predicate, ins: PredicateInputs): boolean {
  if ("flag" in p) return ins.worldFlags.has(p.flag);
  if ("notFlag" in p) return !ins.worldFlags.has(p.notFlag);
  if ("agentFlag" in p) return ins.agentFlags.get(p.agentFlag) === true;
  if ("friendship" in p) {
    if (!friendshipNagged) {
      friendshipNagged = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[scheduleResolver] friendship predicate evaluated but friendship system is stubbed (returns 0). Predicate will not match.",
      );
    }
    return ins.friendship(p.friendship.npc) >= p.friendship.gte;
  }
  if ("season" in p) return ins.calendar.season === p.season;
  if ("dayOfWeek" in p) return ins.calendar.dayOfWeek === p.dayOfWeek;
  if ("weather" in p) return ins.weather === p.weather;
  if ("all" in p) return p.all.every((c) => evaluatePredicate(c, ins));
  if ("any" in p) return p.any.some((c) => evaluatePredicate(c, ins));
  if ("not" in p) return !evaluatePredicate(p.not, ins);
  return false;
}

export interface ScheduleResolverInputs {
  readonly bundle: ScheduleBundle;
  readonly calendar: CalendarContext;
  readonly weather: string | null;
  readonly worldFlags?: ReadonlySet<string>;
  readonly agentFlags?: ReadonlyMap<string, boolean>;
  readonly friendship?: (npcId: string) => number;
}

export interface ResolvedScheduleDef extends ScheduleDef {
  /** The variant key the resolver matched (e.g. "Mon", "rain", "default"). */
  readonly resolvedKey: string;
}

/** Phase 1+2: resolve which variant of a bundle applies for the given calendar
 *  / weather / flags. Pure: same inputs → same output. The priority order is:
 *
 *    1. festival_<id> (reserved — phase 5; resolver doesn't know festivals
 *       directly, so authors using this key must manually set it. Most
 *       festival overrides will go through the festival replanner instead.)
 *    2. flag_<name> (when world flag <name> is set)
 *    3. friendship_<npc>_<n> (reserved syntax — predicate-evaluated)
 *    4. <season>_<dayOfMonth> (e.g. summer_15)
 *    5. <weather>_<dayOfWeek> (e.g. rain_Lunaday)
 *    6. <weather>
 *    7. <season>_<dayOfWeek>
 *    8. <dayOfWeek>
 *    9. <season>
 *   10. default (required)
 *
 *  A variant is a match only if its key is in the priority list AND its
 *  optional `when` predicate evaluates true. Aliases follow up to depth 4. */
const ALIAS_MAX_DEPTH = 4;

export function buildPriorityKeys(
  calendar: CalendarContext,
  weather: string | null,
  worldFlags: ReadonlySet<string>,
): string[] {
  const keys: string[] = [];
  // Phase 2 reserves flag_* keys at the front of the priority list. Authoring
  // a `flag_<name>` variant gates it on `worldFlags.has(name)` purely via the
  // key, sidestepping the `when` clause for the simple case.
  for (const flag of worldFlags) keys.push(`flag_${flag}`);
  keys.push(`${calendar.season}_${calendar.dayOfMonth}`);
  if (weather) keys.push(`${weather}_${calendar.dayOfWeek}`);
  if (weather) keys.push(weather);
  keys.push(`${calendar.season}_${calendar.dayOfWeek}`);
  keys.push(calendar.dayOfWeek);
  keys.push(calendar.season);
  keys.push("default");
  return keys;
}

function resolveAlias(
  bundle: ScheduleBundle,
  startKey: string,
): { key: string; body: ScheduleVariantBody } | null {
  let key = startKey;
  let body = bundle.variants[key];
  if (!body) return null;
  let depth = 0;
  while (body.alias) {
    if (depth >= ALIAS_MAX_DEPTH) {
      // eslint-disable-next-line no-console
      console.warn(`[scheduleResolver] alias chain on '${bundle.id}.${startKey}' exceeded depth ${ALIAS_MAX_DEPTH}; bailing.`);
      return null;
    }
    const next = bundle.variants[body.alias];
    if (!next) {
      // eslint-disable-next-line no-console
      console.warn(`[scheduleResolver] alias on '${bundle.id}.${key}' targets unknown key '${body.alias}'.`);
      return null;
    }
    key = body.alias;
    body = next;
    depth += 1;
  }
  return { key, body };
}

function bodyToDef(
  bundleId: string,
  key: string,
  body: ScheduleVariantBody,
): ResolvedScheduleDef | null {
  if (!body.templates) return null;
  return {
    id: bundleId,
    constraints: body.constraints ?? {},
    templates: body.templates,
    resolvedKey: key,
  };
}

const TRUE_PREDICATE_INPUTS = {
  worldFlags: new Set<string>(),
  agentFlags: new Map<string, boolean>(),
  friendship: () => 0,
} as const;

export function resolveScheduleVariant(
  inputs: ScheduleResolverInputs,
): ResolvedScheduleDef | null {
  const worldFlags = inputs.worldFlags ?? TRUE_PREDICATE_INPUTS.worldFlags;
  const agentFlags = inputs.agentFlags ?? TRUE_PREDICATE_INPUTS.agentFlags;
  const friendship = inputs.friendship ?? TRUE_PREDICATE_INPUTS.friendship;
  const predIns: PredicateInputs = {
    calendar: inputs.calendar,
    weather: inputs.weather,
    worldFlags,
    agentFlags,
    friendship,
  };
  const keys = buildPriorityKeys(inputs.calendar, inputs.weather, worldFlags);
  for (const k of keys) {
    if (!(k in inputs.bundle.variants)) continue;
    const resolved = resolveAlias(inputs.bundle, k);
    if (!resolved) continue;
    if (resolved.body.when) {
      if (!evaluatePredicate(resolved.body.when as Predicate, predIns)) continue;
    }
    const def = bodyToDef(inputs.bundle.id, resolved.key, resolved.body);
    if (def) return def;
  }
  return null;
}

/** Phase 4: dev introspection. Given a bundle id and the same inputs the
 *  resolver consumes, return the matched variant's resolved key plus a list
 *  of every priority key that was rejected and why. */
export interface ResolverExplanation {
  readonly matched: string | null;
  readonly rejected: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
}

export function explainResolver(
  bundleId: string,
  calendar: CalendarContext,
  weather: string | null,
  worldFlags?: ReadonlySet<string>,
  agentFlags?: ReadonlyMap<string, boolean>,
  friendship?: (npcId: string) => number,
): ResolverExplanation {
  const bundle = getScheduleBundle(bundleId);
  if (!bundle) {
    return { matched: null, rejected: [{ key: "(bundle)", reason: `unknown bundle '${bundleId}'` }] };
  }
  const wf = worldFlags ?? TRUE_PREDICATE_INPUTS.worldFlags;
  const af = agentFlags ?? TRUE_PREDICATE_INPUTS.agentFlags;
  const fs = friendship ?? TRUE_PREDICATE_INPUTS.friendship;
  const predIns: PredicateInputs = {
    calendar,
    weather,
    worldFlags: wf,
    agentFlags: af,
    friendship: fs,
  };
  const rejected: Array<{ key: string; reason: string }> = [];
  const keys = buildPriorityKeys(calendar, weather, wf);
  for (const k of keys) {
    if (!(k in bundle.variants)) {
      rejected.push({ key: k, reason: "no such variant" });
      continue;
    }
    const resolved = resolveAlias(bundle, k);
    if (!resolved) {
      rejected.push({ key: k, reason: "alias chain unresolved" });
      continue;
    }
    if (resolved.body.when) {
      const matched = evaluatePredicate(resolved.body.when as Predicate, predIns);
      if (!matched) {
        rejected.push({ key: k, reason: "when predicate false" });
        continue;
      }
    }
    if (!resolved.body.templates) {
      rejected.push({ key: k, reason: "alias terminal has no templates" });
      continue;
    }
    return { matched: resolved.key, rejected };
  }
  return { matched: null, rejected };
}

/** Phase 1: helper for callers that have an archetype id and want a variant
 *  resolved in one call. Returns null if the bundle is missing or the
 *  resolver could not match (no `default` defined). */
export function resolveScheduleByArchetype(
  scheduleId: string,
  inputs: Omit<ScheduleResolverInputs, "bundle">,
): ResolvedScheduleDef | null {
  const bundle = getScheduleBundle(scheduleId);
  if (!bundle) return null;
  return resolveScheduleVariant({ bundle, ...inputs });
}

// Re-export for test scaffolding.
export type { ScheduleBundle, ScheduleConstraints, ScheduleTemplate, ScheduleVariantBody };
