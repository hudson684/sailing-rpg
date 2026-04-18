import { describe, it, expect } from "vitest";
import { Inventory } from "../inventory/Inventory";
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

describe("Saveable round-trip", () => {
  it("Inventory → serialize → hydrate preserves slot contents", () => {
    const a = new Inventory();
    a.add("rope", 10);
    a.add("plank", 3);
    a.add("compass", 1);
    const snap = a.serialize();

    const b = new Inventory();
    b.hydrate(snap);
    expect(b.serialize()).toEqual(snap);
  });

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
    const inv = new Inventory();
    const sv = inventorySaveable(inv);
    const bad = [{ itemId: "laser", quantity: 1 }, ...new Array(27).fill(null)];
    expect(sv.schema.safeParse(bad).success).toBe(false);
  });

  it("inventorySaveable schema rejects non-positive quantity", () => {
    const inv = new Inventory();
    const sv = inventorySaveable(inv);
    const bad = [{ itemId: "rope", quantity: 0 }, ...new Array(27).fill(null)];
    expect(sv.schema.safeParse(bad).success).toBe(false);
  });
});

describe("SaveManager", () => {
  function makeManager() {
    const inv = new Inventory();
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
    mgr.register(inventorySaveable(inv));
    mgr.register(groundItemsSaveable(ground));
    mgr.register(sceneSaveable(scene));
    return { mgr, inv, ground, scene, store };
  }

  it("save builds a schema-valid envelope and round-trips through load", async () => {
    const { mgr, inv, ground, scene } = makeManager();
    inv.add("fish", 5);
    ground.markPickedUp("uid-1");
    scene.mode = "AtHelm";

    const env = await mgr.save("slot1");
    expect(SaveEnvelopeSchema.safeParse(env).success).toBe(true);
    expect(env.schemaVersion).toBe(ENVELOPE_VERSION);
    expect(env.sceneKey).toBe("world:5,5");
    expect(env.playtimeMs).toBe(12_345);
    expect(env.systems.inventory.version).toBe(1);
    expect(env.systems.scene.data).toEqual({ mode: "AtHelm" });

    inv.hydrate(new Array(28).fill(null));
    ground.reset();
    scene.mode = "OnFoot";

    const loaded = await mgr.load("slot1");
    expect(loaded).not.toBeNull();
    expect(inv.serialize().find((s) => s?.itemId === "fish")?.quantity).toBe(5);
    expect(ground.isPickedUp("uid-1")).toBe(true);
    expect(scene.mode).toBe("AtHelm");
  });

  it("load returns null for an empty slot", async () => {
    const { mgr } = makeManager();
    expect(await mgr.load("slot2")).toBeNull();
  });

  it("hydrate preserves fresh state for systems absent from the save", async () => {
    const { mgr, inv } = makeManager();
    inv.add("rope", 7);
    const env = await mgr.save("autosave");

    // Manually drop inventory from the envelope to simulate a save made before
    // the system existed; hydrateFrom should skip it and retain current state.
    const trimmed = structuredClone(env);
    delete (trimmed.systems as Record<string, unknown>).inventory;

    inv.hydrate(new Array(28).fill(null));
    inv.add("plank", 2);
    mgr.hydrateFrom(trimmed);
    // Inventory retained its current contents, not reset from save.
    expect(inv.serialize().find((s) => s?.itemId === "plank")?.quantity).toBe(2);
    expect(inv.serialize().find((s) => s?.itemId === "rope")).toBeUndefined();
  });

  it("hydrate ignores unknown systems in the save envelope", async () => {
    const { mgr } = makeManager();
    const env = await mgr.save("autosave");
    const mutated = structuredClone(env);
    mutated.systems.futureFeature = { version: 42, data: { whatever: true } };
    // Must not throw:
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
    // Simulate a save written by v1:
    env.systems.demo = { version: 1, data: { score: 99 } };
    mgr.hydrateFrom(env);
    expect(current).toEqual({ score: 99, bonus: 0 });
  });
});
