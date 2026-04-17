import * as Phaser from "phaser";
import { tilesetImageKeyFor, type WorldManifest } from "../world/chunkManager";
import {
  VESSEL_ANIM_DIRS,
  VESSEL_ANIM_STATES,
  VESSEL_TEMPLATES,
  vesselAnimKey,
  vesselTextureKey,
} from "../entities/vessels";

export const WORLD_MANIFEST_KEY = "worldManifest";
export const CHUNK_KEY_PREFIX = "chunk_";

export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload() {
    this.load.json(WORLD_MANIFEST_KEY, "maps/world.json");
    this.load.on(`filecomplete-json-${WORLD_MANIFEST_KEY}`, (_k: string, _t: string, data: WorldManifest) => {
      const images = data.tilesetImages ?? [];
      for (const imagePath of images) {
        this.load.image(tilesetImageKeyFor(imagePath), `maps/${imagePath}`);
      }
      for (const key of data.authoredChunks) {
        this.load.tilemapTiledJSON(`${CHUNK_KEY_PREFIX}${key}`, `maps/chunks/${key}.tmj`);
      }
    });

    for (const vessel of Object.values(VESSEL_TEMPLATES)) {
      for (const state of VESSEL_ANIM_STATES) {
        for (const dir of VESSEL_ANIM_DIRS) {
          this.load.spritesheet(
            vesselTextureKey(vessel, state, dir),
            `sprites/${vessel.spritePrefix}-${state}-${dir}.png`,
            { frameWidth: vessel.frame.width, frameHeight: vessel.frame.height },
          );
        }
      }
    }
  }

  create() {
    for (const vessel of Object.values(VESSEL_TEMPLATES)) {
      for (const state of VESSEL_ANIM_STATES) {
        for (const dir of VESSEL_ANIM_DIRS) {
          const key = vesselAnimKey(vessel, state, dir);
          if (this.anims.exists(key)) continue;
          const count = vessel.frames[state];
          this.anims.create({
            key,
            frames: this.anims.generateFrameNumbers(vesselTextureKey(vessel, state, dir), {
              start: 0,
              end: count - 1,
            }),
            frameRate: vessel.frameRate,
            repeat: -1,
          });
        }
      }
    }
    this.scene.start("World");
  }
}
