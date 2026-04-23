import { describe, it, expect, beforeEach } from "vitest";
import { FlagStore } from "./FlagStore";
import { bus } from "../bus";

describe("FlagStore", () => {
  let store: FlagStore;
  beforeEach(() => {
    store = new FlagStore();
  });

  it("round-trips values", () => {
    store.set("a.b", true);
    store.set("c", 42);
    store.set("d", "hello");
    expect(store.get("a.b")).toBe(true);
    expect(store.get("c")).toBe(42);
    expect(store.get("d")).toBe("hello");
    expect(store.get("missing")).toBeUndefined();
  });

  it("emits flags:changed only on actual change", () => {
    const events: Array<{ key: string; value: unknown; prev: unknown }> = [];
    const handler = (p: { key: string; value: unknown; prev: unknown }) =>
      events.push(p);
    bus.onTyped("flags:changed", handler);
    try {
      store.set("x", 1);
      store.set("x", 1); // no-op
      store.set("x", 2);
      store.clear("x");
      store.clear("x"); // no-op
    } finally {
      bus.offTyped("flags:changed", handler);
    }
    expect(events).toEqual([
      { key: "x", value: 1, prev: undefined },
      { key: "x", value: 2, prev: 1 },
      { key: "x", value: undefined, prev: 2 },
    ]);
  });

  it("serialize / hydrate round-trip", () => {
    store.set("a", true);
    store.set("b", 3);
    const snap = store.serialize();
    const b = new FlagStore();
    b.hydrate(snap);
    expect(b.get("a")).toBe(true);
    expect(b.get("b")).toBe(3);
  });

  it("hydrate does not emit flags:changed", () => {
    const events: unknown[] = [];
    const handler = () => events.push(1);
    bus.onTyped("flags:changed", handler);
    try {
      store.hydrate({ flags: { a: true, b: 2 } });
    } finally {
      bus.offTyped("flags:changed", handler);
    }
    expect(events).toEqual([]);
  });

  it("getBool treats undefined as false", () => {
    expect(store.getBool("missing")).toBe(false);
    store.set("x", false);
    expect(store.getBool("x")).toBe(false);
    store.set("y", true);
    expect(store.getBool("y")).toBe(true);
  });
});
