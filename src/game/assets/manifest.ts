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
import {
  charAnimKey,
  charModelManifestKey,
  charModelManifestUrl,
  charSlotSheetUrl,
  charTextureKey,
  npcTextureKey,
  type CharacterModelManifest,
  type NpcData,
  type NpcDef,
} from "../entities/npcTypes";
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
  decorationAnimKey,
  decorationTextureKey,
  loadDecorationsFile,
} from "../world/Decoration";
import decorationsDataRaw from "../data/decorations.json";
import {
  chestOpenAnimKey,
  chestTextureKey,
  loadChestsFile,
} from "../world/Chest";
import chestsDataRaw from "../data/chests.json";
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
  queueDecorationSheets(scene);
  queueChestSheets(scene);
  queueNpcSheets(scene);
  queueCharacterModels(scene);
  queueUiTextures(scene);
}

/** UI textures used by in-world Phaser overlays (e.g. speech bubbles).
 *  HTML UI loads these via CSS `border-image-source` instead. */
function queueUiTextures(scene: Phaser.Scene): void {
  scene.load.image("ui-panel-tan", "ui/panel-tan.png");
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
    // Layered enemies load via queueCharacterModels — skip the legacy path.
    if (!def.sprite) continue;
    scene.load.spritesheet(enemyTextureKey(def.id), def.sprite.sheet, {
      frameWidth: def.sprite.frameWidth,
      frameHeight: def.sprite.frameHeight,
    });
    for (const state of Object.keys(def.sprite.anims) as EnemyAnimState[]) {
      const anim = def.sprite.anims[state];
      if (!anim?.sheet) continue;
      scene.load.spritesheet(enemyAnimTextureKey(def.id, state), anim.sheet, {
        frameWidth: anim.frameWidth ?? def.sprite.frameWidth,
        frameHeight: anim.frameHeight ?? def.sprite.frameHeight,
      });
    }
  }
}

function queueChestSheets(scene: Phaser.Scene): void {
  for (const def of loadChestsFile(chestsDataRaw).defs) {
    scene.load.spritesheet(chestTextureKey(def.id), def.sprite.sheet, {
      frameWidth: def.sprite.frameWidth,
      frameHeight: def.sprite.frameHeight,
    });
  }
}

