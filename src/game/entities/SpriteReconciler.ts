import * as Phaser from "phaser";
import { entityRegistry, type EntityId, type EntityModel } from "./registry";
import { mapIdEquals, type MapId } from "./mapId";

/** Sprite interface the reconciler expects: something with `syncFromModel()`
 *  and `destroy()`. Concrete classes: `NpcSprite`, later `EnemySprite`. */
export interface ReconcilableSprite {
  syncFromModel(): void;
  destroy(): void;
}

export type SpriteFactory<S extends ReconcilableSprite> = (
  scene: Phaser.Scene,
  model: EntityModel,
) => S | null;

/** Per-scene view manager. Subscribes to the global registry and spawns/
 *  destroys sprites so the scene always has exactly one sprite per entity
 *  on its own map. */
export class SpriteReconciler<S extends ReconcilableSprite = ReconcilableSprite> {
  private readonly scene: Phaser.Scene;
  private readonly mapId: MapId;
  private readonly factory: SpriteFactory<S>;
  private readonly sprites = new Map<EntityId, S>();

  constructor(scene: Phaser.Scene, mapId: MapId, factory: SpriteFactory<S>) {
    this.scene = scene;
    this.mapId = mapId;
    this.factory = factory;

    entityRegistry.events.onTyped("added", this.onAdded);
    entityRegistry.events.onTyped("removed", this.onRemoved);
    entityRegistry.events.onTyped("mapChanged", this.onMapChanged);

    for (const model of entityRegistry.getByMap(mapId)) this.spawn(model);
  }

  /** Sync every managed sprite from its model. Call this once per frame from
   *  the owning scene's update loop (after the ticker has mutated models). */
  syncAll() {
    for (const sprite of this.sprites.values()) sprite.syncFromModel();
  }

  spritesIter(): Iterable<S> {
    return this.sprites.values();
  }

  spriteFor(id: EntityId): S | undefined {
    return this.sprites.get(id);
  }

  shutdown() {
    entityRegistry.events.offTyped("added", this.onAdded);
    entityRegistry.events.offTyped("removed", this.onRemoved);
    entityRegistry.events.offTyped("mapChanged", this.onMapChanged);
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
  }

  private spawn(model: EntityModel) {
    if (this.sprites.has(model.id)) return;
    const sprite = this.factory(this.scene, model);
    if (!sprite) return;
    this.sprites.set(model.id, sprite);
  }

  private despawn(id: EntityId) {
    const sprite = this.sprites.get(id);
    if (!sprite) return;
    sprite.destroy();
    this.sprites.delete(id);
  }

  private readonly onAdded = (model: EntityModel) => {
    if (mapIdEquals(model.mapId, this.mapId)) this.spawn(model);
  };

  private readonly onRemoved = (model: EntityModel) => {
    this.despawn(model.id);
  };

  private readonly onMapChanged = (model: EntityModel, _prev: MapId) => {
    const here = mapIdEquals(model.mapId, this.mapId);
    const has = this.sprites.has(model.id);
    if (here && !has) this.spawn(model);
    else if (!here && has) this.despawn(model.id);
  };
}
