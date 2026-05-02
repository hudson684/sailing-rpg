import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import {
  facingToRenderDir,
  isDirectionalAnimSheet,
  npcAnimKey,
  npcTextureKey,
  type NpcAnimSheetEntry,
  type NpcDef,
  type NpcRenderDir,
} from "./npcTypes";
import type { NpcModel } from "./NpcModel";

export const NPC_INTERACT_RADIUS = TILE_SIZE * 1.0;

/** Scene-local view for an NpcModel. Owns a Phaser sprite; reads position,
 *  facing, and animation state from the model each frame. */
export class NpcSprite {
  readonly model: NpcModel;
  readonly sprite: Phaser.GameObjects.Sprite;
  private currentAnim: string | null = null;
  private readonly directional: boolean;

  constructor(scene: Phaser.Scene, model: NpcModel) {
    this.model = model;
    const def = model.def;
    // NpcSprite is only spawned for legacy NPCs (the factory routes layered
    // NPCs to CharacterSprite). `def.sprite` is therefore defined here; the
    // `!` is safe and keeps the type-narrowing cleaner than threading an
    // additional constructor param.
    const sheet = def.sprite!;
    this.directional = isDirectionalAnimSheet(sheet.idle);
    const dir = this.directional ? facingToRenderDir(model.facing) : undefined;
    const startFrame = isDirectionalAnimSheet(sheet.idle)
      ? sheet.idle[dir!].start
      : sheet.idle.start;
    const keyId = def.spritePackId ?? def.id;
    this.sprite = scene.add.sprite(
      model.x,
      model.y,
      npcTextureKey(keyId, "idle", dir),
      startFrame,
    );
    this.sprite.setOrigin(0.5, def.display.originY);
    this.applyAnim();
    this.sprite.setDepth(this.sortY());
  }

  syncFromModel() {
    const m = this.model;
    this.sprite.setPosition(m.x, m.y);

    const dir = this.directional ? facingToRenderDir(m.facing) : undefined;
    // For directional NPCs, only flip when rendering the side view facing left.
    // For non-directional (side-only) NPCs, flip whenever facing left.
    const flip = this.directional
      ? dir === "side" && m.facing === "left"
      : m.facing === "left";
    this.sprite.setFlipX(flip);

    const hasWalk = !!m.def.sprite?.walk;
    const resolvedState: "idle" | "walk" =
      m.animState === "walk" && !hasWalk ? "idle" : m.animState;
    const keyId = m.def.spritePackId ?? m.def.id;
    const key = npcAnimKey(keyId, resolvedState, dir);
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
    const dir = this.directional ? facingToRenderDir(this.model.facing) : undefined;
    const flip = this.directional
      ? dir === "side" && this.model.facing === "left"
      : this.model.facing === "left";
    this.sprite.setFlipX(flip);
    const keyId = def.spritePackId ?? def.id;
    const key = npcAnimKey(keyId, "idle", dir);
    this.sprite.anims.play(key, true);
    this.currentAnim = key;
  }
}

const RENDER_DIRS: NpcRenderDir[] = ["down", "up", "side"];

function registerOne(
  scene: Phaser.Scene,
  npcId: string,
  state: "idle" | "walk",
  entry: NpcAnimSheetEntry,
) {
  if (isDirectionalAnimSheet(entry)) {
    for (const dir of RENDER_DIRS) {
      const cfg = entry[dir];
      const key = npcAnimKey(npcId, state, dir);
      if (scene.anims.exists(key)) scene.anims.remove(key);
      scene.anims.create({
        key,
        frames: scene.anims.generateFrameNumbers(npcTextureKey(npcId, state, dir), {
          start: cfg.start,
          end: cfg.end,
        }),
        frameRate: cfg.frameRate,
        repeat: -1,
      });
    }
  } else {
    const key = npcAnimKey(npcId, state);
    if (scene.anims.exists(key)) scene.anims.remove(key);
    scene.anims.create({
      key,
      frames: scene.anims.generateFrameNumbers(npcTextureKey(npcId, state), {
        start: entry.start,
        end: entry.end,
      }),
      frameRate: entry.frameRate,
      repeat: -1,
    });
  }
}

export function registerNpcAnimations(scene: Phaser.Scene, def: NpcDef) {
  // Layered NPCs register anims via setupCharacterAnims(); bail if called
  // on one of those so we don't touch `def.sprite` when it's absent.
  if (!def.sprite) return;
  const sheet = def.sprite;
  registerOne(scene, def.id, "idle", sheet.idle);
  if (sheet.walk) registerOne(scene, def.id, "walk", sheet.walk);
}