function queueDecorationSheets(scene: Phaser.Scene): void {
  for (const def of loadDecorationsFile(decorationsDataRaw).defs) {
    scene.load.spritesheet(decorationTextureKey(def.id), def.sprite.sheet, {
      frameWidth: def.sprite.frameWidth,
      frameHeight: def.sprite.frameHeight,
    });
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
    // Layered NPCs load via queueCharacterModels below — skip the legacy
    // single-sheet path for them.
    if (!npc.sprite) continue;
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

/** For every unique character-model referenced by a layered NPC, load the
 *  model.json (which carries frameWidth/frameHeight + per-tag frame counts),
 *  then chain a secondary load that queues every slot-variant spritesheet
 *  the NPCs actually use. The follow-up anim registration runs from
 *  `setupCharacterAnims()` at post-load. */
function queueCharacterModels(scene: Phaser.Scene): void {
  // Both layered NPCs and layered humanoid enemies pull from the same
  // `public/sprites/characters/<model>/` tree — collect every (slot, variant)
  // pair across both sources, load each referenced model.json once, then
  // chain the slot-sheet queue off the manifest completion event.
  const modelUsage = new Map<string, Array<{ slot: string; variant: string }>>();
  const accumulate = (
    layered: { model: string; slots: Record<string, string> } | undefined,
  ) => {
    if (!layered) return;
    const list = modelUsage.get(layered.model) ?? [];
    for (const [slot, variant] of Object.entries(layered.slots)) {
      if (!list.some((e) => e.slot === slot && e.variant === variant)) {
        list.push({ slot, variant });
      }
    }
    modelUsage.set(layered.model, list);
  };
  for (const npc of npcData.npcs) accumulate(npc.layered);
  for (const def of enemiesData.defs) accumulate(def.layered);

  for (const [model, usage] of modelUsage) {
    const manifestKey = charModelManifestKey(model);
    scene.load.json(manifestKey, charModelManifestUrl(model));
    scene.load.once(
      `filecomplete-json-${manifestKey}`,
      (_k: string, _t: string, data: CharacterModelManifest) => {
        for (const { slot, variant } of usage) {
          for (const tag of Object.keys(data.tags)) {
            const textureKey = charTextureKey(model, slot, variant, tag);
            if (scene.sys.textures.exists(textureKey)) continue;
            scene.load.spritesheet(
              textureKey,
              charSlotSheetUrl(model, slot, variant, tag),
              { frameWidth: data.frameWidth, frameHeight: data.frameHeight },
            );
          }
        }
      },
    );
  }
}

// ─── Post-load setup (texture baking + anim registration) ────────────────

export function runPostLoadSetup(scene: Phaser.Scene): void {
  bakePlayerSkinSafely(scene);
  setupCfLayerAnims(scene);
  setupToolAnims(scene);
  setupMountAnims(scene);
  setupNodeAnims(scene);
  setupDecorationAnims(scene);
  setupChestAnims(scene);
  setupNpcAnims(scene);
  setupCharacterAnims(scene);
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
    // Stride = frames per row on the sheet, which is NOT necessarily the
    // action's `cols` (e.g. the fishing rod sheet is 9 wide but the reel
    // animation only uses 8 of those 9 slots per row).
    const stride = tool.sheetCols ?? tool.actions[0]?.cols ?? 1;
    for (const action of tool.actions) {
      for (const dir of CF_DIRS) {
        const key = cfToolAnimKey(tool.id, action.state, dir);
        if (scene.anims.exists(key)) continue;
        const start = action.rows[dir] * stride;
        scene.anims.create({
          key,
          frames: scene.anims.generateFrameNumbers(tool.textureKey, {
            start,
            end: start + action.cols - 1,
          }),
          frameRate: action.fps,
          repeat: 0,
        });
      }
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

function setupDecorationAnims(scene: Phaser.Scene): void {
  for (const def of loadDecorationsFile(decorationsDataRaw).defs) {
    const animKey = decorationAnimKey(def.id);
    if (scene.anims.exists(animKey)) continue;
    scene.anims.create({
      key: animKey,
      frames: scene.anims.generateFrameNumbers(decorationTextureKey(def.id), {
        start: 0,
        end: def.sprite.frames - 1,
      }),
      frameRate: def.sprite.frameRate,
      repeat: -1,
    });
  }
}

function setupChestAnims(scene: Phaser.Scene): void {
  for (const def of loadChestsFile(chestsDataRaw).defs) {
    const animKey = chestOpenAnimKey(def.id);
    if (scene.anims.exists(animKey)) continue;
    scene.anims.create({
      key: animKey,
      frames: scene.anims.generateFrameNumbers(chestTextureKey(def.id), {
        start: 0,
        end: def.sprite.frames - 1,
      }),
      frameRate: def.sprite.frameRate,
      repeat: 0,
    });
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
 *  sprites without re-registering per-scene. Legacy single-sheet NPCs only —
 *  layered NPCs register via setupCharacterAnims(). */
function setupNpcAnims(scene: Phaser.Scene): void {
  for (const npc of npcData.npcs) {
    if (!npc.sprite) continue;
    registerNpcAnimations(scene, npc);
  }
}

/** Register one animation per (model, slot, variant, state) for every
 *  layered NPC referenced in npcs.json. Each slot-variant's sheet has N
 *  frames per tag (per the model.json), so the anim runs 0..N-1 at the
 *  per-tag frameRate. CharacterSprite plays each child with its own key;
 *  because every slot-variant for a model has the same frame count and
 *  frameRate, the slots stay frame-aligned in practice. */
function setupCharacterAnims(scene: Phaser.Scene): void {
  const seen = new Set<string>();
  // Combat tags play once (attack swings, hurt flashes, death animations);
  // idle/walk loop forever. Anything else defaults to loop so idle fallbacks
  // don't freeze on their last frame.
  const oneShotTags = new Set(["sword", "attack", "hurt", "death"]);
  const registerFor = (layered: { model: string; slots: Record<string, string> }) => {
    const manifest = scene.cache.json.get(charModelManifestKey(layered.model)) as
      | CharacterModelManifest
      | undefined;
    if (!manifest) return;
    for (const [slot, variant] of Object.entries(layered.slots)) {
      for (const [tag, cfg] of Object.entries(manifest.tags)) {
        const key = charAnimKey(layered.model, slot, variant, tag);
        if (seen.has(key)) continue;
        seen.add(key);
        if (scene.anims.exists(key)) scene.anims.remove(key);
        const textureKey = charTextureKey(layered.model, slot, variant, tag);
        if (!scene.textures.exists(textureKey)) continue;
        scene.anims.create({
          key,
          frames: scene.anims.generateFrameNumbers(textureKey, {
            start: 0,
            end: Math.max(0, cfg.frames - 1),
          }),
          frameRate: cfg.frameRate,
          repeat: oneShotTags.has(tag) ? 0 : -1,
        });
      }
    }
  };
  for (const npc of npcData.npcs) if (npc.layered) registerFor(npc.layered);
  for (const def of enemiesData.defs) if (def.layered) registerFor(def.layered);
}

// Unused imports surface as TS errors; keep NpcDef reachable even though
// we only reference it transiently above for the typed manifest payload.
export type { NpcDef };
