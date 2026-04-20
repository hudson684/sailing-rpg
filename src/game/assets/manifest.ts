import * as Phaser from "phaser";
import {
  CHUNK_KEY_PREFIX,
  WORLD_MANIFEST_KEY,
  interiorTilemapKey,
  itemIconTextureKey,
} from "./keys";
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
import {
  enemyAnimTextureKey,
  enemyTextureKey,
  type EnemiesFile,
  type EnemyAnimState,
} from "../entities/enemyTypes";
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
import {
  CF_MOUNTS,
  CF_MOUNT_SHEETS,
  cfMountAnimKey,
  type CfMountState,
} from "../entities/playerMounts";

/**
 * Single source of truth for the game's eager asset loads.
 *
 * Adding a new asset category:
 *   1. Add a `queueXxx(scene)` function below that calls `scene.load.*`.
 *   2. Reference it from `queueAllAssets`.
 *   3. If the assets need anim registration or texture munging at create
 *      time, add a `setupXxx(scene)` and call from `runPostLoadSetup`.
 *
 * Path conventions:
 *   - Assets referenced from TS code can be imported via Vite for
 *     content hashing (see `playerTools.ts` for an example using
 *     `import.meta.url`-resolved sheet paths). New TS-referenced assets
 *     should follow that pattern.
 *   - Assets referenced from JSON data files (npc/enemy/node sprite
 *     paths, item icons authored by data, tileset PNGs referenced by
 *     TMJ files) stay under `public/`. The PWA service worker
 *     CacheFirst-caches them aggressively.
 */

const npcData = npcDataRaw as NpcData;
const enemiesData = enemiesDataRaw as EnemiesFile;

// ─── Preload (queues into scene.load) ────────────────────────────────────

export function queueAllAssets(scene: Phaser.Scene): void {
  queueWorldManifestAndChunks(scene);
  queuePlayerDefaultLayers(scene);
  queueToolSheets(scene);
  queueMountSheets(scene);
  queueItemIcons(scene);
  queueEnemySheets(scene);
  queueNodeSheets(scene);
  queueNpcSheets(scene);
}

/** Loads world.json, then chains: starting-chunk tilesets, all chunk TMJs,
 *  all interior TMJs, and all per-(vessel × heading) ship TMJs. The
 *  remaining (non-starting) chunk tilesets stream in later via
 *  `ChunkManager.streamRemainingChunks` after WorldScene boots. */
function queueWorldManifestAndChunks(scene: Phaser.Scene): void {
  scene.load.json(WORLD_MANIFEST_KEY, "maps/world.json");
  scene.load.on(
    `filecomplete-json-${WORLD_MANIFEST_KEY}`,
    (_k: string, _t: string, data: WorldManifest) => {
      const startKey = `${data.startChunk.cx}_${data.startChunk.cy}`;
      const startTilesets = data.chunkTilesets?.[startKey] ?? data.tilesetImages ?? [];
      for (const imagePath of startTilesets) {
        scene.load.image(tilesetImageKeyFor(imagePath), `maps/${imagePath}`);
      }
      for (const key of data.authoredChunks) {
        scene.load.tilemapTiledJSON(`${CHUNK_KEY_PREFIX}${key}`, `maps/chunks/${key}.tmj`);
      }
      for (const [key, ref] of Object.entries(data.interiors ?? {})) {
        const tilemapKey = interiorTilemapKey(key);
        scene.load.tilemapTiledJSON(tilemapKey, `maps/${ref.path}`);
        // Interior TMJs embed their own tilesets, which are not guaranteed
        // to overlap with any chunk's tileset list (e.g. `Interiors_tilesets.png`
        // is used only inside buildings). Walk the parsed TMJ and queue each
        // referenced image; Phaser's loader dedupes by key.
        scene.load.once(
          `filecomplete-tilemapJSON-${tilemapKey}`,
          (_k: string, _t: string, tmj: { tilesets?: Array<{ image?: string }> }) => {
            for (const ts of tmj.tilesets ?? []) {
              if (!ts.image) continue;
              const imgKey = tilesetImageKeyFor(ts.image);
              if (scene.sys.textures.exists(imgKey)) continue;
              scene.load.image(imgKey, `maps/${ts.image}`);
            }
          },
        );
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
          const tilemapKey = shipTilemapKey(vessel, h);
          scene.load.tilemapTiledJSON(tilemapKey, `maps/${ref.path}`);
          // Ship TMJs embed their own tilesets. The world manifest's
          // `chunkTilesets` only covers chunk tilesets, so the ship's
          // tileset images would otherwise never be queued and
          // `createShipVisual` crashes in `WorldScene.create`. Walk the
          // freshly-parsed TMJ and queue each referenced tileset image;
          // Phaser's loader dedupes by key, so overlaps with chunk
          // tilesets are fine.
          scene.load.once(
            `filecomplete-tilemapJSON-${tilemapKey}`,
            (_k: string, _t: string, tmj: { tilesets?: Array<{ image?: string }> }) => {
              for (const ts of tmj.tilesets ?? []) {
                if (!ts.image) continue;
                const imgKey = tilesetImageKeyFor(ts.image);
                if (scene.sys.textures.exists(imgKey)) continue;
                scene.load.image(imgKey, `maps/${ts.image}`);
              }
            },
          );
        }
      }
    },
  );
}

