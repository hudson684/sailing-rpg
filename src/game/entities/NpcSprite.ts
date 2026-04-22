import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { npcAnimKey, npcTextureKey, type NpcDef } from "./npcTypes";
import type { NpcModel } from "./NpcModel";

export const NPC_INTERACT_RADIUS = TILE_SIZE * 1.0;

/** Scene-local view for an NpcModel. Owns a Phaser sprite; reads position,
 *  facing, and animation state from the model each frame. */
export class NpcSprite {
  readonly model: NpcModel;
  readonly sprite: Phaser.GameObjects.Sprite;
  private currentAnim: string | null = null;

  constructor(scene: Phaser.Scene, model: NpcModel) {
    this.model = model;
    const def = model.def;
    // NpcSprite is only spawned for legacy NPCs (the factory routes layered
    // NPCs to CharacterSprite). `def.sprite` is therefore defined here; the
    // `!` is safe and keeps the type-narrowing cleaner than threading an
    // additional constructor param.
    const sheet = def.sprite!;
    this.sprite = scene.add.sprite(model.x, model.y, npcTextureKey(def.id, "idle"), sheet.idle.start);
    this.sprite.setScale(def.display.scale);
    this.sprite.setOrigin(0.5, def.display.originY);
    this.applyAnim();
    this.sprite.setDepth(this.sortY());
  }

  syncFromModel() {
    const m = this.model;
    this.sprite.setPosition(m.x, m.y);
    this.sprite.setFlipX(m.facing === "left");
    const hasWalk = !!m.def.sprite?.walk;
    const resolved = m.animState === "walk" && !hasWalk ? "idle" : m.animState;
    const key = npcAnimKey(m.def.id, resolved);
    if (this.currentAnim !== key) {
      this.sprite.anims.play(key, true);
      this.currentAnim = key;
    }
    this.sprite.setDepth(this.sortY());
  }

  sortY(): number {
    return this.sprite.y;
  }

  destroy() {
    this.sprite.destroy();
  }

  private applyAnim() {
    const def = this.model.def;
    this.sprite.setFlipX(this.model.facing === "left");
    const key = npcAnimKey(def.id, "idle");
    this.sprite.anims.play(key, true);
    this.currentAnim = key;
  }
}

export function registerNpcAnimations(scene: Phaser.Scene, def: NpcDef) {
  // Layered NPCs register anims via setupCharacterAnims(); bail if called
  // on one of those so we don't touch `def.sprite` when it's absent.
  if (!def.sprite) return;
  const sheet = def.sprite;
  const states: Array<"idle" | "walk"> = sheet.walk ? ["idle", "walk"] : ["idle"];
  for (const state of states) {
    const key = npcAnimKey(def.id, state);
    if (scene.anims.exists(key)) scene.anims.remove(key);
    const cfg = state === "walk" ? sheet.walk! : sheet.idle;
    scene.anims.create({
      key,
      frames: scene.anims.generateFrameNumbers(npcTextureKey(def.id, state), {
        start: cfg.start,
        end: cfg.end,
      }),
      frameRate: cfg.frameRate,
      repeat: -1,
    });
  }
}
