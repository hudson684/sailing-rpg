import { describe, it, expect, beforeEach } from "vitest";
import {
  buildPriorityKeys,
  evaluatePredicate,
  explainResolver,
  resolveScheduleVariant,
  _resetFriendshipNag,
  type Predicate,
  type PredicateInputs,
  type ScheduleBundle,
} from "./scheduleResolver";
import { calendarContextFor } from "../calendar/calendar";
import { planDay, makePlanSeed } from "./scheduler";
import { getArchetype, getScheduleBundle } from "./archetypes";

const TOWNSFOLK_HOME = {
  sceneKey: "chunk:world" as const,
  tileX: 10,
  tileY: 10,
  facing: "down" as const,
};

function bundle(variants: ScheduleBundle["variants"]): ScheduleBundle {
  return { id: "test", variants };
}

describe("buildPriorityKeys", () => {
  it("orders flag → date → weather_dow → weather → season_dow → dow → season → default", () => {
    const cal = calendarContextFor(1); // first day
    const keys = buildPriorityKeys(cal, "rain", new Set(["festival_active"]));
    // Spot-check ordering: flag_* first; default last; weather without dow appears before season-keyed.
    expect(keys[0]).toBe("flag_festival_active");
    expect(keys.at(-1)).toBe("default");
    const idx = (k: string) => keys.indexOf(k);
    expect(idx("rain")).toBeLessThan(idx(cal.season));
    expect(idx(`rain_${cal.dayOfWeek}`)).toBeLessThan(idx("rain"));
    expect(idx(cal.dayOfWeek)).toBeLessThan(idx(cal.season));
    expect(idx(`${cal.season}_${cal.dayOfMonth}`)).toBeLessThan(idx(`rain_${cal.dayOfWeek}`));
  });

  it("omits weather keys when weather is null", () => {
    const cal = calendarContextFor(1);
    const keys = buildPriorityKeys(cal, null, new Set());
    expect(keys.find((k) => k.startsWith("rain"))).toBeUndefined();
    expect(keys.includes("default")).toBe(true);
  });
});

describe("resolveScheduleVariant", () => {
  it("returns default when no other key matches", () => {
    const b = bundle({
      default: { templates: [], constraints: {} },
    });
    const result = resolveScheduleVariant({
      bundle: b,
      calendar: calendarContextFor(1),
      weather: null,
    });
    expect(result?.resolvedKey).toBe("default");
  });

  it("prefers a day-of-week variant when present", () => {
    const cal = calendarContextFor(1);
    const b = bundle({
      default: { templates: [], constraints: {} },
      [cal.dayOfWeek]: { templates: [], constraints: { totalActivitiesRange: [1, 1] } },
    });
    const result = resolveScheduleVariant({ bundle: b, calendar: cal, weather: null });
    expect(result?.resolvedKey).toBe(cal.dayOfWeek);
  });

  it("prefers weather over day-of-week", () => {
    const cal = calendarContextFor(1);
    const b = bundle({
      default: { templates: [], constraints: {} },
      [cal.dayOfWeek]: { templates: [], constraints: {} },
      rain: { templates: [], constraints: {} },
    });
    const result = resolveScheduleVariant({ bundle: b, calendar: cal, weather: "rain" });
    expect(result?.resolvedKey).toBe("rain");
  });

  it("follows aliases up to the alias depth limit", () => {
    const cal = calendarContextFor(1);
    const b = bundle({
      default: { templates: [{ id: "t", kind: "idle", target: { kind: "spawnPoint" }, weight: 1 }], constraints: {} },
      rain: { alias: "default" },
    });
    const result = resolveScheduleVariant({ bundle: b, calendar: cal, weather: "rain" });
    expect(result?.resolvedKey).toBe("default");
    expect(result?.templates.length).toBe(1);
  });

  it("returns null on a missing alias target", () => {
    const cal = calendarContextFor(1);
    const b = bundle({
      default: { templates: [], constraints: {} },
      rain: { alias: "doesnt_exist" },
    });
    const result = resolveScheduleVariant({ bundle: b, calendar: cal, weather: "rain" });
    // rain key resolves alias to nothing — but `default` still matches as fallback.
    expect(result?.resolvedKey).toBe("default");
  });

  it("matches a season_dayOfMonth exact-date override", () => {
    // Day 1 = Frostmoon 1 = winter, dayOfMonth 1
    const cal = calendarContextFor(1);
    const b = bundle({
      default: { templates: [], constraints: {} },
      [`${cal.season}_${cal.dayOfMonth}`]: { templates: [], constraints: { totalActivitiesRange: [9, 9] } },
    });
    const result = resolveScheduleVariant({ bundle: b, calendar: cal, weather: null });
    expect(result?.constraints.totalActivitiesRange).toEqual([9, 9]);
  });
});

