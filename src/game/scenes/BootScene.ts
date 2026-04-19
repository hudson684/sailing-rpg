import * as Phaser from "phaser";
import { tilesetImageKeyFor, type WorldManifest } from "../world/chunkManager";
import {
  SHIP_HEADINGS,
  loadShipsFile,
  shipTilemapKey,
} from "../entities/vessels";
import type { Heading } from "../entities/Ship";
import {
  CF_DIRS,
  CF_FRAME_SIZE,
  cfTextureKey,
  createCfAnimsForTexture,
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
import { putCachedBitmap, takeWarmBitmap } from "../assets/bitmapCache";

export const itemIconTextureKey = (id: string) => `item_icon_${id}`;

/**
 * Try to adopt a tileset image from the IDB bitmap cache, registering it
 * directly on Phaser's texture manager. Returns true on hit, in which case
 * the caller should skip queueing the `load.image()` call.
 */
function adoptCachedTileset(scene: Phaser.Scene, imagePath: string): boolean {
  const bm = takeWarmBitmap(imagePath);
  if (!bm) return false;
  const key = tilesetImageKeyFor(imagePath);
  if (scene.sys.textures.exists(key)) return true;
  // Phaser's texture upload path accepts anything drawable; a canvas wrapper
  // is the safest cross-version path since `addImage` is typed for
  // HTMLImageElement but GL uploads ImageBitmap fine via drawImage.
  const canvas = document.createElement("canvas");
  canvas.width = bm.width;
  canvas.height = bm.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(bm, 0, 0);
  scene.sys.textures.addCanvas(key, canvas);
  return true;
}

/**
 * After Phaser finishes loading a tileset image, hand the source off to the
 * IDB bitmap cache for future cold starts. Fire-and-forget; errors ignored.
 */
export function persistLoadedTileset(scene: Phaser.Scene, imagePath: string): void {
  const key = tilesetImageKeyFor(imagePath);
  const tex = scene.sys.textures.get(key);
  const source = tex?.getSourceImage?.(0) as CanvasImageSource | undefined;
  if (!source) return;
  void putCachedBitmap(imagePath, source);
}

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
      // Eager: only the starting chunk's tileset images. Tilesets for the
      // remaining authored chunks stream in after WorldScene boots — see
      // `ChunkManager.streamRemainingChunks`. Falls back to all images if
      // the per-chunk metadata is unavailable (older manifests).
      const startKey = `${data.startChunk.cx}_${data.startChunk.cy}`;
      const startTilesets = data.chunkTilesets?.[startKey] ?? data.tilesetImages ?? [];
      for (const imagePath of startTilesets) {
        // Fast path: adopt a cached ImageBitmap if warmBitmapCache found one.
        // Miss path: queue a normal image load and persist after it completes.
        if (adoptCachedTileset(this, imagePath)) continue;
        const key = tilesetImageKeyFor(imagePath);
        this.load.image(key, `maps/${imagePath}`);
        this.load.once(`filecomplete-image-${key}`, () => {
          persistLoadedTileset(this, imagePath);
        });
      }
      // Chunk TMJs are small JSON; load them all so spawns (items, doors)
      // can be parsed up front without waiting for tilesets.
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
      // Default outfit only (worn on a fresh character). Alternate wardrobe
      // variants and item-driven visualLayer sheets load lazily via
      // `ensureCfVariantLoaded` — see src/game/entities/playerWardrobe.ts.
      addSheet("base", "default");
      addSheet("hair", "1-brown");
      addSheet("chest", "og-blue");
      addSheet("legs", "og-brown");
      addSheet("feet", "brown");
      addSheet("hands", "bare");
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
