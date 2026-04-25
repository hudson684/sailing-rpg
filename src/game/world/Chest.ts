import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import type { ItemId } from "../inventory/items";

export interface ChestSpriteDef {
  sheet: string;
  frameWidth: number;
  frameHeight: number;
  frames: number;
  frameRate: number;
  scale?: number;
  originY?: number;
}

export interface ChestLootEntry {
  itemId: ItemId;
  qty: number;
  /** 0..1 probability the entry rolls into the chest's contents. */
  chance: number;
}

export interface ChestDef {
  id: string;
  name: string;
  sprite: ChestSpriteDef;
  loot: ChestLootEntry[];
}

export interface ChestInstanceData {
  id: string;
  defId: string;
  tileX: number;
  tileY: number;
}

export interface ChestsFile {
  defs: ChestDef[];
  instances: ChestInstanceData[];
}

export const chestTextureKey = (defId: string) => `chest_${defId}`;
export const chestOpenAnimKey = (defId: string) => `chest_${defId}_open`;
export const chestLootedFlagKey = (instanceId: string) => `chest.${instanceId}.looted`;

export function loadChestsFile(raw: unknown): ChestsFile {
  return raw as ChestsFile;
}

/** Roll the chest's loot table once. Each entry rolls independently against its
 *  own `chance`. Caller decides what to do with the rolled list. */
export function rollChestLoot(def: ChestDef): Array<{ itemId: ItemId; qty: number }> {
  const out: Array<{ itemId: ItemId; qty: number }> = [];
  for (const entry of def.loot) {
    if (Math.random() < entry.chance) {
      out.push({ itemId: entry.itemId, qty: entry.qty });
    }
  }
  return out;
}

/**
 * Interactable loot chest. Spawns closed; on `open()` plays the opening
 * animation once and stays on its final frame. Looted state is persisted by
 * the caller via FlagStore — already-looted chests should be constructed
 * with `startOpened=true`.
 */
export class Chest {
  readonly id: string;
  readonly def: ChestDef;
  readonly x: number;
  readonly y: number;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private opened: boolean;

  constructor(
    scene: Phaser.Scene,
    def: ChestDef,
    instance: ChestInstanceData,
    startOpened: boolean,
  ) {
    this.id = instance.id;
    this.def = def;
    this.x = (instance.tileX + 0.5) * TILE_SIZE;
    this.y = (instance.tileY + 0.5) * TILE_SIZE;
    this.opened = startOpened;

    const originY = def.sprite.originY ?? 1;
    this.sprite = scene.add
      .sprite(this.x, this.y, chestTextureKey(def.id))
      .setOrigin(0.5, originY)
      .setScale(def.sprite.scale ?? 1)
      .setDepth(this.y);

    if (startOpened) {
      // Final frame of opening anim = open chest.
      this.sprite.setFrame(def.sprite.frames - 1);
    } else {
      this.sprite.setFrame(0);
    }
  }

  isOpen(): boolean {
    return this.opened;
  }

  /** Play the opening anim. `onComplete` fires when the animation finishes
   *  (immediately, if the chest is already open). */
  playOpen(onComplete?: () => void): void {
    if (this.opened) {
      onComplete?.();
      return;
    }
    this.opened = true;
    const animKey = chestOpenAnimKey(this.def.id);
    if (!this.sprite.scene.anims.exists(animKey)) {
      this.sprite.setFrame(this.def.sprite.frames - 1);
      onComplete?.();
      return;
    }
    this.sprite.once(
      Phaser.Animations.Events.ANIMATION_COMPLETE,
      () => onComplete?.(),
    );
    this.sprite.play(animKey);
  }

  /** Play the opening anim in reverse to "close" the chest. `onComplete`
   *  fires when the animation finishes. */
  playClose(onComplete?: () => void): void {
    if (!this.opened) {
      onComplete?.();
      return;
    }
    const animKey = chestOpenAnimKey(this.def.id);
    if (!this.sprite.scene.anims.exists(animKey)) {
      this.opened = false;
      this.sprite.setFrame(0);
      onComplete?.();
      return;
    }
    this.sprite.once(
      Phaser.Animations.Events.ANIMATION_COMPLETE,
      () => {
        this.opened = false;
        this.sprite.setFrame(0);
        onComplete?.();
      },
    );
    this.sprite.playReverse(animKey);
  }

  /** Pixel-rect blocks player walkability. Tile-sized footprint centered on
   *  the chest's tile. */
  blocksPx(px: number, py: number): boolean {
    const hw = TILE_SIZE / 2;
    const hh = TILE_SIZE / 2;
    return (
      px >= this.x - hw &&
      px <= this.x + hw &&
      py >= this.y - hh &&
      py <= this.y + hh
    );
  }

  destroy(): void {
    this.sprite.destroy();
  }
}

export const CHEST_INTERACT_RADIUS = TILE_SIZE * 2.2;