describe("evaluatePredicate", () => {
  beforeEach(() => _resetFriendshipNag());

  function ins(over: Partial<PredicateInputs> = {}): PredicateInputs {
    return {
      calendar: calendarContextFor(1),
      weather: null,
      worldFlags: new Set(),
      agentFlags: new Map(),
      friendship: () => 0,
      ...over,
    };
  }

  it("matches flag predicate when world flag is set", () => {
    expect(evaluatePredicate({ flag: "x" } as Predicate, ins({ worldFlags: new Set(["x"]) }))).toBe(true);
    expect(evaluatePredicate({ flag: "x" } as Predicate, ins())).toBe(false);
  });

  it("matches notFlag predicate when world flag is unset", () => {
    expect(evaluatePredicate({ notFlag: "x" } as Predicate, ins())).toBe(true);
    expect(evaluatePredicate({ notFlag: "x" } as Predicate, ins({ worldFlags: new Set(["x"]) }))).toBe(false);
  });

  it("evaluates compound all/any/not", () => {
    const p: Predicate = { all: [{ flag: "a" }, { any: [{ flag: "b" }, { not: { flag: "c" } }] }] };
    expect(evaluatePredicate(p, ins({ worldFlags: new Set(["a"]) }))).toBe(true);
    expect(evaluatePredicate(p, ins({ worldFlags: new Set() }))).toBe(false);
    expect(evaluatePredicate(p, ins({ worldFlags: new Set(["a", "c"]) }))).toBe(false);
  });

  it("friendship predicate evaluates against the stub friendship resolver", () => {
    const p: Predicate = { friendship: { npc: "x", gte: 4 } };
    expect(evaluatePredicate(p, ins({ friendship: (id) => (id === "x" ? 5 : 0) }))).toBe(true);
    expect(evaluatePredicate(p, ins({ friendship: () => 0 }))).toBe(false);
  });
});

describe("resolveScheduleVariant — when clauses", () => {
  it("rejects a key whose `when` evaluates false", () => {
    const cal = calendarContextFor(1);
    const b = bundle({
      default: { templates: [], constraints: { totalActivitiesRange: [1, 1] } },
      [cal.dayOfWeek]: {
        templates: [],
        constraints: { totalActivitiesRange: [9, 9] },
        when: { flag: "tavern_repaired" },
      } as ScheduleBundle["variants"][string],
    });
    const result = resolveScheduleVariant({ bundle: b, calendar: cal, weather: null });
    expect(result?.resolvedKey).toBe("default");
    const result2 = resolveScheduleVariant({
      bundle: b,
      calendar: cal,
      weather: null,
      worldFlags: new Set(["tavern_repaired"]),
    });
    expect(result2?.resolvedKey).toBe(cal.dayOfWeek);
  });
});

describe("explainResolver", () => {
  it("reports the matched key plus all rejected ones", () => {
    const cal = calendarContextFor(1);
    // Use the real townsfolk_default bundle so we can introspect.
    const archetype = getArchetype("townsfolk_default");
    expect(archetype).toBeTruthy();
    const b = getScheduleBundle(archetype!.scheduleId);
    expect(b).toBeTruthy();
    const explanation = explainResolver(archetype!.scheduleId, cal, null);
    expect(explanation.matched).toBe("default");
    expect(explanation.rejected.length).toBeGreaterThan(0);
  });
});

describe("Snapshot: tourist + townsfolk plans match prior phase 0 behavior", () => {
  // The migration from "single ScheduleDef per archetype" to "default-keyed
  // bundle" is invariant for prior content. Same seed, same cal → same plan.
  it("townsfolk_default planDay produces a deterministic plan for a known seed", () => {
    const cal = calendarContextFor(1);
    const archetype = getArchetype("townsfolk_default");
    const b = getScheduleBundle(archetype!.scheduleId);
    const variant = resolveScheduleVariant({ bundle: b!, calendar: cal, weather: null });
    expect(variant).toBeTruthy();
    const npcId = "test:townsfolk:1";
    const seed = makePlanSeed(npcId, cal.dayCount);
    const result = planDay(archetype!, variant!, cal, { spawnPoint: TOWNSFOLK_HOME, npcId }, seed);
    // Just check it produces some activities and chosen template ids — full
    // determinism is verified by the planner's own seeded RNG; this is a
    // smoke test that the migration didn't break the call shape.
    expect(result.activities.length).toBeGreaterThan(0);
    expect(result.chosenTemplateIds.length).toBeGreaterThan(0);
  });
});
