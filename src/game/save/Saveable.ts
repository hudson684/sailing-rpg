import type { ZodType } from "zod";
import type { SystemBlock } from "./envelope";

/**
 * A system that can be persisted. Each system owns its own version + schema,
 * so migrations are local and a data-shape bump in one system doesn't force
 * every other to re-emit. Registered with SaveManager by a stable id.
 */
export interface Saveable<T = unknown> {
  readonly id: string;
  readonly version: number;
  readonly schema: ZodType<T>;
  serialize(): T;
  hydrate(data: T): void;
  /** Per-version migrations: { 1: (v1) => v2, 2: (v2) => v3 } */
  readonly migrations?: Record<number, (from: unknown) => unknown>;
}

/** Run any migrations needed to bring `block` up to `target.version`. */
export function migrateTo<T>(block: SystemBlock, target: Saveable<T>): unknown {
  let { version, data } = block;
  if (version > target.version) {
    throw new Error(
      `Save for '${target.id}' is v${version} but code is v${target.version} — did you downgrade the game?`,
    );
  }
  while (version < target.version) {
    const step = target.migrations?.[version];
    if (!step) {
      throw new Error(
        `No migration from v${version}→v${version + 1} for system '${target.id}'.`,
      );
    }
    data = step(data);
    version += 1;
  }
  return data;
}
