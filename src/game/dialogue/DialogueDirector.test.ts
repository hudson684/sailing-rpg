import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DialogueDirector } from "./DialogueDirector";
import { bus, type DialogueState } from "../bus";
import { RewardRunner } from "../quests/rewards";
import { FlagStore } from "../flags/FlagStore";
import type { PredicateContext } from "../quests/predicates";
import type { DialogueTree } from "./types";

function ctxFrom(flags: FlagStore): PredicateContext {
  return {
    flags: { get: (k) => flags.get(k) },
    hasItem: () => false,
    jobLevel: () => 0,
    activeMapId: () => "world",
    isQuestStatus: () => false,
    stepStatus: () => "notEntered",
  };
}

describe("DialogueDirector", () => {
  let flags: FlagStore;
  let dd: DialogueDirector;
  let lastUpdate: DialogueState | null;
  let endEvents: Array<{ treeId: string; endNodeId: string | null }>;
  const handler = (s: DialogueState) => {
    lastUpdate = s;
  };
  const endHandler = (p: { treeId: string; endNodeId: string | null }) =>
    endEvents.push(p);

  beforeEach(() => {
    flags = new FlagStore();
    const ctx = ctxFrom(flags);
    const rewards = new RewardRunner({
      flags,
      startQuest: () => {},
      unlockQuest: () => {},
      completeQuest: () => {},
    });
    dd = new DialogueDirector({ ctx, rewards });
    lastUpdate = null;
    endEvents = [];
    bus.onTyped("dialogue:update", handler);
    bus.onTyped("dialogue:ended", endHandler);
  });

  afterEach(() => {
    bus.offTyped("dialogue:update", handler);
    bus.offTyped("dialogue:ended", endHandler);
  });

  it("plays a linear tree end-to-end via auto", async () => {
    const tree: DialogueTree = {
      id: "t",
      entry: "n1",
      nodes: {
        n1: { id: "n1", speaker: "A", pages: ["hi"], auto: "n2" },
        n2: { id: "n2", speaker: "B", pages: ["bye"], auto: null },
      },
    };
    dd.register([tree]);
    const pending = dd.play("t");
    // Advance through n1, then let the microtask queue drain so the
    // loop wires up the n2 resolver before we dispatch the next action.
    bus.emitTyped("dialogue:action", { type: "advance" });
    await Promise.resolve();
    await Promise.resolve();
    bus.emitTyped("dialogue:action", { type: "advance" });
    const out = await pending;
    expect(out.endNodeId).toBe("n2");
    expect(endEvents).toEqual([{ treeId: "t", endNodeId: "n2" }]);
  });

  it("respects choice predicate gate", async () => {
    const tree: DialogueTree = {
      id: "t",
      entry: "n1",
      nodes: {
        n1: {
          id: "n1",
          speaker: "A",
          pages: ["?"],
          choices: [
            {
              label: "rich path",
              when: { kind: "flag", key: "rich", equals: true },
              goto: null,
            },
            { label: "poor path", goto: null },
          ],
        },
      },
    };
    dd.register([tree]);
    const pending = dd.play("t");
    // On the only (last) page: update should show ONE choice only.
    expect(lastUpdate?.choices?.length).toBe(1);
    expect(lastUpdate?.choices?.[0].label).toBe("poor path");
    bus.emitTyped("dialogue:action", { type: "select", index: 0 });
    await pending;

    // Now with the flag set.
    flags.set("rich", true);
    const pending2 = dd.play("t");
    expect(lastUpdate?.choices?.length).toBe(2);
    bus.emitTyped("dialogue:action", { type: "select", index: 0 });
    await pending2;
  });

  it("runs onEnter and onPick rewards", async () => {
    const tree: DialogueTree = {
      id: "t",
      entry: "n1",
      nodes: {
        n1: {
          id: "n1",
          speaker: "A",
          pages: ["hi"],
          onEnter: [{ kind: "setFlag", key: "entered", value: true }],
          choices: [
            {
              label: "ok",
              onPick: [{ kind: "setFlag", key: "picked", value: true }],
              goto: null,
            },
          ],
        },
      },
    };
    dd.register([tree]);
    const pending = dd.play("t");
    expect(flags.get("entered")).toBe(true);
    bus.emitTyped("dialogue:action", { type: "select", index: 0 });
    await pending;
    expect(flags.get("picked")).toBe(true);
  });
});
