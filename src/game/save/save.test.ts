import { describe, it, expect, beforeEach } from "vitest";
import {
  addToSlots,
  emptySlots,
  hydrateSlots,
} from "../inventory/operations";
import { useGameStore } from "../store/gameStore";
import { GroundItemsState } from "../world/groundItemsState";
import { SceneState } from "./sceneState";
import {
  inventorySaveable,
  groundItemsSaveable,
  sceneSaveable,
} from "./systems";
import { SaveManager } from "./SaveManager";
import { ENVELOPE_VERSION, SaveEnvelopeSchema, type SaveEnvelope } from "./envelope";
import type { SaveStore } from "./store/SaveStore";
import type { Saveable } from "./Saveable";
import { z } from "zod";

class MemStore implements SaveStore {
  private map = new Map<string, SaveEnvelope>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, env: SaveEnvelope) {
    this.map.set(key, structuredClone(env));
  }
  async list() {
    return [...this.map.values()];
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

beforeEach(() => {
  useGameStore.getState().inventoryReset();
});

describe("Inventory operations", () => {
  it("addToSlots → hydrateSlots preserves slot contents", () => {
    let slots: ReadonlyArray<import("../inventory/types").Slot | null> = emptySlots();
    slots = addToSlots(slots, "rope", 10).slots;
    slots = addToSlots(slots, "plank", 3).slots;
    slots = addToSlots(slots, "compass", 1).slots;
    const rehydrated = hydrateSlots(slots);
    expect(rehydrated).toEqual(slots);
  });
});

describe("Saveable round-trip", () => {
  it("GroundItemsState round-trip is stable and sorted", () => {
    const a = new GroundItemsState();
    a.markPickedUp("z-last");
    a.markPickedUp("a-first");
    a.markPickedUp("m-mid");
    const snap = a.serialize();
    expect(snap).toEqual(["a-first", "m-mid", "z-last"]);

    const b = new GroundItemsState();
    b.hydrate(snap);
    expect(b.serialize()).toEqual(snap);
    expect(b.isPickedUp("m-mid")).toBe(true);
    expect(b.isPickedUp("nope")).toBe(false);
  });

  it("SceneState round-trip preserves mode", () => {
    const a = new SceneState();
    a.mode = "AtHelm";
    const snap = a.serialize();

    const b = new SceneState();
    b.hydrate(snap);
    expect(b.mode).toBe("AtHelm");
  });
});

describe("Saveable schemas reject bad data", () => {
  it("inventorySaveable schema rejects unknown item id", () => {
    const sv = inventorySaveable();
    const bad = [{ itemId: "laser", quantity: 1 }, ...new Array(27).fill(null)];
    expect(sv.schema.safeParse(bad).success).toBe(false);
  });

  it("inventorySaveable schema rejects non-positive quantity", () => {
    const sv = inventorySaveable();
    const bad = [{ itemId: "rope", quantity: 0 }, ...new Array(27).fill(null)];
    expect(sv.schema.safeParse(bad).success).toBe(false);
  });
});

describe("SaveManager", () => {
  function makeManager() {
    const ground = new GroundItemsState();
    const scene = new SceneState();
    const store = new MemStore();
    const mgr = new SaveManager({
      store,
      playerId: "p1",
      gameVersion: "0.0.1-test",
      getSceneKey: () => "world:5,5",
      getPlaytimeMs: () => 12_345,
    });
    mgr.register(inventorySaveable());
    mgr.register(groundItemsSaveable(ground));
    mgr.register(sceneSaveable(scene));
    return { mgr, ground, scene, store };
  }

  it("save builds a schema-valid envelope and round-trips through load", async () => {
    const { mgr, ground, scene } = makeManager();
    useGameStore.getState().inventoryAdd("fish", 5);
    ground.markPickedUp("uid-1");
    scene.mode = "AtHelm";

    const env = await mgr.save("slot1");
    expect(SaveEnvelopeSchema.safeParse(env).success).toBe(true);
    expect(env.schemaVersion).toBe(ENVELOPE_VERSION);
    expect(env.sceneKey).toBe("world:5,5");
    expect(env.playtimeMs).toBe(12_345);
    expect(env.systems.inventory.version).toBe(1);
    expect(env.systems.scene.data).toEqual({ mode: "AtHelm" });

    useGameStore.getState().inventoryReset();
    ground.reset();
    scene.mode = "OnFoot";

    const loaded = await mgr.load("slot1");
    expect(loaded).not.toBeNull();
    const slots = useGameStore.getState().inventory.slots;
    expect(slots.find((s) => s?.itemId === "fish")?.quantity).toBe(5);
    expect(ground.isPickedUp("uid-1")).toBe(true);
    expect(scene.mode).toBe("AtHelm");
  });

  it("load returns null for an empty slot", async () => {
    const { mgr } = makeManager();
    expect(await mgr.load("slot2")).toBeNull();
  });

  it("hydrate preserves fresh state for systems absent from the save", async () => {
    const { mgr } = makeManager();
    useGameStore.getState().inventoryAdd("rope", 7);
    const env = await mgr.save("autosave");

    // Manually drop inventory from the envelope to simulate a save made before
    // the system existed; hydrateFrom should skip it and retain current state.
    const trimmed = structuredClone(env);
    delete (trimmed.systems as Record<string, unknown>).inventory;

    useGameStore.getState().inventoryReset();
    useGameStore.getState().inventoryAdd("plank", 2);
    mgr.hydrateFrom(trimmed);
    const slots = useGameStore.getState().inventory.slots;
    expect(slots.find((s) => s?.itemId === "plank")?.quantity).toBe(2);
    expect(slots.find((s) => s?.itemId === "rope")).toBeUndefined();
  });

  it("hydrate ignores unknown systems in the save envelope", async () => {
    const { mgr } = makeManager();
    const env = await mgr.save("autosave");
    const mutated = structuredClone(env);
    mutated.systems.futureFeature = { version: 42, data: { whatever: true } };
    expect(() => mgr.hydrateFrom(mutated)).not.toThrow();
  });

  it("delete removes the slot from the store", async () => {
    const { mgr, store } = makeManager();
    await mgr.save("slot3");
    expect(await store.get("save:slot3")).not.toBeNull();
    await mgr.delete("slot3");
    expect(await store.get("save:slot3")).toBeNull();
  });

  it("migrateTo runs per-system migrations up to current version", async () => {
    type V1 = { score: number };
    type V2 = { score: number; bonus: number };
    let current: V2 = { score: 10, bonus: 3 };
    const sv: Saveable<V2> = {
      id: "demo",
      version: 2,
      schema: z.object({ score: z.number(), bonus: z.number() }),
      serialize: () => current,
      hydrate: (d) => {
        current = d;
      },
      migrations: {
        1: (from) => ({ ...(from as V1), bonus: 0 }),
      },
    };

    const store = new MemStore();
    const mgr = new SaveManager({
      store,
      playerId: "p1",
      gameVersion: "0.0.1-test",
      getSceneKey: () => "x",
      getPlaytimeMs: () => 0,
    });
    mgr.register(sv);

    const env = await mgr.save("slot1");
    env.systems.demo = { version: 1, data: { score: 99 } };
    mgr.hydrateFrom(env);
    expect(current).toEqual({ score: 99, bonus: 0 });
  });
});