/** Default outfit layers — variant string matches the file basename in
 *  public/sprites/character/cf/<layer>-<variant>.png. Only the starting
 *  outfit loads eagerly; alternative variants load on demand via
 *  `ensureCfVariantLoaded`. */
function queuePlayerDefaultLayers(scene: Phaser.Scene): void {
  const cfSheets = new Map<string, string>();
  const addSheet = (layer: CfLayer, variant: string) => {
    const key = cfTextureKey(layer, variant);
    if (cfSheets.has(key)) return;
    cfSheets.set(key, `cf/${layer}-${variant}.png`);
  };
  addSheet("base", "default");
  addSheet("hair", "1-brown");
  addSheet("chest", "og-blue");
  addSheet("legs", "og-brown");
  addSheet("feet", "brown");
  addSheet("hands", "bare");
  for (const [key, file] of cfSheets) {
    const path = key === cfTextureKey("base", "default") ? "cf/base.png" : file;
    scene.load.spritesheet(key, `sprites/character/${path}`, {
      frameWidth: CF_FRAME_SIZE,
      frameHeight: CF_FRAME_SIZE,
    });
  }
}

/** Tool sheets — each ships its own grid (not the 9×56 layer grid), so
 *  they're loaded once here and given a small per-direction anim set in
 *  `setupToolAnims`. Sheet `file` paths are Vite-imported URLs (see
 *  `playerTools.ts`), so they're content-hashed and cache-immutable. */
function queueToolSheets(scene: Phaser.Scene): void {
  for (const sheet of Object.values(CF_TOOL_SHEETS)) {
    scene.load.spritesheet(sheet.textureKey, sheet.file, {
      frameWidth: sheet.frameWidth,
      frameHeight: sheet.frameHeight,
    });
  }
}

/** Mount sheets — horses (and future other mounts) ship their own small
 *  grids, separate from both the 9×56 layer grid and the per-tool grids. */
function queueMountSheets(scene: Phaser.Scene): void {
  for (const sheet of Object.values(CF_MOUNT_SHEETS)) {
    scene.load.spritesheet(sheet.textureKey, sheet.file, {
      frameWidth: sheet.frameWidth,
      frameHeight: sheet.frameHeight,
    });
  }
}

function queueItemIcons(scene: Phaser.Scene): void {
  for (const id of ALL_ITEM_IDS) {
    scene.load.image(itemIconTextureKey(id), ITEMS[id].icon);
  }
}

function queueEnemySheets(scene: Phaser.Scene): void {
  for (const def of enemiesData.defs) {
    scene.load.spritesheet(enemyTextureKey(def.id), def.sprite.sheet, {
      frameWidth: def.sprite.frameWidth,
      frameHeight: def.sprite.frameHeight,
    });
    for (const state of Object.keys(def.sprite.anims) as EnemyAnimState[]) {
      const anim = def.sprite.anims[state];
      if (!anim.sheet) continue;
      scene.load.spritesheet(enemyAnimTextureKey(def.id, state), anim.sheet, {
        frameWidth: anim.frameWidth ?? def.sprite.frameWidth,
        frameHeight: anim.frameHeight ?? def.sprite.frameHeight,
      });
    }
  }
}

function queueNodeSheets(scene: Phaser.Scene): void {
  for (const def of loadNodesFile(nodesDataRaw).defs) {
    if (!def.sprite) continue;
    scene.load.spritesheet(nodeSpriteTextureKey(def.id), def.sprite.sheet, {
      frameWidth: def.sprite.frameWidth,
      frameHeight: def.sprite.frameHeight,
    });
  }
}

