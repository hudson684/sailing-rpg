import { z } from "zod";
import type { Saveable } from "../save/Saveable";
import { bus } from "../bus";
import type { FlagKey, FlagValue } from "../quests/types";

export const FlagValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
]);

export const FlagsSaveStateSchema = z.object({
  flags: z.record(z.string(), FlagValueSchema),
});

export type FlagsSaveState = z.infer<typeof FlagsSaveStateSchema>;

/** Namespaced global key/value store for quest + world flags. Keys are
 *  opaque strings — convention is `namespace.subnamespace.name`. Each
 *  write emits `flags:changed` on the bus so QuestManager can
 *  re-evaluate step completion. Framework-free (no Phaser). */
export class FlagStore implements Saveable<FlagsSaveState> {
  readonly id = "flags";
  readonly version = 1;
  readonly schema = FlagsSaveStateSchema;

  private data = new Map<FlagKey, FlagValue>();

  get(key: FlagKey): FlagValue | undefined {
    return this.data.get(key);
  }

  /** Treats undefined/false/0/"" as falsy. */
  getBool(key: FlagKey): boolean {
    return Boolean(this.data.get(key));
  }

  set(key: FlagKey, value: FlagValue): void {
    const prev = this.data.get(key);
    if (prev === value) return;
    this.data.set(key, value);
    bus.emitTyped("flags:changed", { key, value, prev });
  }

  clear(key: FlagKey): void {
    if (!this.data.has(key)) return;
    const prev = this.data.get(key);
    this.data.delete(key);
    bus.emitTyped("flags:changed", { key, value: undefined, prev });
  }

  /** Read-only snapshot for the editor/inspector. Stable order by key. */
  entries(): ReadonlyArray<[FlagKey, FlagValue]> {
    return [...this.data.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  serialize(): FlagsSaveState {
    const flags: Record<string, FlagValue> = {};
    for (const [k, v] of this.data) flags[k] = v;
    return { flags };
  }

  hydrate(data: FlagsSaveState): void {
    this.data.clear();
    for (const [k, v] of Object.entries(data.flags)) this.data.set(k, v);
    // Intentionally do NOT emit flags:changed for every hydrated key —
    // hydration replays save state, not a user-visible transition.
    // QuestManager re-reconciles cursors against current flags on hydrate
    // itself, so the events would be redundant and cause spurious work.
  }
}
