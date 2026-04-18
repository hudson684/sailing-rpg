/**
 * Generic id→definition registry. Wraps a loaded collection (from JSON or
 * inline data) with typed lookup + listing. Each content system (items,
 * npcs, equipment, jobs, quests…) creates one of these so consumers don't
 * re-implement the same boilerplate.
 *
 * Intentionally minimal — no async loading, no Zod (callers Zod-parse the
 * raw data before registering if they want validation). HMR preservation
 * is the caller's responsibility (import.meta.hot).
 */

export interface Registry<T extends { id: string }> {
  get(id: string): T;
  tryGet(id: string): T | undefined;
  has(id: string): boolean;
  all(): ReadonlyArray<T>;
  ids(): ReadonlyArray<string>;
  /** Replace the entire contents. Useful for HMR reloads + dev editors. */
  replace(defs: ReadonlyArray<T>): void;
}

export interface CreateRegistryOptions {
  /** Name shown in errors, e.g. "item", "npc". */
  label: string;
}

export function createRegistry<T extends { id: string }>(
  defs: ReadonlyArray<T>,
  opts: CreateRegistryOptions,
): Registry<T> {
  let byId = indexById(defs, opts.label);

  return {
    get(id) {
      const d = byId.get(id);
      if (!d) throw new Error(`Unknown ${opts.label} id: "${id}"`);
      return d;
    },
    tryGet(id) {
      return byId.get(id);
    },
    has(id) {
      return byId.has(id);
    },
    all() {
      return [...byId.values()];
    },
    ids() {
      return [...byId.keys()];
    },
    replace(next) {
      byId = indexById(next, opts.label);
    },
  };
}

function indexById<T extends { id: string }>(
  defs: ReadonlyArray<T>,
  label: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const d of defs) {
    if (map.has(d.id)) {
      throw new Error(`Duplicate ${label} id: "${d.id}"`);
    }
    map.set(d.id, d);
  }
  return map;
}
