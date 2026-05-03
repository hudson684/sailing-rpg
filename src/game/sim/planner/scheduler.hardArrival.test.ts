import { describe, it, expect } from "vitest";
import { calendarContextFor } from "../calendar/calendar";
import { planDay, makePlanSeed, clearPlanLog, getPlanLog } from "./scheduler";
import { worldAnchors, businessArrivalAnchorKey } from "./anchors";
import type { ArchetypeDef, ScheduleDef } from "./archetypes";
import { GoToActivity } from "../activities/goTo";
import { IdleActivity } from "../activities/idle";

const HOME = {
  sceneKey: "chunk:world" as const,
  tileX: 0,
  tileY: 0,
  facing: "down" as const,
};

const FAR_TARGET = {
  sceneKey: "chunk:world" as const,
  tileX: 30,
  tileY: 0,
  facing: "down" as const,
};

function arch(): ArchetypeDef {
  return {
    id: "test",
    name: "Test",
    spriteSet: "any",
    scheduleId: "test_bundle",
    defaultTraits: {},
  };
}

function schedule(templates: ScheduleDef["templates"], totalActivities = 1): ScheduleDef {
  return {
    id: "test_bundle",
    constraints: { totalActivitiesRange: [totalActivities, totalActivities] },
    templates,
  };
}

describe("Phase 3 hard arrival anchors", () => {
  it("inserts Idle padding before a hard-anchored dwell so it starts at mustStartAt", () => {
    // Set a business arrival anchor that's far enough that walk-time matters.
    worldAnchors.set(businessArrivalAnchorKey("test_shop"), FAR_TARGET);
    clearPlanLog();
    const sched = schedule([
      {
        id: "shop_open",
        kind: "standAround",
        target: { kind: "businessArrival", businessId: "test_shop" },
        weight: 1,
        duration: [10, 10],
        mustStartAt: 540, // 9:00am
      },
    ]);
    const cal = calendarContextFor(1);
    const ctx = { spawnPoint: HOME, npcId: "test:npc:1" };
    const result = planDay(arch(), sched, cal, ctx, makePlanSeed(ctx.npcId, cal.dayCount));
    // Plan should be: [Idle(padding), GoTo, StandAround]
    expect(result.activities.length).toBe(3);
    expect(result.activities[0]).toBeInstanceOf(IdleActivity);
    expect(result.activities[1]).toBeInstanceOf(GoToActivity);
    expect(result.activities[2].kind).toBe("standAround");
    // The GoTo should now have mustArriveBy set.
    const goTo = result.activities[1] as GoToActivity;
    expect(goTo.config.mustArriveBy).toBe(540);
    // Plan log should mention the padding.
    const log = getPlanLog();
    expect(log.some((s) => s.includes("padded") && s.includes("shop_open"))).toBe(true);
  });

  it("with no GoTo (already at the target), pads directly before the dwell", () => {
    worldAnchors.set(businessArrivalAnchorKey("at_home_shop"), HOME);
    clearPlanLog();
    const sched = schedule([
      {
        id: "shop_at_home",
        kind: "standAround",
        target: { kind: "businessArrival", businessId: "at_home_shop" },
        weight: 1,
        duration: [10, 10],
        mustStartAt: 240, // 4:00am
      },
    ]);
    const cal = calendarContextFor(1);
    const ctx = { spawnPoint: HOME, npcId: "test:npc:home" };
    const result = planDay(arch(), sched, cal, ctx, makePlanSeed(ctx.npcId, cal.dayCount));
    // [Idle(padding), StandAround] — no GoTo since cursor already at target.
    expect(result.activities[0]).toBeInstanceOf(IdleActivity);
    expect(result.activities[1].kind).toBe("standAround");
  });

  it("leaves plans without mustStartAt unchanged (no-op anchor pass)", () => {
    worldAnchors.set(businessArrivalAnchorKey("flex_shop"), FAR_TARGET);
    clearPlanLog();
    const sched = schedule([
      {
        id: "browse_no_anchor",
        kind: "standAround",
        target: { kind: "businessArrival", businessId: "flex_shop" },
        weight: 1,
        duration: [10, 10],
      },
    ]);
    const cal = calendarContextFor(1);
    const ctx = { spawnPoint: HOME, npcId: "test:flex:1" };
    const result = planDay(arch(), sched, cal, ctx, makePlanSeed(ctx.npcId, cal.dayCount));
    // [GoTo, StandAround] with no padding — no log entry.
    expect(result.activities.length).toBe(2);
    expect(result.activities[0].kind).toBe("goTo");
    expect(result.activities[1].kind).toBe("standAround");
    expect(getPlanLog()).toEqual([]);
  });

  it("respects determinism — same seed + plan with anchor produces same activities", () => {
    worldAnchors.set(businessArrivalAnchorKey("det_shop"), FAR_TARGET);
    const sched = schedule([
      {
        id: "det_shop",
        kind: "standAround",
        target: { kind: "businessArrival", businessId: "det_shop" },
        weight: 1,
        duration: [10, 10],
        mustStartAt: 540,
      },
    ]);
    const cal = calendarContextFor(1);
    const ctx = { spawnPoint: HOME, npcId: "det:npc:1" };
    const a = planDay(arch(), sched, cal, ctx, 12345);
    const b = planDay(arch(), sched, cal, ctx, 12345);
    expect(a.activities.length).toBe(b.activities.length);
    expect(a.activities.map((act) => act.kind)).toEqual(b.activities.map((act) => act.kind));
  });
});
