import { describe, it, expect, beforeEach } from "vitest";
import { QuestManager } from "./QuestManager";
import { FlagStore } from "../flags/FlagStore";
import { bus } from "../bus";
import type { QuestDef } from "./types";
import { useGameStore } from "../store/gameStore";

function fresh(): { qm: QuestManager; flags: FlagStore } {
  useGameStore.getState().inventoryReset();
  useGameStore.getState().jobsReset?.();
  const flags = new FlagStore();
  const qm = new QuestManager({ flags });
  return { qm, flags };
}

describe("QuestManager", () => {
  beforeEach(() => {
    // Tests directly call `dispatch` — no need to bind bus.
  });

  it("starts a quest on matching startWhen event", () => {
    const { qm } = fresh();
    const def: QuestDef = {
      id: "q",
      title: "Q",
      entry: "s1",
      startWhen: {
        kind: "event",
        event: "npc:interacted",
        match: { npcId: "mom" },
      },
      steps: {
        s1: { id: "s1", next: [] },
      },
    };
    qm.register([def]);
    expect(qm.getStatus("q")).toBe("notStarted");
    qm.dispatch({ name: "npc:interacted", payload: { npcId: "other" } });
    expect(qm.getStatus("q")).toBe("notStarted");
    qm.dispatch({ name: "npc:interacted", payload: { npcId: "mom" } });
    // Terminal step with next:[] → auto-completes only if completeWhen
    // is satisfied. No completeWhen → stays on s1. Verify active.
    expect(qm.getStatus("q")).toBe("active");
    expect(qm.getCursor("q")?.stepId).toBe("s1");
  });

  it("advances via completeWhen on a step", () => {
    const { qm } = fresh();
    qm.register([
      {
        id: "q",
        title: "Q",
        entry: "s1",
        steps: {
          s1: {
            id: "s1",
            completeWhen: {
              kind: "event",
              event: "combat:enemyKilled",
              match: { enemyDefId: "pirate" },
            },
            next: [{ goto: "s2" }],
          },
          s2: { id: "s2", next: [] },
        },
      },
    ]);
    qm.forceStart("q");
    expect(qm.getCursor("q")?.stepId).toBe("s1");
    qm.dispatch({
      name: "combat:enemyKilled",
      payload: { enemyDefId: "goblin" },
    });
    expect(qm.getCursor("q")?.stepId).toBe("s1");
    qm.dispatch({
      name: "combat:enemyKilled",
      payload: { enemyDefId: "pirate" },
    });
    expect(qm.getCursor("q")?.stepId).toBe("s2");
  });

  it("branches via edge.when", () => {
    const { qm, flags } = fresh();
    qm.register([
      {
        id: "q",
        title: "Q",
        entry: "s1",
        steps: {
          s1: {
            id: "s1",
            completeWhen: { kind: "event", event: "dialogue:ended" },
            next: [
              {
                when: { kind: "flag", key: "chose.a", equals: true },
                goto: "a",
              },
              { goto: "b" }, // default
            ],
          },
          a: { id: "a", next: [] },
          b: { id: "b", next: [] },
        },
      },
    ]);
    qm.forceStart("q");
    flags.set("chose.a", true);
    qm.dispatch({ name: "dialogue:ended", payload: {} });
    expect(qm.getCursor("q")?.stepId).toBe("a");
  });

  it("subgoals must all satisfy before completing", () => {
    const { qm } = fresh();
    qm.register([
      {
        id: "q",
        title: "Q",
        entry: "s1",
        steps: {
          s1: {
            id: "s1",
            subgoals: [
              {
                id: "talk_mom",
                completeWhen: {
                  kind: "event",
                  event: "npc:interacted",
                  match: { npcId: "mom" },
                },
              },
              {
                id: "talk_dad",
                completeWhen: {
                  kind: "event",
                  event: "npc:interacted",
                  match: { npcId: "dad" },
                },
              },
            ],
            next: [{ goto: "s2" }],
          },
          s2: { id: "s2", next: [] },
        },
      },
    ]);
    qm.forceStart("q");
    qm.dispatch({ name: "npc:interacted", payload: { npcId: "mom" } });
    expect(qm.getCursor("q")?.stepId).toBe("s1");
    expect(qm.getCursor("q")?.subgoals.talk_mom).toBe(true);
    qm.dispatch({ name: "npc:interacted", payload: { npcId: "dad" } });
    expect(qm.getCursor("q")?.stepId).toBe("s2");
  });

  it("rewards: setFlag + grantItem + unlockQuest", () => {
    const { qm, flags } = fresh();
    qm.register([
      {
        id: "q1",
        title: "Q1",
        entry: "s1",
        steps: {
          s1: {
            id: "s1",
            onEnter: [
              { kind: "setFlag", key: "a", value: true },
              { kind: "grantItem", itemId: "rope", quantity: 2 },
              { kind: "unlockQuest", questId: "q2" },
            ],
            next: [],
          },
        },
      },
      {
        id: "q2",
        title: "Q2",
        entry: "s1",
        hidden: true,
        steps: { s1: { id: "s1", next: [] } },
      },
    ]);
    qm.forceStart("q1");
    expect(flags.get("a")).toBe(true);
    const ropeQty = useGameStore
      .getState()
      .inventory.slots.filter((s) => s && s.itemId === "rope")
      .reduce((sum, s) => sum + (s?.quantity ?? 0), 0);
    expect(ropeQty).toBe(2);
    expect(qm.isUnlocked("q2")).toBe(true);
  });

  it("save / hydrate round-trips active cursor", () => {
    const { qm } = fresh();
    const defs: QuestDef[] = [
      {
        id: "q",
        title: "Q",
        entry: "s1",
        steps: {
          s1: {
            id: "s1",
            completeWhen: { kind: "event", event: "npc:interacted" },
            next: [{ goto: "s2" }],
          },
          s2: { id: "s2", next: [] },
        },
      },
    ];
    qm.register(defs);
    qm.forceStart("q");
    qm.dispatch({ name: "npc:interacted", payload: {} });
    expect(qm.getCursor("q")?.stepId).toBe("s2");
    const snap = qm.serialize();

    const { qm: qm2 } = fresh();
    qm2.register(defs);
    qm2.hydrate(snap);
    expect(qm2.getStatus("q")).toBe("active");
    expect(qm2.getCursor("q")?.stepId).toBe("s2");
  });

  it("reconciliation: rewinds cursor if step was removed", () => {
    const { qm } = fresh();
    qm.register([
      {
        id: "q",
        title: "Q",
        entry: "s1",
        steps: {
          s1: { id: "s1", next: [{ goto: "s2" }], completeWhen: { kind: "flag", key: "go" } },
          s2: { id: "s2", next: [] },
        },
      },
    ]);
    const { flags: flags2, qm: qm2 } = fresh();
    void flags2;
    qm2.register([
      {
        id: "q",
        title: "Q",
        entry: "s1",
        steps: {
          // s2 removed entirely.
          s1: { id: "s1", next: [] },
        },
      },
    ]);
    // Hand-craft a saved state pointing at missing s2.
    qm2.hydrate({
      statuses: {
        q: {
          status: "active",
          cursor: {
            questId: "q",
            stepId: "s2",
            subgoals: {},
            startedAt: 0,
            enteredStepAt: 0,
          },
        },
      },
      unlocked: [],
    });
    expect(qm2.getCursor("q")?.stepId).toBe("s1");
  });

  it("register throws on unknown goto", () => {
    const { qm } = fresh();
    expect(() =>
      qm.register([
        {
          id: "q",
          title: "Q",
          entry: "s1",
          steps: {
            s1: { id: "s1", next: [{ goto: "missing" }] },
          },
        },
      ]),
    ).toThrow(/missing/);
  });

  it("emits lifecycle events", () => {
    const { qm } = fresh();
    const calls: string[] = [];
    const started = (p: { questId: string }) => calls.push(`started:${p.questId}`);
    const entered = (p: { questId: string; stepId: string }) =>
      calls.push(`entered:${p.questId}:${p.stepId}`);
    const stepDone = (p: { questId: string; stepId: string }) =>
      calls.push(`stepDone:${p.questId}:${p.stepId}`);
    const done = (p: { questId: string }) => calls.push(`done:${p.questId}`);
    bus.onTyped("quest:started", started);
    bus.onTyped("quest:stepEntered", entered);
    bus.onTyped("quest:stepCompleted", stepDone);
    bus.onTyped("quest:completed", done);
    try {
      qm.register([
        {
          id: "q",
          title: "Q",
          entry: "s1",
          steps: {
            s1: {
              id: "s1",
              completeWhen: { kind: "event", event: "npc:interacted" },
              next: [],
            },
          },
        },
      ]);
      qm.forceStart("q");
      qm.dispatch({ name: "npc:interacted", payload: {} });
    } finally {
      bus.offTyped("quest:started", started);
      bus.offTyped("quest:stepEntered", entered);
      bus.offTyped("quest:stepCompleted", stepDone);
      bus.offTyped("quest:completed", done);
    }
    expect(calls).toEqual([
      "started:q",
      "entered:q:s1",
      "stepDone:q:s1",
      "done:q",
    ]);
  });
});
