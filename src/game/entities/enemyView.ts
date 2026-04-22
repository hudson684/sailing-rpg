import * as Phaser from "phaser";
import {
  enemyAnimKey,
  enemyTextureKey,
  type EnemyAnimState,
  type EnemyDef,
} from "./enemyTypes";
import {
  charAnimKey,
  charTextureKey,
  type CharacterModelManifest,
  type NpcLayeredSprite,
} from "./npcTypes";

/** The operations `Enemy` performs on its on-screen representation. Two
 *  implementations: `SingleSpriteEnemyView` (legacy one-sheet enemies like
 *  slimes and skeletons) and `LayeredEnemyView` (humanoid enemies built from
 *  a character model's per-slot sheets — pirates, bandits, etc.). Using a
 *  narrow interface lets Enemy's combat/movement/respawn logic stay agnostic
 *  to how the pixels actually get composited. */
export interface EnemyView {
  /** Current display position of the character. Writable so the stepToward
   *  loop can nudge x/y during movement without going through setPosition. */
  x: number;
  y: number;
  setPosition(x: number, y: number): void;
  setDepth(d: number): void;
  setVisible(v: boolean): void;
  setAlpha(a: number): void;
  setTint(color: number): void;
  clearTint(): void;
  setFlipX(flip: boolean): void;
  /** Switch to the given animation state. Layered views translate enemy
   *  states (idle/move/attack/hurt/death) to tag names and play each child
   *  sprite's animation; single views play the state's registered anim. */
  playState(state: EnemyAnimState): void;
  /** True if any animation is currently running — used by `setAnimState` to
   *  avoid re-triggering an already-playing loop. */
  isAnimPlaying(): boolean;
  /** Register a one-shot completion callback for whichever anim is playing.
   *  Layered views hook the first child's sprite; because every slot plays
   *  at the same frame rate over the same frame count they complete in the
   *  same tick. */
  onceAnimComplete(cb: () => void): void;
  destroy(): void;
}

// Enemy state → tag name convention in layered character models. "move" →
// "walk" because walk is the shipped tag name from the master; "attack" →
// "sword" because pirate-style humanoids use a sword swing tag.
export const ENEMY_STATE_TO_TAG: Record<EnemyAnimState, string> = {
  idle: "idle",
  move: "walk",
  attack: "sword",
  hurt: "hurt",
  death: "death",
};

export class SingleSpriteEnemyView implements EnemyView {
  private readonly def: EnemyDef;
  private readonly sprite: Phaser.GameObjects.Sprite;

  constructor(scene: Phaser.Scene, def: EnemyDef, x: number, y: number) {
    this.def = def;
    this.sprite = scene.add.sprite(x, y, enemyTextureKey(def.id), 0);
    this.sprite.setScale(def.display.scale);
    this.sprite.setOrigin(0.5, def.display.originY);
  }

  get x(): number { return this.sprite.x; }
  set x(v: number) { this.sprite.x = v; }
  get y(): number { return this.sprite.y; }
  set y(v: number) { this.sprite.y = v; }
  setPosition(x: number, y: number) { this.sprite.setPosition(x, y); }
  setDepth(d: number) { this.sprite.setDepth(d); }
  setVisible(v: boolean) { this.sprite.setVisible(v); }
  setAlpha(a: number) { this.sprite.setAlpha(a); }
  setTint(color: number) { this.sprite.setTint(color); }
  clearTint() { this.sprite.clearTint(); }
  setFlipX(flip: boolean) { this.sprite.setFlipX(flip); }

  playState(state: EnemyAnimState) {
    const cfg = this.def.sprite!.anims[state];
    const originY = cfg?.originY ?? this.def.display.originY;
    this.sprite.setOrigin(0.5, originY);
    this.sprite.anims.play(enemyAnimKey(this.def.id, state), true);
  }

  isAnimPlaying(): boolean {
    return this.sprite.anims.isPlaying;
  }

  onceAnimComplete(cb: () => void) {
    this.sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, cb);
  }

  destroy() {
    this.sprite.destroy();
  }
}

export class LayeredEnemyView implements EnemyView {
  private readonly layered: NpcLayeredSprite;
  private readonly container: Phaser.GameObjects.Container;
  private readonly children: Array<{
    slot: string;
    variant: string;
    sprite: Phaser.GameObjects.Sprite;
  }> = [];

  constructor(
    scene: Phaser.Scene,
    def: EnemyDef,
    layered: NpcLayeredSprite,
    manifest: CharacterModelManifest,
    x: number,
    y: number,
  ) {
    // `def` kept on the instance only for consistency with the single-sprite
    // view; layered views don't currently need it after construction, but
    // future per-anim origin overrides would live here.
    void def;
    this.layered = layered;
    this.container = scene.add.container(x, y);
    this.container.setScale(def.display.scale);

    // Model manifest's slotOrder decides render order; skip slots the NPC
    // instance didn't fill or whose texture didn't load for any reason.
    for (const slot of manifest.slotOrder) {
      const variant = layered.slots[slot];
      if (!variant) continue;
      const textureKey = charTextureKey(layered.model, slot, variant, "idle");
      if (!scene.textures.exists(textureKey)) continue;
      const sprite = scene.add.sprite(0, 0, textureKey, 0);
      sprite.setOrigin(0.5, def.display.originY);
      this.container.add(sprite);
      this.children.push({ slot, variant, sprite });
    }
  }

  get x(): number { return this.container.x; }
  set x(v: number) { this.container.x = v; }
  get y(): number { return this.container.y; }
  set y(v: number) { this.container.y = v; }
  setPosition(x: number, y: number) { this.container.setPosition(x, y); }
  setDepth(d: number) { this.container.setDepth(d); }
  setVisible(v: boolean) { this.container.setVisible(v); }
  setAlpha(a: number) { this.container.setAlpha(a); }

  setTint(color: number) {
    // Container has no tint of its own; apply to every child.
    for (const c of this.children) c.sprite.setTint(color);
  }

  clearTint() {
    for (const c of this.children) c.sprite.clearTint();
  }

  setFlipX(flip: boolean) {
    // Container doesn't propagate flipX automatically either.
    for (const c of this.children) c.sprite.setFlipX(flip);
  }

  playState(state: EnemyAnimState) {
    const tag = ENEMY_STATE_TO_TAG[state] ?? state;
    for (const c of this.children) {
      const key = charAnimKey(this.layered.model, c.slot, c.variant, tag);
      if (c.sprite.scene.anims.exists(key)) c.sprite.anims.play(key, true);
    }
  }

  isAnimPlaying(): boolean {
    return this.children.some((c) => c.sprite.anims.isPlaying);
  }

  onceAnimComplete(cb: () => void) {
    // Hook the first child — all slot sheets share frame count + rate, so
    // completion fires on all children simultaneously.
    if (this.children.length === 0) {
      // No children (bad data); fire immediately so state machines progress
      // rather than hanging in e.g. an "attack" that never completes.
      queueMicrotask(cb);
      return;
    }
    this.children[0].sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, cb);
  }

  destroy() {
    this.container.destroy(true);
  }
}
