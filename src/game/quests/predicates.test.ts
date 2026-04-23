import { describe, it, expect } from "vitest";
import { evaluate, type PredicateContext } from "./predicates";
import type { Predicate, QuestEventEnvelope } from "./types";

function makeCtx(partial: Partial<PredicateContext> = {}): PredicateContext {
  const flags = new Map<string, string | number | boolean>();
  return {
    flags: { get: (k) => flags.get(k) },
    hasItem: () => false,
    jobLevel: () => 0,
    activeMapId: () => "world",
    isQuestStatus: () => false,
    stepStatus: () => "notEntered",
    ...partial,
    // Expose the backing map so individual tests can prepopulate.
    _flags: flags,
  } as PredicateContext & { _flags: Map<string, string | number | boolean> };
}

function ev(
  name: QuestEventEnvelope["name"],
  payload: Record<string, unknown> = {},
): QuestEventEnvelope {
  return { name, payload };
}

describe("evaluate", () => {
  it("flag: truthy / equals / exists", () => {
    const ctx = makeCtx();
    (ctx as unknown as { _flags: Map<string, boolean> })._flags.set("a", true);
    expect(evaluate({ kind: "flag", key: "a" }, ctx)).toBe(true);
    expect(evaluate({ kind: "flag", key: "b" }, ctx)).toBe(false);
    expect(
      evaluate({ kind: "flag", key: "a", equals: true }, ctx),
    ).toBe(true);
    expect(
      evaluate({ kind: "flag", key: "a", equals: false }, ctx),
    ).toBe(false);
    expect(evaluate({ kind: "flag", key: "a", exists: true }, ctx)).toBe(true);
    expect(evaluate({ kind: "flag", key: "b", exists: false }, ctx)).toBe(true);
  });

  it("event kind requires a matching envelope", () => {
    const ctx = makeCtx();
    const p: Predicate = { kind: "event", event: "combat:enemyKilled" };
    expect(evaluate(p, ctx)).toBe(false);
    expect(evaluate(p, ctx, ev("combat:enemyKilled"))).toBe(true);
    expect(evaluate(p, ctx, ev("fishing:caught"))).toBe(false);
  });

  it("event match: field equality + minQuantity", () => {
    const ctx = makeCtx();
    const p: Predicate = {
      kind: "event",
      event: "combat:enemyKilled",
      match: { enemyDefId: "pirate" },
    };
    expect(
      evaluate(p, ctx, ev("combat:enemyKilled", { enemyDefId: "pirate" })),
    ).toBe(true);
    expect(
      evaluate(p, ctx, ev("combat:enemyKilled", { enemyDefId: "goblin" })),
    ).toBe(false);

    const q: Predicate = {
      kind: "event",
      event: "gathering:nodeHarvested",
      match: { nodeDefId: "tree", minQuantity: 5 },
    };
    expect(
      evaluate(
        q,
        ctx,
        ev("gathering:nodeHarvested", { nodeDefId: "tree", quantity: 5 }),
      ),
    ).toBe(true);
    expect(
      evaluate(
        q,
        ctx,
        ev("gathering:nodeHarvested", { nodeDefId: "tree", quantity: 4 }),
      ),
    ).toBe(false);
  });

  it("event match: tile radius", () => {
    const ctx = makeCtx();
    const p: Predicate = {
      kind: "event",
      event: "player:tileEntered",
      match: { tile: { map: "world", x: 10, y: 10, radius: 2 } },
    };
    expect(
      evaluate(p, ctx, ev("player:tileEntered", { mapId: "world", tileX: 11, tileY: 10 })),
    ).toBe(true);
    expect(
      evaluate(p, ctx, ev("player:tileEntered", { mapId: "world", tileX: 13, tileY: 10 })),
    ).toBe(false);
    expect(
      evaluate(p, ctx, ev("player:tileEntered", { mapId: "interior", tileX: 10, tileY: 10 })),
    ).toBe(false);
  });

  it("hasItem + jobLevel + sceneMap", () => {
    const ctx = makeCtx({
      hasItem: (id, min) => id === "wood_log" && min <= 5,
      jobLevel: (j) => (j === "lumberjack" ? 3 : 0),
      activeMapId: () => "town",
    });
    expect(evaluate({ kind: "hasItem", itemId: "wood_log", min: 5 }, ctx)).toBe(true);
    expect(evaluate({ kind: "hasItem", itemId: "wood_log", min: 6 }, ctx)).toBe(false);
    expect(evaluate({ kind: "jobLevel", jobId: "lumberjack", min: 3 }, ctx)).toBe(true);
    expect(evaluate({ kind: "jobLevel", jobId: "lumberjack", min: 4 }, ctx)).toBe(false);
    expect(evaluate({ kind: "sceneMap", mapId: "town" }, ctx)).toBe(true);
    expect(evaluate({ kind: "sceneMap", mapId: "world" }, ctx)).toBe(false);
  });

  it("quest + step status", () => {
    const ctx = makeCtx({
      isQuestStatus: (id, s) => id === "q1" && s === "active",
      stepStatus: (q, step) =>
        q === "q1" && step === "s1" ? "entered" : "notEntered",
    });
    expect(evaluate({ kind: "quest", questId: "q1", status: "active" }, ctx)).toBe(true);
    expect(evaluate({ kind: "quest", questId: "q1", status: "completed" }, ctx)).toBe(false);
    expect(
      evaluate({ kind: "step", questId: "q1", stepId: "s1", status: "entered" }, ctx),
    ).toBe(true);
    expect(
      evaluate({ kind: "step", questId: "q1", stepId: "s1", status: "completed" }, ctx),
    ).toBe(false);
  });

  it("and / or / not", () => {
    const ctx = makeCtx();
    const T: Predicate = { kind: "flag", key: "x", exists: false };
    const F: Predicate = { kind: "flag", key: "x", exists: true };
    expect(evaluate({ kind: "and", all: [T, T] }, ctx)).toBe(true);
    expect(evaluate({ kind: "and", all: [T, F] }, ctx)).toBe(false);
    expect(evaluate({ kind: "or", any: [F, T] }, ctx)).toBe(true);
    expect(evaluate({ kind: "or", any: [F, F] }, ctx)).toBe(false);
    expect(evaluate({ kind: "not", predicate: F }, ctx)).toBe(true);
    expect(evaluate({ kind: "not", predicate: T }, ctx)).toBe(false);
  });
});
