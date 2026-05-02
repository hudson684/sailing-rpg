import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";

export interface BusinessSignInstanceData {
  id: string;
  businessId: string;
  tileX: number;
  tileY: number;
}

export interface BusinessSignsFile {
  instances: BusinessSignInstanceData[];
}

export const BUSINESS_SIGN_INTERACT_RADIUS = TILE_SIZE * 1.6;

const SIGN_WIDTH = TILE_SIZE * 1.2;
const SIGN_HEIGHT = TILE_SIZE * 0.9;
const POST_WIDTH = TILE_SIZE * 0.18;
const POST_HEIGHT = TILE_SIZE * 0.6;

export function loadBusinessSignsFile(raw: unknown): BusinessSignsFile {
  return raw as BusinessSignsFile;
}

/** Placeholder "for sale" sign. Renders a small wooden post with a panel and
 *  the property name above it. Real art comes later — for now this is just
 *  enough for the player to spot and interact with. */
export class BusinessSign {
  readonly id: string;
  readonly businessId: string;
  readonly x: number;
  readonly y: number;
  private readonly container: Phaser.GameObjects.Container;
  private readonly label: Phaser.GameObjects.Text;

  constructor(
    scene: Phaser.Scene,
    instance: BusinessSignInstanceData,
    displayName: string,
  ) {
    this.id = instance.id;
    this.businessId = instance.businessId;
    this.x = (instance.tileX + 0.5) * TILE_SIZE;
    this.y = (instance.tileY + 0.5) * TILE_SIZE;

    const post = scene.add
      .rectangle(0, POST_HEIGHT / 2, POST_WIDTH, POST_HEIGHT, 0x6b4424)
      .setStrokeStyle(1, 0x2c1a0d);
    const panel = scene.add
      .rectangle(0, -SIGN_HEIGHT / 2, SIGN_WIDTH, SIGN_HEIGHT, 0xc9a36a)
      .setStrokeStyle(1, 0x4a2f12);
    this.label = scene.add
      .text(0, -SIGN_HEIGHT / 2, displayName, {
        fontFamily: "monospace",
        fontSize: "8px",
        color: "#2a1707",
        align: "center",
        wordWrap: { width: SIGN_WIDTH - 4 },
      })
      .setOrigin(0.5, 0.5);

    this.container = scene.add
      .container(this.x, this.y, [post, panel, this.label])
      .setDepth(this.y);
  }

  /** Tile-sized footprint (post only — the panel can overhang). */
  blocksPx(px: number, py: number): boolean {
    const hw = POST_WIDTH / 2;
    return (
      px >= this.x - hw &&
      px <= this.x + hw &&
      py >= this.y &&
      py <= this.y + POST_HEIGHT
    );
  }

  destroy(): void {
    this.container.destroy();
  }
}
