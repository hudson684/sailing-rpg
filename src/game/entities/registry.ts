import * as Phaser from "phaser";
import { mapIdKey, type MapId, type MapIdKey } from "./mapId";

export type EntityId = string;
export type EntityKind = "npc" | "enemy" | "player";

/** Base shape for the global entity model. Concrete model types (NpcModel,
 *  EnemyModel, PlayerModel) extend this with kind-specific state. */
export interface EntityModel {
  id: EntityId;
  kind: EntityKind;
  mapId: MapId;
  x: number;
  y: number;
}

type RegistryEvents = {
  added: (model: EntityModel) => void;
  removed: (model: EntityModel) => void;
  mapChanged: (model: EntityModel, prev: MapId) => void;
};

class RegistryEmitter extends Phaser.Events.EventEmitter {
  emitTyped<K extends keyof RegistryEvents>(
    event: K,
    ...args: Parameters<RegistryEvents[K]>
  ): boolean {
    return this.emit(event, ...args);
  }
  onTyped<K extends keyof RegistryEvents>(event: K, fn: RegistryEvents[K]): this {
    return this.on(event, fn as (...args: unknown[]) => void);
  }
  offTyped<K extends keyof RegistryEvents>(event: K, fn: RegistryEvents[K]): this {
    return this.off(event, fn as (...args: unknown[]) => void);
  }
}

/** Global registry of long-lived entity models. Sprites are scene-local and
 *  subscribe to these events via SpriteReconciler (added later). */
class EntityRegistry {
  private byId = new Map<EntityId, EntityModel>();
  private byMap = new Map<MapIdKey, Set<EntityId>>();
  readonly events = new RegistryEmitter();

  add(model: EntityModel): void {
    if (this.byId.has(model.id)) {
      throw new Error(`EntityRegistry: duplicate id ${model.id}`);
    }
    this.byId.set(model.id, model);
    this.indexAdd(mapIdKey(model.mapId), model.id);
    this.events.emitTyped("added", model);
  }

  remove(id: EntityId): void {
    const model = this.byId.get(id);
    if (!model) return;
    this.byId.delete(id);
    this.indexRemove(mapIdKey(model.mapId), id);
    this.events.emitTyped("removed", model);
  }

  get(id: EntityId): EntityModel | undefined {
    return this.byId.get(id);
  }

  setMap(id: EntityId, next: MapId): void {
    const model = this.byId.get(id);
    if (!model) return;
    const prev = model.mapId;
    if (mapIdKey(prev) === mapIdKey(next)) return;
    this.indexRemove(mapIdKey(prev), id);
    model.mapId = next;
    this.indexAdd(mapIdKey(next), id);
    this.events.emitTyped("mapChanged", model, prev);
  }

  *getByMap(mapId: MapId): Iterable<EntityModel> {
    const ids = this.byMap.get(mapIdKey(mapId));
    if (!ids) return;
    for (const id of ids) {
      const m = this.byId.get(id);
      if (m) yield m;
    }
  }

  *all(): Iterable<EntityModel> {
    yield* this.byId.values();
  }

  /** Test-only. Clears all entities and listeners. */
  _reset(): void {
    this.byId.clear();
    this.byMap.clear();
    this.events.removeAllListeners();
  }

  private indexAdd(key: MapIdKey, id: EntityId) {
    let set = this.byMap.get(key);
    if (!set) {
      set = new Set();
      this.byMap.set(key, set);
    }
    set.add(id);
  }

  private indexRemove(key: MapIdKey, id: EntityId) {
    const set = this.byMap.get(key);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.byMap.delete(key);
  }
}

export const entityRegistry = new EntityRegistry();
