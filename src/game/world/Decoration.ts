import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";

export interface DecorationSpriteDef {
  sheet: string;
  frameWidth: number;
  frameHeight: number;
  frames: number;
  frameRate: number;
  scale?: number;
  /** 0..1 vertical origin: 0.5 centers vertically on the tile, 1 anchors
   *  the bottom of the sprite to the tile center (useful for ground FX). */
  originY?: number;
}

export interface DecorationDef {
  id: string;
  name: string;
  sprite: DecorationSpriteDef;
}

export interface DecorationInstanceData {
  id: string;
  defId: string;
  tileX: number;
  tileY: number;
}

export interface DecorationsFile {
  defs: DecorationDef[];
  instances: DecorationInstanceData[];
}

export const decorationTextureKey = (defId: string) => `decoration_${defId}`;
export const decorationAnimKey = (defId: string) => `decoration_${defId}_loop`;

/** Purely cosmetic animated sprite. No collision, HP, or interaction. */
export class Decoration {
  readonly id: string;
  readonly def: DecorationDef;
  private readonly sprite: Phaser.GameObjects.Sprite;

  constructor(scene: Phaser.Scene, def: DecorationDef, instance: DecorationInstanceData) {
    this.id = instance.id;
    this.def = def;
    const x = (instance.tileX + 0.5) * TILE_SIZE;
    const y = (instance.tileY + 0.5) * TILE_SIZE;
    const originY = def.sprite.originY ?? 0.5;
    this.sprite = scene.add
      .sprite(x, y, decorationTextureKey(def.id))
      .setOrigin(0.5, originY)
      .setScale(def.sprite.scale ?? 1)
      .setDepth(y);
    const animKey = decorationAnimKey(def.id);
    if (scene.anims.exists(animKey)) this.sprite.play(animKey);
  }

  destroy() {
    this.sprite.destroy();
  }
}

export function loadDecorationsFile(raw: unknown): DecorationsFile {
  return raw as DecorationsFile;
}
