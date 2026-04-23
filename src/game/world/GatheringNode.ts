import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import type { ItemId } from "../inventory/items";
import type { JobId } from "../jobs/jobs";

export type NodeKind = "tree" | "ore";

export interface NodeDef {
  id: string;
  name: string;
  kind: NodeKind;
  color: string;
  outlineColor: string;
  width: number;
  height: number;
  hp: number;
  respawnSec: number;
  /** Item id of the tool that must be equipped (mainHand) to harvest. */
  requiredTool: ItemId;
  skill: JobId;
  xpPerHit: number;
  drop: { itemId: ItemId; quantity: number; quantityMax?: number };
  /** If true, the node's footprint blocks player movement while alive. */
  blocks: boolean;
  /** Pixel offset of the collision box center from the node anchor. */
  collisionOffsetX?: number;
  collisionOffsetY?: number;
  /** Pixel offset applied to the depth-sort y (anchor.y + ySortOffset). */
  ySortOffset?: number;
  /** Optional animated sprite to render in place of the color rectangle. */
  sprite?: NodeSpriteDef;
  /** Multiplier on NODE_INTERACT_RADIUS for this node. Defaults to 1. */
  interactRadiusMul?: number;
}

export interface NodeSpriteDef {
  sheet: string;
  frameWidth: number;
  frameHeight: number;
  frames: number;
  frameRate: number;
  scale?: number;
  /** 0..1 vertical origin: 1 = bottom of sprite sits on node anchor. */
  originY?: number;
}

export const nodeSpriteTextureKey = (defId: string) => `node_${defId}`;
export const nodeSpriteAnimKey = (defId: string) => `node_${defId}_idle`;

export interface NodeInstanceData {
  id: string;
  defId: string;
  tileX: number;
  tileY: number;
  /** Phase 7: optional spawn gate. */
  when?: import("../quests/types").Predicate;
}

interface NodesFile {
  defs: NodeDef[];
  instances: NodeInstanceData[];
}

/** Pixel radius around the node center within which the player can interact. */
export const NODE_INTERACT_RADIUS = TILE_SIZE * 1.4;

export class GatheringNode {
  readonly id: string;
  readonly def: NodeDef;
  x: number;
  y: number;
  private hp: number;
  private alive = true;
  private respawnAt = 0;
  private readonly container: Phaser.GameObjects.Container;
  private readonly body: Phaser.GameObjects.Rectangle;
  private readonly sprite?: Phaser.GameObjects.Sprite;
  private readonly hpBar: Phaser.GameObjects.Rectangle;
  private readonly hpBarBg: Phaser.GameObjects.Rectangle;

  constructor(scene: Phaser.Scene, def: NodeDef, instance: NodeInstanceData) {
    this.id = instance.id;
    this.def = def;
    this.x = (instance.tileX + 0.5) * TILE_SIZE;
    this.y = (instance.tileY + 0.5) * TILE_SIZE;
    this.hp = def.hp;

    this.container = scene.add.container(this.x, this.y);
    this.container.setDepth(this.y + (def.ySortOffset ?? 0));

    this.body = scene.add
      .rectangle(
        def.collisionOffsetX ?? 0,
        def.collisionOffsetY ?? 0,
        def.width,
        def.height,
        Phaser.Display.Color.HexStringToColor(def.color).color,
      )
      .setStrokeStyle(2, Phaser.Display.Color.HexStringToColor(def.outlineColor).color);
    if (def.sprite) {
      const s = def.sprite;
      const scale = s.scale ?? 1;
      const originY = s.originY ?? 1;
      // Place the sprite so its (0.5, originY) point sits at the bottom of
      // the node footprint — that anchor lines up with the trunk base.
      this.sprite = scene.add
        .sprite(0, def.height / 2, nodeSpriteTextureKey(def.id))
        .setOrigin(0.5, originY)
        .setScale(scale);
      const animKey = nodeSpriteAnimKey(def.id);
      if (scene.anims.exists(animKey)) this.sprite.play(animKey);
      this.body.setVisible(false);
    }
    this.hpBarBg = scene.add
      .rectangle(0, def.height / 2 + 4, def.width, 3, 0x000000, 0.6)
      .setOrigin(0.5, 0);
    this.hpBar = scene.add
      .rectangle(-def.width / 2, def.height / 2 + 4, def.width, 3, 0x55cc55)
      .setOrigin(0, 0);
    this.hpBarBg.setVisible(false);
    this.hpBar.setVisible(false);
    this.container.add([this.body, this.hpBarBg, this.hpBar]);
    if (this.sprite) this.container.addAt(this.sprite, 0);
  }

  isAlive(): boolean {
    return this.alive;
  }

  setVisible(visible: boolean): void {
    this.container.setVisible(visible);
  }

  /** Pixel-rect of the node, used for player walkability when blocking. */
  blocksPx(px: number, py: number): boolean {
    if (!this.alive || !this.def.blocks) return false;
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

  /** Apply 1 hit. Returns true if the node was just broken. */
  hit(scene: Phaser.Scene): boolean {
    if (!this.alive) return false;
    this.hp -= 1;
    this.flash(scene);
    this.updateHpBar();
    if (this.hp <= 0) {
      this.break(scene);
      return true;
    }
    return false;
  }

  private updateHpBar() {
    const pct = Math.max(0, this.hp / this.def.hp);
    this.hpBar.setVisible(true);
    this.hpBarBg.setVisible(true);
    this.hpBar.width = this.def.width * pct;
  }

  private flash(scene: Phaser.Scene) {
    scene.tweens.add({
      targets: this.sprite ?? this.body,
      alpha: 0.3,
      duration: 80,
      yoyo: true,
    });
    scene.tweens.add({
      targets: this.container,
      x: this.x + 2,
      duration: 50,
      yoyo: true,
      repeat: 1,
      onComplete: () => this.container.setX(this.x),
    });
  }

  private break(scene: Phaser.Scene) {
    this.alive = false;
    this.container.setVisible(false);
    this.respawnAt = scene.time.now + this.def.respawnSec * 1000;
  }

  /** Called each frame; respawns when the timer elapses. */
  update(now: number) {
    if (this.alive) return;
    if (now >= this.respawnAt) this.respawn();
  }

  private respawn() {
    this.alive = true;
    this.hp = this.def.hp;
    this.container.setVisible(true);
    this.body.setAlpha(1);
    this.sprite?.setAlpha(1);
    this.hpBar.setVisible(false);
    this.hpBarBg.setVisible(false);
  }

  setPositionPx(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.container.setPosition(x, y);
    this.container.setDepth(y);
  }

  destroy() {
    this.container.destroy();
  }
}

export function loadNodesFile(raw: unknown): NodesFile {
  return raw as NodesFile;
}

export function indexDefs(defs: NodeDef[]): Map<string, NodeDef> {
  const map = new Map<string, NodeDef>();
  for (const d of defs) map.set(d.id, d);
  return map;
}
