/**
 * Phase 7: flag-gated spawn registry.
 *
 * Each gated spawn entry carries an optional `when` predicate. The
 * registry subscribes to `flags:changed` and toggles entities in and
 * out of the scene as the predicate value flips.
 *
 * Not optimized: on every flag change we re-evaluate every entry on
 * the active map. The plan calls for a flag→spawn index once maps
 * exceed ~100 gated spawns; we're far under that.
 */

import { bus } from "../bus";
import type { Predicate } from "../quests/types";
import { evaluate, type PredicateContext } from "../quests/predicates";

export interface GateableInstance {
  when?: Predicate;
}

export interface SpawnGateRegistryOptions<TInstance extends GateableInstance, TEntity> {
  ctx: PredicateContext;
  /** Builds a live entity from the instance. Called on initial spawn
   *  AND when a predicate flips false → true. Must be safe to call
   *  multiple times across the registry's lifetime. */
  factory: (instance: TInstance) => TEntity | null;
  /** Tear down a live entity (remove from scene / registry / etc). */
  teardown: (entity: TEntity) => void;
}

export class SpawnGateRegistry<TInstance extends GateableInstance, TEntity> {
  private entries: Array<{ instance: TInstance; entity: TEntity | null }> = [];
  private readonly onFlagsChanged = () => this.reevaluate();
  private destroyed = false;

  constructor(private readonly opts: SpawnGateRegistryOptions<TInstance, TEntity>) {
    bus.onTyped("flags:changed", this.onFlagsChanged);
  }

  /** Spawn the initial set. Returns only the entities that are live
   *  (i.e. whose predicate evaluated true or was absent). */
  register(instances: TInstance[]): TEntity[] {
    const live: TEntity[] = [];
    for (const inst of instances) {
      const active = this.shouldSpawn(inst);
      const entity = active ? this.opts.factory(inst) : null;
      if (entity) live.push(entity);
      this.entries.push({ instance: inst, entity });
    }
    return live;
  }

  /** If an entity was removed externally (e.g. despawn on death), the
   *  gating registry should be told so it doesn't try to tear it down
   *  a second time. */
  forget(entity: TEntity): void {
    for (const e of this.entries) {
      if (e.entity === entity) {
        e.entity = null;
        return;
      }
    }
  }

  /** Re-evaluate every entry. Called on `flags:changed` automatically;
   *  also exposed for explicit re-check on `world:mapEntered`. */
  reevaluate(): void {
    if (this.destroyed) return;
    for (const e of this.entries) {
      if (!e.instance.when) continue;
      const active = this.shouldSpawn(e.instance);
      if (active && !e.entity) {
        e.entity = this.opts.factory(e.instance);
      } else if (!active && e.entity) {
        this.opts.teardown(e.entity);
        e.entity = null;
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    bus.offTyped("flags:changed", this.onFlagsChanged);
    for (const e of this.entries) {
      if (e.entity) this.opts.teardown(e.entity);
    }
    this.entries = [];
  }

  private shouldSpawn(inst: TInstance): boolean {
    if (!inst.when) return true;
    try {
      return evaluate(inst.when, this.opts.ctx);
    } catch (err) {
      console.warn("[spawn-gating] predicate eval failed", err);
      return true; // fail open — better to show the entity than hide it silently
    }
  }
}
