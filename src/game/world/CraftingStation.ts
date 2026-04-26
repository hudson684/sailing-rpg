import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import type {
  CraftingStationDef,
  CraftingStationInstanceData,
} from "../crafting/types";

export const stationTextureKey = (defId: string) => `station_${defId}`;
export const stationAnimKey = (defId: string) => `station_${defId}_loop`;

/**
 * World object for a crafting station. Same shape story as GatheringNode —
 * colored rectangle with a label above it and a blocking footprint. Kept
 * skill-agnostic: the station's kind/def drives all theming, so new stations
 * (oven, loom, workbench) can be added purely as data.
 *
 * MVP is rectangle + label; when per-station sprites arrive they can layer on
 * top exactly like GatheringNode.sprite (see NodeSpriteDef).
 */

export const STATION_INTERACT_RADIUS = TILE_SIZE * 1.4;

export class CraftingStation {
  readonly id: string;
  readonly def: CraftingStationDef;
  x: number;
  y: number;
  private readonly container: Phaser.GameObjects.Container;

  constructor(
    scene: Phaser.Scene,
    def: CraftingStationDef,
    instance: CraftingStationInstanceData,
  ) {
    this.id = instance.id;
    this.def = def;
    this.x = (instance.tileX + 0.5) * TILE_SIZE;
    this.y = (instance.tileY + 0.5) * TILE_SIZE;

    this.container = scene.add.container(this.x, this.y);
    this.container.setDepth(this.y);

    if (def.sprite) {
      const s = def.sprite;
      const sprite = scene.add
        .sprite(
          def.collisionOffsetX ?? 0,
          (def.collisionOffsetY ?? 0) + def.height / 2,
          stationTextureKey(def.id),
        )
        .setOrigin(0.5, s.originY ?? 1)
        .setScale(s.scale ?? 1);
      const animKey = stationAnimKey(def.id);
      if (scene.anims.exists(animKey)) sprite.play(animKey);
      this.container.add(sprite);
      return;
    }

    if (def.invisible) return;

    const bg = Phaser.Display.Color.HexStringToColor(def.bgColor).color;
    const accentCol = Phaser.Display.Color.HexStringToColor(def.accentColor).color;
    const body = scene.add
      .rectangle(
        def.collisionOffsetX ?? 0,
        def.collisionOffsetY ?? 0,
        def.width,
        def.height,
        bg,
      )
      .setStrokeStyle(2, accentCol);

    // Little accent strip for a bit of visual texture — evokes a glowing coal
    // bed on the smelter / a horn on the anvil. Crude but readable.
    const accentH = Math.max(3, Math.floor(def.height * 0.18));
    const accent = scene.add
      .rectangle(
        def.collisionOffsetX ?? 0,
        (def.collisionOffsetY ?? 0) + def.height / 2 - accentH / 2 - 1,
        Math.max(6, Math.floor(def.width * 0.55)),
        accentH,
        accentCol,
      )
      .setOrigin(0.5);

    const label = scene.add
      .text(
        def.collisionOffsetX ?? 0,
        (def.collisionOffsetY ?? 0) - def.height / 2 - 4,
        def.name,
        {
          fontFamily: "monospace",
          fontSize: "10px",
          color: def.labelColor,
          stroke: "#000000",
          strokeThickness: 3,
          align: "center",
        },
      )
      .setOrigin(0.5, 1);

    this.container.add([body, accent, label]);
  }

  setVisible(visible: boolean): void {
    this.container.setVisible(visible);
  }

  /** Pixel-rect blocks player walkability when the def opts in. */
  blocksPx(px: number, py: number): boolean {
    if (!this.def.blocks) return false;
    const hw = this.def.width / 2;
    const hh = this.def.height / 2;
    const cx = this.x + (this.def.collisionOffsetX ?? 0);
    const cy = this.y + (this.def.collisionOffsetY ?? 0);
    return (
      px >= cx - hw &&
      px <= cx + hw &&
      py >= cy - hh &&
      py <= cy + hh
    );
  }

  destroy() {
    this.container.destroy();
  }
}
