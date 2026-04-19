import * as Phaser from "phaser";
import { tilesetImageKeyFor, type WorldManifest } from "../world/chunkManager";
import {
  SHIP_HEADINGS,
  loadShipsFile,
  shipTilemapKey,
} from "../entities/vessels";
import type { Heading } from "../entities/Ship";
import {
  CF_ANIMS,
  CF_DIRS,
  CF_FRAME_SIZE,
  CF_SHEET_COLS,
  CF_STATES,
  cfAnimKey,
  cfTextureKey,
  type CfLayer,
} from "../entities/playerAnims";
import { npcTextureKey, type NpcData } from "../entities/npcTypes";
import { registerNpcAnimations } from "../entities/NpcSprite";
import npcDataRaw from "../data/npcs.json";
import { enemyTextureKey, type EnemiesFile } from "../entities/enemyTypes";
import enemiesDataRaw from "../data/enemies.json";
import {
  loadNodesFile,
  nodeSpriteAnimKey,
  nodeSpriteTextureKey,
} from "../world/GatheringNode";
import nodesDataRaw from "../data/nodes.json";
import {
  SKIN_PALETTES,
  bakePlayerSkin,
  installPlayerSkinCanvases,
} from "../entities/playerSkin";
import { useSettingsStore } from "../store/settingsStore";
import { ALL_ITEM_IDS, ITEMS } from "../inventory/items";
import { CF_TOOLS, CF_TOOL_SHEETS, cfToolAnimKey } from "../entities/playerTools";
import { CF_WARDROBE_OPTIONS } from "../entities/playerWardrobe";

export const itemIconTextureKey = (id: string) => `item_icon_${id}`;

export const WORLD_MANIFEST_KEY = "worldManifest";
export const CHUNK_KEY_PREFIX = "chunk_";
export const INTERIOR_KEY_PREFIX = "interior_";

export const interiorTilemapKey = (key: string) => `${INTERIOR_KEY_PREFIX}${key}`;