function queueNpcSheets(scene: Phaser.Scene): void {
  for (const npc of npcData.npcs) {
    const idle = npc.sprite.idle;
    scene.load.spritesheet(npcTextureKey(npc.id, "idle"), idle.sheet, {
      frameWidth: idle.frameWidth,
      frameHeight: idle.frameHeight,
    });
    if (npc.sprite.walk) {
      const walk = npc.sprite.walk;
      scene.load.spritesheet(npcTextureKey(npc.id, "walk"), walk.sheet, {
        frameWidth: walk.frameWidth,
        frameHeight: walk.frameHeight,
      });
    }
  }
}

// ─── Post-load setup (texture baking + anim registration) ────────────────

export function runPostLoadSetup(scene: Phaser.Scene): void {
  bakePlayerSkinSafely(scene);
  setupCfLayerAnims(scene);
  setupToolAnims(scene);
  setupMountAnims(scene);
  setupNodeAnims(scene);
  setupNpcAnims(scene);
}

function bakePlayerSkinSafely(scene: Phaser.Scene): void {
  try {
    installPlayerSkinCanvases(scene.textures);
    const skinId = useSettingsStore.getState().skinTone;
    bakePlayerSkin(scene.textures, SKIN_PALETTES[skinId] ?? SKIN_PALETTES.default);
  } catch (err) {
    // Don't block boot if recolor fails — the player just wears the
    // default sheet pixels. Log so it's visible in devtools.
    console.error("Player skin bake failed:", err);
  }
}

/** Build the CF animation set on every loaded layer texture. Each layer
 *  shares the 9×56 grid, so the same per-state row table works for all
 *  of them. A Container of layered sprites all play the same anim key
 *  and stay frame-aligned via Phaser's shared anim clock. Skip tool
 *  sheets — they have their own grids. */
function setupCfLayerAnims(scene: Phaser.Scene): void {
  for (const key of scene.textures.getTextureKeys()) {
    if (!key.startsWith("cf-")) continue;
    if (key.startsWith("cf-tool-")) continue;
    if (key.startsWith("cf-mount-")) continue;
    createCfAnimsForTexture(scene, key);
  }
}

/** Per-tool anims. Each CfToolDef points at a row range inside its
 *  texture and gets one anim per direction. */
function setupToolAnims(scene: Phaser.Scene): void {
  for (const tool of Object.values(CF_TOOLS)) {
    for (const dir of CF_DIRS) {
      const key = cfToolAnimKey(tool.id, dir);
      if (scene.anims.exists(key)) continue;
      const start = tool.rows[dir] * tool.cols;
      scene.anims.create({
        key,
        frames: scene.anims.generateFrameNumbers(tool.textureKey, {
          start,
          end: start + tool.cols - 1,
        }),
        frameRate: tool.fps,
        repeat: 0,
      });
    }
  }
}

/** Per-mount anims. Idle + gallop × 3 directions for each mount sheet. */
function setupMountAnims(scene: Phaser.Scene): void {
  const states: CfMountState[] = ["idle", "gallop"];
  for (const mount of Object.values(CF_MOUNTS)) {
    for (const state of states) {
      for (const dir of CF_DIRS) {
        const key = cfMountAnimKey(mount.id, state, dir);
        if (scene.anims.exists(key)) continue;
        const range = mount.states[state][dir];
        const start = range.row * mount.sheetCols;
        scene.anims.create({
          key,
          frames: scene.anims.generateFrameNumbers(mount.textureKey, {
            start,
            end: start + range.cols - 1,
          }),
          frameRate: range.fps,
          repeat: -1,
        });
      }
    }
  }
}

function setupNodeAnims(scene: Phaser.Scene): void {
  for (const def of loadNodesFile(nodesDataRaw).defs) {
    if (!def.sprite) continue;
    const animKey = nodeSpriteAnimKey(def.id);
    if (scene.anims.exists(animKey)) continue;
    scene.anims.create({
      key: animKey,
      frames: scene.anims.generateFrameNumbers(nodeSpriteTextureKey(def.id), {
        start: 0,
        end: def.sprite.frames - 1,
      }),
      frameRate: def.sprite.frameRate,
      repeat: -1,
    });
  }
}

/** Register NPC animations globally so every scene's reconciler can spawn
 *  sprites without re-registering per-scene. */
function setupNpcAnims(scene: Phaser.Scene): void {
  for (const npc of npcData.npcs) registerNpcAnimations(scene, npc);
}
