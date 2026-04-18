import * as Phaser from "phaser";
import { tilesetImageKeyFor, type WorldManifest } from "../world/chunkManager";
import {
  VESSEL_ANIM_DIRS,
  VESSEL_ANIM_STATES,
  VESSEL_TEMPLATES,
  vesselAnimKey,
  vesselTextureKey,
} from "../entities/vessels";
import {
  PLAYER_ANIM_COLS,
  PLAYER_ANIM_DIRS,
  PLAYER_ANIM_STATES,
  PLAYER_FRAME_SIZE,
  PLAYER_ROW_FOR_DIR,
  playerAnimKey,
  playerTextureKey,
} from "../entities/playerAnims";
import { npcTextureKey, type NpcData } from "../entities/npcTypes";
import npcDataRaw from "../data/npcs.json";

export const WORLD_MANIFEST_KEY = "worldManifest";
export const CHUNK_KEY_PREFIX = "chunk_";

const npcData = npcDataRaw as NpcData;

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

    for (const state of PLAYER_ANIM_STATES) {
      this.load.spritesheet(playerTextureKey(state), `sprites/character/${state}.png`, {
        frameWidth: PLAYER_FRAME_SIZE,
        frameHeight: PLAYER_FRAME_SIZE,
      });
    }

    for (const npc of npcData.npcs) {
      const idle = npc.sprite.idle;
      this.load.spritesheet(npcTextureKey(npc.id, "idle"), idle.sheet, {
        frameWidth: idle.frameWidth,
        frameHeight: idle.frameHeight,
      });
      if (npc.sprite.walk) {
        const walk = npc.sprite.walk;
        this.load.spritesheet(npcTextureKey(npc.id, "walk"), walk.sheet, {
          frameWidth: walk.frameWidth,
          frameHeight: walk.frameHeight,
        });
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

    for (const state of PLAYER_ANIM_STATES) {
      const cols = PLAYER_ANIM_COLS[state];
      for (const dir of PLAYER_ANIM_DIRS) {
        const key = playerAnimKey(state, dir);
        if (this.anims.exists(key)) continue;
        const rowStart = PLAYER_ROW_FOR_DIR[dir] * cols;
        this.anims.create({
          key,
          frames: this.anims.generateFrameNumbers(playerTextureKey(state), {
            start: rowStart,
            end: rowStart + cols - 1,
          }),
          frameRate: state === "idle" ? 4 : 8,
          repeat: -1,
        });
      }
    }

    this.scene.start("World");
  }
}