const npcData = npcDataRaw as NpcData;
const enemiesData = enemiesDataRaw as EnemiesFile;

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
      for (const [key, ref] of Object.entries(data.interiors ?? {})) {
        this.load.tilemapTiledJSON(interiorTilemapKey(key), `maps/${ref.path}`);
      }
      const shipsManifest = data.ships ?? {};
      for (const vessel of loadShipsFile().defs.values()) {
        for (let h = 0 as Heading; h < 4; h = ((h + 1) as Heading)) {
          const mapKey = `${vessel.tmjPrefix}-${SHIP_HEADINGS[h]}`;
          const ref = shipsManifest[mapKey];
          if (!ref) {
            throw new Error(
              `Ship tilemap '${mapKey}' missing from world manifest — check ships/${mapKey}.tmx exists and the map build ran.`,
            );
          }
          this.load.tilemapTiledJSON(shipTilemapKey(vessel, h), `maps/${ref.path}`);
        }
      }
    });

    {
      // Default outfit layers — variant string matches file basename in
      // public/sprites/character/cf/<layer>-<variant>.png. Only loading the
      // starting outfit eagerly; alternative variants will load on demand
      // when the customizer or equipment system requests them.
      const cfSheets = new Map<string, string>();
      const addSheet = (layer: CfLayer, variant: string) => {
        const key = cfTextureKey(layer, variant);
        if (cfSheets.has(key)) return;
        cfSheets.set(key, `cf/${layer}-${variant}.png`);
      };
      // Default outfit (worn on a fresh character).
      addSheet("base", "default");
      addSheet("hair", "1-brown");
      addSheet("chest", "og-blue");
      addSheet("legs", "og-brown");
      addSheet("feet", "brown");
      addSheet("hands", "bare");
      // Eagerly load every wardrobe variant so the customizer's "Apply" can
      // swap textures without waiting on a download.
      for (const [layer, variants] of Object.entries(CF_WARDROBE_OPTIONS) as [CfLayer, readonly string[]][]) {
        for (const variant of variants) addSheet(layer, variant);
      }
      // Eagerly load every variant referenced by an item's visualLayer so
      // equipping never has to wait on a download. Cheap with our handful of
      // items today; if the catalog grows, switch this to lazy on equip.
      for (const id of ALL_ITEM_IDS) {
        const v = ITEMS[id].visualLayer;
        if (!v) continue;
        // Tool layers don't share the 9×56 grid — they're loaded by sheet
        // below from CF_TOOL_SHEETS, not as `cf-<layer>-<variant>.png`.
        if (v.layer === "tool") continue;
        addSheet(v.layer as CfLayer, v.variant);
      }
      for (const [key, file] of cfSheets) {
        // base.png is named just `base.png` (no variant suffix). Other layers
        // follow `<layer>-<variant>.png`.
        const path = key === cfTextureKey("base", "default") ? "cf/base.png" : file;
        this.load.spritesheet(key, `sprites/character/${path}`, {
          frameWidth: CF_FRAME_SIZE,
          frameHeight: CF_FRAME_SIZE,
        });
      }
      // Tool sheets — each ships its own grid (not the 9×56 layer grid),
      // so they're loaded once here and given a small per-direction anim set
      // in `create()`.
      for (const sheet of Object.values(CF_TOOL_SHEETS)) {
        this.load.spritesheet(sheet.textureKey, `sprites/character/${sheet.file}`, {
          frameWidth: sheet.frameWidth,
          frameHeight: sheet.frameHeight,
        });
      }
    }

    for (const id of ALL_ITEM_IDS) {
      this.load.image(itemIconTextureKey(id), ITEMS[id].icon);
    }

    for (const def of enemiesData.defs) {
      this.load.spritesheet(enemyTextureKey(def.id), def.sprite.sheet, {
        frameWidth: def.sprite.frameWidth,
        frameHeight: def.sprite.frameHeight,
      });
    }

    for (const def of loadNodesFile(nodesDataRaw).defs) {
      if (!def.sprite) continue;
      this.load.spritesheet(nodeSpriteTextureKey(def.id), def.sprite.sheet, {
        frameWidth: def.sprite.frameWidth,
        frameHeight: def.sprite.frameHeight,
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
    try {
      installPlayerSkinCanvases(this.textures);
      const skinId = useSettingsStore.getState().skinTone;
      bakePlayerSkin(this.textures, SKIN_PALETTES[skinId] ?? SKIN_PALETTES.default);
    } catch (err) {
      // Don't block the boot if recolor fails — the player just wears the
      // default sheet pixels. Log so it's visible in devtools.
      console.error("Player skin bake failed:", err);
    }

    // Build the CF animation set on every loaded layer texture. Each layer
    // shares the 9×56 grid, so the same per-state row table works for all
    // of them. A Container of layered sprites all play the same anim key
    // and stay frame-aligned via Phaser's shared anim clock. Skip tool
    // sheets — they have their own grids and are handled below.
    for (const key of this.textures.getTextureKeys()) {
      if (!key.startsWith("cf-")) continue;
      if (key.startsWith("cf-tool-")) continue;
      createCfAnimsForTexture(this, key);
    }
    // Per-tool anims. Each CfToolDef points at a row range inside its
    // texture and gets one anim per direction.
    for (const tool of Object.values(CF_TOOLS)) {
      for (const dir of CF_DIRS) {
        const key = cfToolAnimKey(tool.id, dir);
        if (this.anims.exists(key)) continue;
        const start = tool.rows[dir] * tool.cols;
        this.anims.create({
          key,
          frames: this.anims.generateFrameNumbers(tool.textureKey, {
            start,
            end: start + tool.cols - 1,
          }),
          frameRate: tool.fps,
          repeat: 0,
        });
      }
    }

    for (const def of loadNodesFile(nodesDataRaw).defs) {
      if (!def.sprite) continue;
      const animKey = nodeSpriteAnimKey(def.id);
      if (this.anims.exists(animKey)) continue;
      this.anims.create({
        key: animKey,
        frames: this.anims.generateFrameNumbers(nodeSpriteTextureKey(def.id), {
          start: 0,
          end: def.sprite.frames - 1,
        }),
        frameRate: def.sprite.frameRate,
        repeat: -1,
      });
    }

    // Register NPC animations globally so every scene's reconciler can
    // spawn sprites without re-registering per-scene.
    for (const npc of npcData.npcs) registerNpcAnimations(this, npc);

    this.scene.launch("Systems");
    this.scene.start("World");
  }
}

/**
 * Create the full CF state×direction animation set on a single layer texture.
 * Idempotent — skips keys that already exist. Safe to call after lazy-loading
 * an additional layer variant later in the session.
 */
export function createCfAnimsForTexture(scene: Phaser.Scene, textureKey: string): void {
  for (const state of CF_STATES) {
    const cfg = CF_ANIMS[state];
    for (const dir of CF_DIRS) {
      const key = cfAnimKey(textureKey, state, dir);
      if (scene.anims.exists(key)) continue;
      const range = cfg.dirs[dir];
      const start = range.row * CF_SHEET_COLS;
      scene.anims.create({
        key,
        frames: scene.anims.generateFrameNumbers(textureKey, {
          start,
          end: start + range.cols - 1,
        }),
        frameRate: cfg.fps,
        repeat: cfg.repeat,
      });
    }
  }
}
