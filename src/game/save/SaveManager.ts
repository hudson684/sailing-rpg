import { ENVELOPE_VERSION, slotKey, type SaveEnvelope, type SlotId } from "./envelope";
import type { Saveable } from "./Saveable";
import { migrateTo } from "./Saveable";
import { uuid } from "./playerId";
import type { SaveStore } from "./store/SaveStore";

export interface SaveManagerOptions {
  store: SaveStore;
  playerId: string;
  gameVersion: string;
  /** Returns current scene key, for display + for deciding where to spawn on load. */
  getSceneKey: () => string;
  /** Returns current playtime (ms) tracked elsewhere. */
  getPlaytimeMs: () => number;
  /** Optional callback: something about the save list changed (wrote/deleted). */
  onChange?: () => void;
}

/**
 * Registers Saveable systems, fans out serialize/hydrate, and writes envelopes
 * through a SaveStore. Each system keeps its own version; the envelope version
 * tracks only envelope-shape changes, not per-system data.
 */
export class SaveManager {
  private readonly systems = new Map<string, Saveable>();
  private readonly store: SaveStore;
  private readonly opts: SaveManagerOptions;

  constructor(opts: SaveManagerOptions) {
    this.opts = opts;
    this.store = opts.store;
  }

  register<T>(system: Saveable<T>): void {
    if (this.systems.has(system.id)) {
      throw new Error(`Saveable '${system.id}' already registered`);
    }
    this.systems.set(system.id, system as Saveable);
  }

  listSystems(): readonly Saveable[] {
    return [...this.systems.values()];
  }

  /** Build an envelope from current runtime state. Pure — does not write. */
  buildEnvelope(slot: SlotId, previous?: SaveEnvelope | null): SaveEnvelope {
    const systems: SaveEnvelope["systems"] = {};
    for (const s of this.systems.values()) {
      systems[s.id] = { version: s.version, data: s.serialize() };
    }
    const now = Date.now();
    return {
      id: uuid(),
      playerId: this.opts.playerId,
      slot,
      schemaVersion: ENVELOPE_VERSION,
      gameVersion: this.opts.gameVersion,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      playtimeMs: this.opts.getPlaytimeMs(),
      sceneKey: this.opts.getSceneKey(),
      systems,
    };
  }

  async save(slot: SlotId): Promise<SaveEnvelope> {
    const previous = await this.store.get(slotKey(slot));
    const env = this.buildEnvelope(slot, previous);
    await this.store.put(slotKey(slot), env);
    this.opts.onChange?.();
    return env;
  }

  /**
   * Load and apply a slot. Missing systems in the save are skipped (fresh
   * state retained). Unknown systems in the save are ignored (future-compat
   * across mismatched builds).
   */
  async load(slot: SlotId): Promise<SaveEnvelope | null> {
    const env = await this.store.get(slotKey(slot));
    if (!env) return null;
    this.hydrateFrom(env);
    return env;
  }

  hydrateFrom(env: SaveEnvelope): void {
    for (const s of this.systems.values()) {
      const block = env.systems[s.id];
      if (!block) continue;
      const migrated = migrateTo(block, s);
      const parsed = s.schema.safeParse(migrated);
      if (!parsed.success) {
        console.error(
          `[save] hydrate failed for '${s.id}' from v${block.version}:`,
          parsed.error.issues,
        );
        continue;
      }
      s.hydrate(parsed.data as never);
    }
  }

  async peek(slot: SlotId): Promise<SaveEnvelope | null> {
    return this.store.get(slotKey(slot));
  }

  async list(): Promise<SaveEnvelope[]> {
    return this.store.list();
  }

  async delete(slot: SlotId): Promise<void> {
    await this.store.delete(slotKey(slot));
    this.opts.onChange?.();
  }
}
