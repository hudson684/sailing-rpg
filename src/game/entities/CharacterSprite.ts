import * as Phaser from "phaser";
import type { NpcModel } from "./NpcModel";
import type { ReconcilableSprite } from "./SpriteReconciler";
import {
  charAnimKey,
  charTextureKey,
  type CharacterModelManifest,
} from "./npcTypes";

/** Layered view for an NpcModel whose `def.layered` is set. Builds a Phaser
 *  container holding one child sprite per slot present in the NPC's look,
 *  ordered by the model's `slotOrder` (bottom → top: body, head, hair, ...).
 *
 *  Every child plays its own animation key (e.g. `char-steve-body-walk`),
 *  but the frames on every slot-variant sheet are aligned pixel-perfect to
 *  the model's shared bbox so the composited character looks like one image.
 *  Phaser's per-scene animation clock advances every sprite's anim state by
 *  the same delta, so identical-frameRate loops started in the same tick
 *  stay frame-synced for the short animations NPCs use (4–8 frames). */
export class CharacterSprite implements ReconcilableSprite {
  readonly model: NpcModel;
  private readonly container: Phaser.GameObjects.Container;
  private readonly children: Array<{
    slot: string;
    variant: string;
    sprite: Phaser.GameObjects.Sprite;
  }>;
  private currentState: "idle" | "walk" | null = null;

  constructor(scene: Phaser.Scene, model: NpcModel, manifest: CharacterModelManifest) {
    this.model = model;
    const layered = model.def.layered!;
    this.container = scene.add.container(model.x, model.y);
    this.container.setScale(model.def.display.scale);

    const kids: typeof this.children = [];
    for (const slot of manifest.slotOrder) {
      const variant = layered.slots[slot];
      if (!variant) continue;
      const textureKey = charTextureKey(layered.model, slot, variant, "idle");
      if (!scene.textures.exists(textureKey)) continue;
      const sprite = scene.add.sprite(0, 0, textureKey, 0);
      sprite.setOrigin(0.5, model.def.display.originY);
      this.container.add(sprite);
      kids.push({ slot, variant, sprite });
    }
    this.children = kids;

    this.applyAnim();
    this.container.setDepth(this.sortY());
  }

  syncFromModel(): void {
    const m = this.model;
    this.container.setPosition(m.x, m.y);
    const flip = m.facing === "left";
    for (const c of this.children) c.sprite.setFlipX(flip);

    const walkAvailable = this.hasAnimFor("walk");
    const resolved: "idle" | "walk" =
      m.animState === "walk" && walkAvailable ? "walk" : "idle";
    if (this.currentState !== resolved) {
      this.playState(resolved);
    }
    this.container.setDepth(this.sortY());
  }

  sortY(): number {
    return this.container.y;
  }

  destroy(): void {
    this.container.destroy(true);
  }

  private applyAnim(): void {
    const flip = this.model.facing === "left";
    for (const c of this.children) c.sprite.setFlipX(flip);
    this.playState("idle");
  }

  private playState(state: "idle" | "walk"): void {
    const layered = this.model.def.layered!;
    for (const c of this.children) {
      const key = charAnimKey(layered.model, c.slot, c.variant, state);
      if (c.sprite.scene.anims.exists(key)) c.sprite.anims.play(key, true);
    }
    this.currentState = state;
  }

  /** Walk-state availability is decided per model (if the model manifest
   *  didn't ship walk frames at all, every child sprite lacks the walk anim
   *  key and we keep playing idle). We check the first child — they all
   *  share the same model manifest. */
  private hasAnimFor(state: "idle" | "walk"): boolean {
    const layered = this.model.def.layered;
    if (!layered || this.children.length === 0) return false;
    const first = this.children[0];
    return first.sprite.scene.anims.exists(
      charAnimKey(layered.model, first.slot, first.variant, state),
    );
  }
}
