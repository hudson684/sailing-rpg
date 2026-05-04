import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import {
  bus,
  type DialogueAction,
  type InventoryAction,
} from "../bus";
import { ALL_ITEM_IDS, ITEMS } from "../inventory/items";
import { ALL_JOB_IDS, type JobId } from "../jobs/jobs";
import { useGameStore } from "../store/gameStore";
import { useShopStore } from "../store/shopStore";
import { setHud, showToast } from "../../ui/store/ui";
import {
  Player,
  PLAYER_FEET_WIDTH,
  PLAYER_FEET_HEIGHT,
  PLAYER_FEET_OFFSET_Y,
  getOrCreatePlayerModel,
  type Facing,
} from "../entities/Player";
import { bindPlayerVisualSubscriptions } from "../entities/playerEquipmentVisuals";
import { MovementController } from "../player/MovementController";
import { stamina, STAMINA_MAX } from "../player/stamina";
import { foodRegen } from "../player/foodRegen";
import {
  Ship,
  SHIP_MAX_SPEED,
  normalizeAngle,
  type DockedPose,
  type Heading,
} from "../entities/Ship";
import { loadShipsFile, type ShipInstanceData, type VesselTemplate } from "../entities/vessels";
import { Wind } from "../entities/wind";
import type { VirtualKey } from "../input/virtualInput";
import { bindSceneToVirtualInput } from "../input/virtualInputBridge";

const MOUNT_SPEED_MULT = 2;

const HEADING_TO_FACING: Record<Heading, Facing> = {
  0: "up",
  1: "right",
  2: "down",
  3: "left",
};
import { loadWorld, type WorldMap } from "../world/worldMap";
import {
  type DoorSpawn,
  type ItemSpawn,
  type TorchSpawn,
} from "../world/spawns";
import { portalRegistry } from "../sim/portals";
import { spawnDispatcher } from "../sim/planner/spawnDispatcher";
import { residences } from "../sim/planner/residences";
import { reconcileAllStaffAgents } from "../business/staff/staffAgentBootstrap";
import {
  businessArrivalAnchorKey,
  worldAnchors,
} from "../sim/planner/anchors";
import { businessIdForInteriorKey } from "../business/registry";
import { type WorldManifest } from "../world/chunkManager";
import { BeachFootprintController, BEACH_WALK_ENABLED } from "../world/beachFootprints";
import type { InteriorReturnData } from "./InteriorScene";
import { findAnchorPose } from "../util/anchor";
import {
  CHUNK_KEY_PREFIX,
  WORLD_MANIFEST_KEY,
} from "../assets/keys";
import { NpcSprite, NPC_INTERACT_RADIUS } from "../entities/NpcSprite";
import { CharacterSprite } from "../entities/CharacterSprite";
import { charModelManifestKey, type CharacterModelManifest } from "../entities/npcTypes";
import { NpcModel } from "../entities/NpcModel";
import { SpriteReconciler } from "../entities/SpriteReconciler";
import { entityRegistry } from "../entities/registry";
import type { MapId } from "../entities/mapId";
import { worldTicker } from "../entities/WorldTicker";
import { SceneNpcBinder } from "../world/sceneNpcBinder";
import { clearNpcs, bootstrapNpcs } from "../entities/npcBootstrap";
import { reapplyScheduledAgentsFromDefs } from "../entities/agentBinding";
import { SKIN_PALETTES, bakePlayerSkin, type SkinPaletteId } from "../entities/playerSkin";
import {
  type NpcData,
  type DialogueDef,
} from "../entities/npcTypes";
import npcDataRaw from "../data/npcs.json";
import cutsceneDataRaw from "../data/cutscenes.json";
import {
  CutsceneDirector,
  type CutsceneActor,
  type CutsceneHost,
} from "../cutscenes/CutsceneDirector";
import type { CutsceneData, CutsceneFacing } from "../cutscenes/types";
import { DebugOverlays, type OverlayName } from "../debug/DebugOverlays";
import { ZoomController } from "../camera/ZoomController";
import { DayNightLighting } from "../time/dayNightLighting";
import { ensureQuestSubsystem, getPredicateContext } from "../quests/activeQuestManager";
import { SpawnGateRegistry } from "../world/spawnGating";
import type { PredicateContext } from "../quests/predicates";
import { GroundItemsState } from "../world/groundItemsState";
import { getBootedSaveController } from "../save/bootSave";
import {
  GatheringNode,
  NODE_INTERACT_RADIUS,
  indexDefs,
  loadNodesFile,
} from "../world/GatheringNode";
import nodesDataRaw from "../data/nodes.json";
import { Decoration, loadDecorationsFile } from "../world/Decoration";
import decorationsDataRaw from "../data/decorations.json";
import {
  CHEST_INTERACT_RADIUS,
  Chest,
  chestLootedFlagKey,
  loadChestsFile,
  rollChestLoot,
} from "../world/Chest";
import chestsDataRaw from "../data/chests.json";
import {
  BUSINESS_SIGN_INTERACT_RADIUS,
  BusinessSign,
  loadBusinessSignsFile,
} from "../world/BusinessSign";
import businessSignsDataRaw from "../data/businessSigns.json";
import { businesses as businessRegistry } from "../business/registry";
import { useBusinessStore } from "../business/businessStore";
import type { DialogueChoiceOption } from "../bus";
import { useChestStore } from "../store/chestStore";
import type {
  ChestTakeAllRequest,
  ChestTakeRequest,
} from "../bus";
import { getFlagStore } from "../quests/activeQuestManager";
import { addToSlots } from "../inventory/operations";
import playerSpawnRaw from "../data/playerSpawn.json";
import {
  CraftingStation,
  STATION_INTERACT_RADIUS,
} from "../world/CraftingStation";
import {
  craftingStations,
  craftingStationInstances,
} from "../crafting/stations";
import type { CraftingStationInstanceData } from "../crafting/types";
import { recipes as recipeRegistry } from "../crafting/recipes";
import { applyCraft, hasAllInputs } from "../crafting/operations";
import type { RecipeDef } from "../crafting/types";
import { useCraftingStore } from "../store/craftingStore";
import type {
  CraftingBeginRequest,
  CraftingCompleteResult,
} from "../bus";
import { Enemy, registerEnemyAnimations } from "../entities/Enemy";
import type {
  EnemiesFile,
  EnemyDef,
  EnemyInstanceData,
} from "../entities/enemyTypes";
import enemiesDataRaw from "../data/enemies.json";
import { GameplayScene } from "./GameplayScene";
import itemInstancesRaw from "../data/itemInstances.json";
import type { NodeDef, NodeInstanceData } from "../world/GatheringNode";
import type { ItemId } from "../inventory/items";
import { spawnFloatingNumber } from "../fx/floatingText";
import { FishingSession } from "../fishing/fishingSession";
import { bobberOffsetPx, type FishingSurface } from "../fishing/fishingSurface";
import {
  SaveController,
  SceneState,
  systems as saveSystems,
  type SaveEnvelope,
} from "../save";
import { setActiveSaveController } from "../save/activeController";
import { PREFETCHED_SAVE_REGISTRY_KEY } from "./PreloadScene";
import { getPrefetchedEnvelope, getSavedPlayerSpawn } from "../save/storeHydrate";

const HELM_INTERACT_RADIUS = TILE_SIZE * 0.7;
const SHOP_CLICK_RADIUS = TILE_SIZE * 1.5;
/** Per-step cost multiplier the NPC pathfinder applies when entering a tile
 *  that is *not* on the authored road network ("ground" tile layer). Road
 *  tiles use the baseline cost of 1, so the heuristic stays admissible.
 *  At 1.5, NPCs accept roughly a 50% detour to stay on roads but still cut
 *  across off-road terrain when the detour would be longer than that. */
const ROAD_OFFROAD_COST = 1.5;
/** Time after last damage before player HP regen kicks in. */
/** Tile where a new game drops the player. Authored in
 *  `src/game/data/playerSpawn.json` and movable via the spawn editor.
 *  Loaded saves override this via the hydrated player position. */
const DEFAULT_PLAYER_SPAWN_TILE = {
  x: (playerSpawnRaw as { instance: { tileX: number; tileY: number } }).instance.tileX,
  y: (playerSpawnRaw as { instance: { tileX: number; tileY: number } }).instance.tileY,
} as const;


interface ItemInstancesFile {
  instances: Array<{
    id: string;
    itemId: string;
    quantity: number;
    tileX: number;
    tileY: number;
    /** Defaults to "world" when absent. */
    map?: string;
  }>;
}

interface EditorItemData {
  id: string;
  itemId: ItemId;
  quantity: number;
  tileX: number;
  tileY: number;
}

let activeWorldScene: WorldScene | null = null;

export class WorldScene extends GameplayScene {
  private world!: WorldMap;
  /** All ship instances, keyed by instance id. */
  private ships = new Map<string, Ship>();
  /** Cached vessel defs (for edit-mode placement and respawn). */
  private shipDefs = new Map<string, VesselTemplate>();
  /** Initial instance list from ships.json (for resetting on new game). */
  private shipInstanceData: ShipInstanceData[] = [];
  /** Ship the player is currently piloting / anchoring aboard. */
  private activeShip: Ship | null = null;
  /** Global wind. Fresh each session (not persisted) — a random starting
   *  direction on load is part of the charm and avoids a "stuck" wind. */
  private readonly wind = new Wind();
  private readonly groundItemsState = new GroundItemsState();
  /** Game-scoped drop store — created in `bootSaveController` and shared
   *  with InteriorScene. Filtered by mapId when rendering sprites. */
  private droppedExpiryAccum = 0;
  private readonly sceneState = new SceneState();
  // Assigned in create() from the game-scoped controller booted behind the
  // title. Marked `!` because TS can't see create() as a constructor.
  private saveController!: SaveController;
  private doors: DoorSpawn[] = [];
  private pendingTorches: TorchSpawn[] = [];
  private registeredTorchUids = new Set<string>();
  private lastDoorTile: { x: number; y: number } | null = null;
  /** Accumulated authored item spawns from every chunk that has been
   *  instantiated so far. Populated incrementally via the ChunkManager's
   *  `onChunkReady` callback, so a new entry appears whenever a streamed
   *  chunk finishes loading its tilesets. */
  private authoredItems: ItemSpawn[] = [];
  /** True once `respawnGroundItems()` has run for the first time in this
   *  scene life. Before that, chunk-ready callbacks skip per-item sprite
   *  creation because the initial tear-down-and-rebuild will do it in bulk. */
  private initialGroundItemsBuilt = false;
  private nodes: GatheringNode[] = [];
  private decorations: Decoration[] = [];
  private craftingStations: CraftingStation[] = [];
  private chests: Chest[] = [];
  /** Mirror of chests.json instances so editor mutations can round-trip on export. */
  private chestInstanceData: Array<{ id: string; defId: string; tileX: number; tileY: number }> = [];
  /** Pre-rolled loot for chests still pending interaction. Cleared on take-all. */
  private chestPendingLoot = new Map<string, Array<{ itemId: ItemId; qty: number }>>();
  private signs: BusinessSign[] = [];
  private stationInstanceData: CraftingStationInstanceData[] = [];
  /** Owns scene-local sprites for world-mapped NPC models. Interior NPC
   *  sprites are owned by InteriorScene's own reconciler. */
  private npcReconciler!: SpriteReconciler<NpcSprite | CharacterSprite>;
  /** Bridge between the global NpcRegistry and this scene. Drives Wander/
   *  Patrol activities live and mirrors agent body state onto NpcModels
   *  for the reconciler to render. */
  private npcBinder!: SceneNpcBinder;
  /** Cached NPC data used for edit-mode templates and export. The registry
   *  is source-of-truth for runtime state; this stays for authoring flows. */
  private npcData: NpcData = npcDataRaw as NpcData;
  private dialogues: Record<string, DialogueDef> = {};
  private activeDialogue: {
    speaker: string;
    pages: string[];
    page: number;
    shopId?: string;
    choices?: DialogueChoiceOption[];
    onSelect?: (index: number) => void;
  } | null = null;
  /** Director for scripted scenes. Created in `create`, drives NPCs/player
   *  via setPositionPx + setFacing while it's running. */
  private cutsceneDirector!: CutsceneDirector;
  private cutsceneData: CutsceneData = cutsceneDataRaw as CutsceneData;
  private onCutscenePlay = (payload: { id: string }) => {
    void this.playCutsceneById(payload.id);
  };

  /** Authored ground items from itemInstances.json (loaded on boot). */
  private editorItems = new Map<string, EditorItemData>();
  /** Cached defs available at runtime. */
  private enemyDefs = new Map<string, EnemyDef>();
  private nodeDefs = new Map<string, NodeDef>();
  /** Coconuts shaken off each palm by a bare-handed Q. Cap is the def's HP;
   *  when reached, the palm is swapped to its bare variant for ~2 minutes. */
  private palmShakeCounts = new WeakMap<GatheringNode, number>();

  private zoom!: ZoomController;
  lighting!: DayNightLighting;
  private movement!: MovementController;
  private footprints!: BeachFootprintController;

  private debug!: DebugOverlays;

  private keys!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    w: Phaser.Input.Keyboard.Key;
    a: Phaser.Input.Keyboard.Key;
    s: Phaser.Input.Keyboard.Key;
    d: Phaser.Input.Keyboard.Key;
    interact: Phaser.Input.Keyboard.Key;
    attack: Phaser.Input.Keyboard.Key;
    debugGrant: Phaser.Input.Keyboard.Key;
    debugXp: Phaser.Input.Keyboard.Key;
    quicksave: Phaser.Input.Keyboard.Key;
    quickload: Phaser.Input.Keyboard.Key;
    sprint: Phaser.Input.Keyboard.Key;
    reverse: Phaser.Input.Keyboard.Key;
    mount: Phaser.Input.Keyboard.Key;
    reefSail: Phaser.Input.Keyboard.Key;
    easeSail: Phaser.Input.Keyboard.Key;
  };

  private unsubVirtualInput: (() => void) | null = null;

  private sailingXpAccum = 0;
  private wasBeached = false;
  private wasBlocked = false;

  private onDialogueAction = (action: DialogueAction) => {
    if (!this.activeDialogue) return;
    if (action.type === "close") {
      this.closeDialogue();
      return;
    }
    if (action.type === "select") {
      const handler = this.activeDialogue.onSelect;
      if (handler) {
        const index = action.index;
        this.closeDialogue();
        handler(index);
      }
      return;
    }
    // advance — block while waiting on a choice so E doesn't dismiss.
    if (this.activeDialogue.choices && this.activeDialogue.choices.length > 0) {
      return;
    }
    this.activeDialogue.page += 1;
    if (this.activeDialogue.page >= this.activeDialogue.pages.length) {
      this.closeDialogue();
    } else {
      this.emitDialogue();
    }
  };

  private onSkinApply = (paletteId: SkinPaletteId) => {
    console.log("[skin] WorldScene received apply →", paletteId);
    bakePlayerSkin(this.textures, SKIN_PALETTES[paletteId] ?? SKIN_PALETTES.default);
  };

  private onInventoryAction = (action: InventoryAction) => {
    const store = useGameStore.getState();
    if (action.type === "move") {
      store.inventoryMove(action.from, action.to);
    } else if (action.type === "drop") {
      const slot = store.inventory.slots[action.slot];
      if (!slot) return;
      const { itemId } = slot;
      const removed = store.inventoryRemoveAt(action.slot, Number.MAX_SAFE_INTEGER);
      if (removed > 0) {
        const entry = this.droppedItemsState.add(
          itemId,
          removed,
          this.player.x,
          this.player.y,
          "world",
        );
        this.spawnDroppedSprite(entry);
        showToast(`Dropped ${removed} ${ITEMS[itemId].name}.`, 1500);
      }
    }
  };

  constructor() {
    super("World");
  }

  create() {
    const phase = import.meta.env.DEV
      ? (label: string, fn: () => void) => {
          const key = `[WorldScene.create] ${label}`;
          console.time(key);
          fn();
          console.timeEnd(key);
        }
      : (_label: string, fn: () => void) => fn();
    const createStart = import.meta.env.DEV ? performance.now() : 0;

    // The SaveController was booted + store-only systems were hydrated behind
    // the title, so inventory/equipment/wardrobe/etc. stores are already
    // populated. Rebind the scene-specific hooks before anything that could
    // trigger an autosave or onApplied callback.
    const booted = getBootedSaveController(this.game);
    if (!booted) throw new Error("SaveController was not booted before World");
    this.saveController = booted;
    this.saveController.setSceneHooks({
      getSceneKey: () => "World",
      onApplied: (env) => this.applyAfterLoad(env),
      canAutosave: () => this.sceneState.mode !== "Anchoring",
    });
    setActiveSaveController(this.saveController);

    const manifest = this.cache.json.get(WORLD_MANIFEST_KEY) as WorldManifest;
    // Spawns arrive as chunks instantiate — once synchronously here for every
    // chunk whose tilesets were in the eager preload batch, and again later
    // for each streamed chunk in `streamRemainingChunks`. Append to
    // scene-level lists and (when the initial rebuild is done) drop each
    // new authored item into the world as its own sprite.
    this.doors = [];
    this.authoredItems = [];
    // Portals + sim-layer spawn anchors are rebuilt from spawn data on every
    // world load — clear any stale entries (e.g. from a prior session in the
    // same tab) so the chunk-ready callbacks below re-register a clean set.
    portalRegistry.clear();
    worldAnchors.clear();
    spawnDispatcher.clearSpawnPoints();
    residences.clear();
    phase("loadWorld (eager chunks)", () => {
      this.world = loadWorld({
        scene: this,
        manifest,
        chunkKeyPrefix: CHUNK_KEY_PREFIX,
        onChunkReady: (_chunk, spawns) => {
          this.doors.push(...spawns.doors);
          this.authoredItems.push(...spawns.items);
          for (const door of spawns.doors) {
            // Prefer the manifest's authoritative entry (extracted at build
            // time from the interior's `interior_entry` Tiled object); fall
            // back to the door's stale `entryTx/entryTy` only when absent.
            // Without this, tourists' GoTo legs were landing on the door's
            // legacy field — which can be off the interior tilemap entirely.
            const meta = manifest.interiors?.[door.interiorKey];
            const entryTx = meta?.entry?.tileX ?? door.entryTx;
            const entryTy = meta?.entry?.tileY ?? door.entryTy;
            portalRegistry.registerDoor({
              worldSceneKey: "chunk:world",
              worldTile: { x: door.tileX, y: door.tileY },
              interiorKey: door.interiorKey,
              entryTile: { x: entryTx, y: entryTy },
            });
            // Sim-layer anchor for schedule templates that target this
            // interior. Registered under the interior key and (when the door
            // belongs to an authored business) the business id, so schedules
            // can address either name interchangeably.
            const arrival = {
              sceneKey: `interior:${door.interiorKey}` as const,
              tileX: entryTx,
              tileY: entryTy,
              facing: "down" as const,
            };
            worldAnchors.set(businessArrivalAnchorKey(door.interiorKey), arrival);
            const bizId = businessIdForInteriorKey(door.interiorKey);
            if (bizId) worldAnchors.set(businessArrivalAnchorKey(bizId), arrival);
          }
          for (const sp of spawns.npcSpawnPoints) {
            spawnDispatcher.registerSpawnPoint(sp.spawnGroupId, {
              sceneKey: "chunk:world",
              tileX: sp.tileX,
              tileY: sp.tileY,
              facing: "down",
            });
          }
          for (const r of spawns.npcResidences) {
            residences.set(r.hireableId, {
              sceneKey: "chunk:world",
              tileX: r.tileX,
              tileY: r.tileY,
              facing: "down",
            });
          }
          // Phase 8: re-reconcile staff agents now that this chunk's
          // residences + business arrival anchors are registered. No-op when
          // the registry-staff flag is off.
          reconcileAllStaffAgents();
          if (this.initialGroundItemsBuilt) {
            for (const s of spawns.items) this.addGroundItemSprite(s, "authored");
          }
          if (this.lighting) {
            for (const t of spawns.torches) this.spawnTorch(t);
          } else {
            this.pendingTorches.push(...spawns.torches);
          }
        },
      });
    });

    phase("player spawn", () => {
      // Prefer the saved player position from the prefetched envelope so the
      // first rendered frame places the Player at the correct spot — otherwise
      // we'd spawn at the default tile and then teleport once playerSaveable
      // hydrated, which is visible to the user as a stutter.
      const prefetchedEnv = getPrefetchedEnvelope(this.game);
      const savedSpawn = getSavedPlayerSpawn(prefetchedEnv);
      const spawnPx = savedSpawn ?? {
        x: (DEFAULT_PLAYER_SPAWN_TILE.x + 0.5) * TILE_SIZE,
        y: (DEFAULT_PLAYER_SPAWN_TILE.y + 0.5) * TILE_SIZE,
      };
      // Model is shared across scenes (registry-owned, survives sleep/wake);
      // the sprite is scene-local and torn down on shutdown.
      const playerModel = getOrCreatePlayerModel({ x: spawnPx.x, y: spawnPx.y });
      entityRegistry.setMap(playerModel.id, { kind: "world" });
      this.player = new Player(this, playerModel);
    });

    phase("ships", () => {
      const shipsFile = loadShipsFile();
      this.shipDefs = shipsFile.defs;
      this.shipInstanceData = shipsFile.instances.map((i) => ({ ...i }));
      for (const inst of this.shipInstanceData) {
        this.spawnShip(inst);
      }
    });

    phase("setupCombat", () => this.setupCombat());
    phase("loadEditorItems", () => this.loadEditorItems());
    phase("respawnGroundItems", () => this.respawnGroundItems());
    // Initialize the quest subsystem eagerly so that spawn gating
    // (Phase 7) sees the PredicateContext. `ensureQuestSubsystem` is
    // idempotent; `initSave` calls it again later and reuses the
    // same singletons.
    let questCtx!: ReturnType<typeof getPredicateContext>;
    phase("ensureQuestSubsystem", () => {
      const { flags: _flags } = ensureQuestSubsystem();
      void _flags;
      questCtx = getPredicateContext();
    });
    // Populate the registry before subscribing the reconciler so it picks up
    // existing models via getByMap with this live scene, instead of being
    // triggered by registry mutations from outside the scene lifecycle.
    phase("bootstrapNpcs", () => bootstrapNpcs(this.npcData, questCtx));
    phase("setupNpcReconciler", () => this.setupNpcReconciler());
    phase("spawnGatheringNodes", () => this.spawnGatheringNodes(questCtx));
    phase("spawnDecorations", () => this.spawnDecorations());
    phase("spawnCraftingStations", () => this.spawnCraftingStations(questCtx));
    phase("spawnChests", () => this.spawnChests());
    phase("spawnBusinessSigns", () => this.spawnBusinessSigns());
    phase("spawnEnemies", () => this.spawnEnemies(questCtx));
    // Ocean-blue backdrop for any viewport area outside authored chunks.
    this.cameras.main.setBackgroundColor("#1f4d78");
    const b = this.world.bounds;
    this.cameras.main.setBounds(
      b.minTx * TILE_SIZE,
      b.minTy * TILE_SIZE,
      (b.maxTx - b.minTx) * TILE_SIZE,
      (b.maxTy - b.minTy) * TILE_SIZE,
    );
    this.cameras.main.startFollow(this.player.sprite, true, 0.15, 0.15);
    this.zoom = new ZoomController(this);
    this.lighting = new DayNightLighting();
    this.lighting.attach(this, this.cameras.main);
    this.flushPendingTorches();

    // Keep the camera viewport in sync with the canvas when it resizes
    // (window resize, orientation change, mobile URL-bar collapse). Without
    // this the main camera stays at its initial size and anything past it
    // renders as the WebGL clear colour (black).
    this.scale.on("resize", this.onScaleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off("resize", this.onScaleResize, this);
    });
    this.events.on(Phaser.Scenes.Events.SLEEP, () => {
      this.fishingSession?.cancel("scene");
      this.fishingSession = null;
    });
    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.fishingSession?.cancel("scene");
      this.fishingSession = null;
    });

    // Stream remaining chunk tilesets in the background; pending chunks pop in
    // as their assets arrive. Keeps the post-character-creation wait short by
    // letting the player into the start chunk before the rest of the world's
    // tileset PNGs are downloaded.
    this.world.manager.streamRemainingChunks();

    this.keys = {
      up: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      left: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      right: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      w: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      a: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      s: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      d: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      interact: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.E),
      attack: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.Q),
      debugGrant: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.G),
      debugXp: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.X),
      quicksave: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F5),
      quickload: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F9),
      sprint: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT),
      reverse: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.R),
      mount: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.M),
      // Sail trim: Shift eases out (more canvas = faster), Ctrl reefs in
      // (less canvas = slower). Shift also drives on-foot sprint; having
      // two named Keys bound to the same physical key is fine — they're
      // used in different modes.
      reefSail: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.CTRL),
      easeSail: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT),
    };

    this.input.keyboard!.addCapture([
      Phaser.Input.Keyboard.KeyCodes.SHIFT,
      Phaser.Input.Keyboard.KeyCodes.CTRL,
      Phaser.Input.Keyboard.KeyCodes.UP,
      Phaser.Input.Keyboard.KeyCodes.DOWN,
      Phaser.Input.Keyboard.KeyCodes.LEFT,
      Phaser.Input.Keyboard.KeyCodes.RIGHT,
    ]);

    // Helm-mode keys alias the sailing controls (WASD / Shift / R / E) so a
    // single update path handles both keyboard and touch input.
    const virtualKeyMap: Record<VirtualKey, Phaser.Input.Keyboard.Key> = {
      up: this.keys.up,
      down: this.keys.down,
      left: this.keys.left,
      right: this.keys.right,
      attack: this.keys.attack,
      interact: this.keys.interact,
      sprint: this.keys.sprint,
      mount: this.keys.mount,
      helmN: this.keys.w,
      helmE: this.keys.d,
      helmS: this.keys.s,
      helmW: this.keys.a,
      // ThrottleUp = ease out sail (more canvas); ThrottleDown = reef in
      // (less canvas). Dedicated bracket keys keep WASD/R free for
      // steering and the mobile touch buttons route through the same pair.
      helmThrottleUp: this.keys.easeSail,
      helmThrottleDown: this.keys.reefSail,
      helmAnchor: this.keys.interact,
    };
    this.unsubVirtualInput = bindSceneToVirtualInput(this, virtualKeyMap);

    this.keys.interact.on("down", () => this.onInteract());

    // Right-click opens a shop when the click lands on (or near) an NPC with
    // a `shopId`. Suppress the native browser context menu so the game owns
    // that gesture.
    this.input.mouse?.disableContextMenu();
    this.input.on(
      "pointerdown",
      (pointer: Phaser.Input.Pointer) => {
        if (pointer.leftButtonDown()) {
          this.onLeftClick(pointer.worldX, pointer.worldY);
          return;
        }
        if (!pointer.rightButtonDown()) return;
        this.onRightClick(pointer.worldX, pointer.worldY);
      },
    );
    // Q-attack and hotbar 1–5 are wired by `setupCombat()` in the base.
    this.keys.debugGrant.on("down", () => this.grantRandomItem());
    this.keys.debugXp.on("down", () => this.grantDebugXp());
    this.keys.quicksave.on("down", () => void this.saveController.save("quicksave"));
    this.keys.quickload.on("down", () => void this.saveController.load("quicksave"));
    this.keys.mount.on("down", () => this.toggleMount());

    this.movement = new MovementController({
      keys: this.keys,
      player: this.player,
      isWalkablePx: (px, py) => this.isWalkablePx(px, py),
      slopeAtPx: (px, py) => this.world.manager.slopeAtPx(px, py),
      isMounted: () => this.player.mounted,
      mountSpeedMult: MOUNT_SPEED_MULT,
    });

    this.footprints = new BeachFootprintController(this.world.manager);

    this.debug = new DebugOverlays(this, this.world, {
      getShipPose: () =>
        this.activeShip
          ? {
              x: this.activeShip.x,
              y: this.activeShip.y,
              rotation: this.activeShip.rotation,
              dims: this.activeShip.dims,
            }
          : null,
      isAtHelm: () => this.sceneState.mode === "AtHelm",
      getPlayerHitbox: () =>
        this.player
          ? {
              cx: this.player.x,
              cy: this.player.y + PLAYER_FEET_OFFSET_Y,
              w: PLAYER_FEET_WIDTH,
              h: PLAYER_FEET_HEIGHT,
              originY: this.player.y,
            }
          : null,
      getShipHitboxes: () => {
        const out: Array<{ x: number; y: number; w: number; h: number }> = [];
        for (const ship of this.ships.values()) {
          const hb = ship.hitbox();
          out.push({ x: ship.x + hb.offX, y: ship.y + hb.offY, w: hb.w, h: hb.h });
        }
        return out;
      },
      getShipHelms: () => {
        const out: Array<{ x: number; y: number; w: number; h: number }> = [];
        for (const ship of this.ships.values()) {
          const h = ship.helm();
          out.push({ x: ship.x + h.offX, y: ship.y + h.offY, w: h.w, h: h.h });
        }
        return out;
      },
      getAuthoredItems: () => this.authoredItems,
    });
    if (import.meta.env.DEV) {
      const overlayKeys: Array<[Phaser.Input.Keyboard.Key, OverlayName]> = [
        [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F1), "walkability"],
        [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F2), "chunkGrid"],
        [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F3), "spawns"],
        [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F4), "anchorSearch"],
        [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F6), "hitbox"],
      ];
      for (const [key, name] of overlayKeys) key.on("down", () => this.debug.toggle(name));
      // Dev shortcut: play the demo cutscene from anywhere in the world.
      const cutsceneKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F8);
      cutsceneKey.on("down", () => {
        bus.emitTyped("cutscene:play", { id: "demo_blacksmith_chat" });
      });
    }

    this.cutsceneDirector = new CutsceneDirector(
      this,
      this.cutsceneHost,
      ensureQuestSubsystem().dialogues,
    );

    bus.onTyped("inventory:action", this.onInventoryAction);
    bus.onTyped("dialogue:action", this.onDialogueAction);
    bus.onTyped("cutscene:play", this.onCutscenePlay);
    bus.onTyped("skin:apply", this.onSkinApply);
    bus.onTyped("crafting:begin", this.onCraftingBegin);
    bus.onTyped("crafting:complete", this.onCraftingComplete);
    bus.onTyped("crafting:cancel", this.onCraftingCancel);
    bus.onTyped("chest:take", this.onChestTake);
    bus.onTyped("chest:takeAll", this.onChestTakeAll);
    bus.onTyped("chest:close", this.onChestClose);
    bus.onTyped("jobs:xpGained", this.onXpGained);
    if (import.meta.env.DEV) {
      bus.onTyped("player:resetSpawn", this.onResetSpawn);
      bus.onTyped("ships:resetAll", this.onResetAllShips);
    }
    activeWorldScene = this;

    const unsubPlayerVisuals = bindPlayerVisualSubscriptions(this.player);
    this.events.on(Phaser.Scenes.Events.WAKE, (_sys: unknown, data: InteriorReturnData | undefined) => {
      this.onInteriorWake(data);
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      bus.offTyped("inventory:action", this.onInventoryAction);
      bus.offTyped("dialogue:action", this.onDialogueAction);
      bus.offTyped("cutscene:play", this.onCutscenePlay);
      bus.offTyped("skin:apply", this.onSkinApply);
      this.cutsceneDirector?.stop();
      bus.offTyped("crafting:begin", this.onCraftingBegin);
      bus.offTyped("crafting:complete", this.onCraftingComplete);
      bus.offTyped("crafting:cancel", this.onCraftingCancel);
      bus.offTyped("chest:take", this.onChestTake);
      bus.offTyped("chest:takeAll", this.onChestTakeAll);
      bus.offTyped("chest:close", this.onChestClose);
      bus.offTyped("jobs:xpGained", this.onXpGained);
      if (import.meta.env.DEV) {
        bus.offTyped("player:resetSpawn", this.onResetSpawn);
        bus.offTyped("ships:resetAll", this.onResetAllShips);
      }
      unsubPlayerVisuals();
      this.unsubVirtualInput?.();
      this.unsubVirtualInput = null;
      if (activeWorldScene === this) activeWorldScene = null;
      for (const e of this.enemies) entityRegistry.remove(e.id);
      this.enemies = [];
      for (const d of this.decorations) d.destroy();
      this.decorations = [];
      for (const c of this.chests) c.destroy();
      this.chests = [];
      this.chestPendingLoot.clear();
      for (const s of this.signs) s.destroy();
      this.signs = [];
      for (const p of this.projectiles) p.destroy();
      this.projectiles = [];
      this.bowReticle?.destroy();
      this.bowReticle = undefined;
      worldTicker.unregisterWalkable({ kind: "world" });
      this.npcBinder?.detach();
      this.npcReconciler?.shutdown();
      // Destroy the scene-local sprite; the PlayerModel persists in the
      // registry and rebinds to whichever scene wakes next.
      this.player?.destroy();
      // SaveController is game-scoped (booted at title time) and shuts down
      // on Phaser game destroy — not on scene shutdown. Unregister the
      // scene-bound saveables so a re-entry can re-register cleanly.
      this.saveController.unregisterSystems([
        "player",
        "ships",
        "groundItems",
        "scene",
      ]);
    });

    setHud({
      mode: "OnFoot",
      prompt: null,
      speed: 0,
      heading: 0,
      message: null,
    });
    showToast("WASD/Arrows to move. E interact. ESC menu.", 4000);

    bus.emitTyped("world:mapEntered", {
      mapId: "world",
      fromMapId: null,
      reason: "load",
    });

    phase("initSceneSave (rehydrate + applyAfterLoad)", () => this.initSceneSave());
    // Save rehydrate above re-runs `npcRegistry.hydrate` against the saved
    // envelope, clobbering the fresh agents `bootstrapNpcs` registered with
    // current authored data (e.g. `scheduleArchetype`). Re-apply authored
    // defs here so saves taken before a schedule was added don't trap an NPC
    // in stale wander state.
    phase("reapplyScheduledAgents", () => reapplyScheduledAgentsFromDefs());

    if (import.meta.env.DEV) {
      const total = performance.now() - createStart;
      console.log(`[WorldScene.create] TOTAL ${total.toFixed(1)}ms`);
    }
  }

  /** Register the scene-bound saveables (player, ships, scene mode, ground &
   *  dropped items) with the game-scoped controller and rehydrate so their
   *  slice of the envelope is applied and `applyAfterLoad` runs the post-load
   *  scene fix-ups (mode, ship parking, walkability rescue, ground respawn).
   *  The store-only saveables were registered + hydrated during TitleScene's
   *  boot, so inventory/equipment/etc. are already live by the time we get
   *  here. `rehydrate()` re-applies the store-only slice idempotently. */
  private initSceneSave(): void {
    this.saveController.registerSystems([
      saveSystems.playerSaveable(this.player),
      saveSystems.shipsSaveable(
        () => Array.from(this.ships.values()),
        (states) => this.hydrateShips(states),
      ),
      saveSystems.groundItemsSaveable(this.groundItemsState),
      saveSystems.sceneSaveable(this.sceneState),
    ]);
    // Pop the prefetched envelope from the registry so a later scene
    // re-entry can't apply a stale snapshot (matches prior behaviour).
    this.game.registry.remove(PREFETCHED_SAVE_REGISTRY_KEY);
    this.saveController.rehydrate();
  }

  update(_time: number, dtMs: number) {
    const dt = dtMs / 1000;
    this.tickExterior(dt, dtMs);
    this.tickAlways(dtMs);
  }

  /** Per-frame scene-local work that must run regardless of mode (OnFoot,
   *  Interior, AtHelm, Anchoring, edit). Scene-agnostic ticks (playtime, HP
   *  regen, stamina regen, entity-model ticking) run from SystemsScene and
   *  aren't duplicated here. */
  private tickAlways(dtMs: number) {
    this.droppedExpiryAccum += dtMs;
    if (this.droppedExpiryAccum >= 1000) {
      this.droppedExpiryAccum = 0;
      this.expireDroppedItems();
    }
    // Activities (registry) → NpcModel via the binder, then NpcModel →
    // sprite via the reconciler. Order matters: binder.update writes into
    // the models; reconciler.syncAll then pushes them to Phaser.
    this.npcBinder?.update(
      dtMs,
      this.isOnFoot() ? { x: this.player.x, y: this.player.y } : null,
    );
    this.npcReconciler?.syncAll();
    this.zoom.update(dtMs);
    this.emitHud();
    this.debug.update();
  }

  private tickExterior(dt: number, dtMs: number) {
    this.world.manager.tick(dtMs);
    if (this.sceneState.mode === "OnFoot" && !this.activeDialogue) this.updateOnFoot(dt);
    else if (this.sceneState.mode === "AtHelm") this.updateAtHelm(dt);
    else if (this.sceneState.mode === "Anchoring") {
      // Tween drives the ship; nothing to do here.
    }
    for (const node of this.nodes) node.update(this.time.now);
    // Enemies / projectiles / bow reticle are owned by the GameplayScene base.
    // It uses `isOnFoot()` to suspend enemy AI while the player is at the
    // helm or anchoring.
    this.tickCombat(dtMs);
    const pTile = this.player.tile();
    this.world.manager.updateOverheadFade(pTile.x, pTile.y, dtMs);
    this.syncPlayerShipDepth();
  }

  /** Player rides above the hull whenever on a ship — each ship's container
   *  depth uses the footprint bottom, which would otherwise cover the player. */
  private syncPlayerShipDepth() {
    let ridingShip: Ship | null = null;
    if (this.sceneState.mode === "AtHelm" || this.sceneState.mode === "Anchoring") {
      ridingShip = this.activeShip;
    } else if (this.sceneState.mode === "OnFoot") {
      ridingShip = this.shipAtPlayer();
    }
    this.player.depthOverride = ridingShip ? ridingShip.sortY() + 1 : null;
    this.player.sprite.setDepth(this.player.depthOverride ?? this.player.sortY());
  }

  /** Find the docked ship (if any) whose deck the player is currently standing on. */
  private shipAtPlayer(): Ship | null {
    for (const ship of this.ships.values()) {
      if (ship.isOnDeck(this.player.x, this.player.y)) return ship;
    }
    return null;
  }

  private spawnShip(inst: ShipInstanceData): Ship {
    const def = this.shipDefs.get(inst.defId);
    if (!def) throw new Error(`Unknown ship defId '${inst.defId}' for instance '${inst.id}'.`);
    const ship = new Ship(this, inst.id, def, {
      tx: inst.tileX,
      ty: inst.tileY,
      heading: inst.heading,
    });
    this.ships.set(inst.id, ship);
    return ship;
  }

  /** Apply saved per-ship states. Ships present in the save hydrate; ships
   *  absent fall back to their ships.json initial pose. Ships saved but no
   *  longer present in ships.json are ignored. */
  private hydrateShips(states: Array<ReturnType<Ship["serialize"]>>): void {
    const byId = new Map(states.map((s) => [s.id, s]));
    for (const ship of this.ships.values()) {
      const saved = byId.get(ship.id);
      if (saved) ship.hydrate(saved);
    }
    // Rebind activeShip from the hydrated ship modes directly. Gating this on
    // sceneState.mode would be order-dependent: sceneSaveable hydrates after
    // shipsSaveable, so sceneState would still be at its default here.
    this.activeShip = null;
    for (const ship of this.ships.values()) {
      if (ship.mode === "sailing" || ship.mode === "anchoring") {
        this.activeShip = ship;
        break;
      }
    }
  }

  // ─── Mode: OnFoot ────────────────────────────────────────────────

  private updateOnFoot(dt: number) {
    this.movement.update(dt);
    if (BEACH_WALK_ENABLED) {
      this.footprints.update(this.player.x, this.player.y, this.time.now);
    }
    this.checkAutoEnter();
  }

  /** Step-on door entry — mirrors InteriorScene.checkAutoExit so doors don't
   *  need an E-press. Tracks the last tile we evaluated so we don't retrigger
   *  every frame while the player stands on the door. */
  private checkAutoEnter() {
    if (this.player.mounted) return;
    const tx = Math.floor(this.player.x / TILE_SIZE);
    const ty = Math.floor(this.player.y / TILE_SIZE);
    const last = this.lastDoorTile;
    if (last && last.x === tx && last.y === ty) return;
    this.lastDoorTile = { x: tx, y: ty };
    for (const d of this.doors) {
      if (d.tileX === tx && d.tileY === ty) {
        this.enterInterior(d);
        return;
      }
    }
  }

  private onRightClick(worldX: number, worldY: number) {
    if (this.sceneState.mode !== "OnFoot") return;
    if (this.activeDialogue) return;
    const npc = this.npcAtWorldPoint(worldX, worldY);
    if (!npc || !npc.def.shopId) return;
    // Must also be within reach of the player — no long-range trading.
    const dPlayer = Phaser.Math.Distance.Between(
      this.player.x,
      this.player.y,
      npc.x,
      npc.y,
    );
    if (dPlayer > SHOP_CLICK_RADIUS * 2) {
      showToast(`Step closer to ${npc.def.name} to trade.`, 1500);
      return;
    }
    useShopStore.getState().openShop(npc.def.shopId);
    bus.emitTyped("shop:open", { shopId: npc.def.shopId });
  }

  private npcAtWorldPoint(x: number, y: number): NpcModel | null {
    let best: NpcModel | null = null;
    let bestDist = SHOP_CLICK_RADIUS;
    for (const npc of this.activeNpcModels()) {
      const d = Phaser.Math.Distance.Between(x, y, npc.x, npc.y);
      if (d <= bestDist) {
        best = npc;
        bestDist = d;
      }
    }
    return best;
  }

  private onResetSpawn = () => {
    if (this.scene.isActive("Interior") || this.scene.isSleeping("Interior")) {
      this.scene.stop("Interior");
      if (this.scene.isSleeping()) this.scene.wake();
    }
    this.sceneState.interior = null;
    this.sceneState.activeScene = "World";
    this.activeShip = null;
    this.sceneState.mode = "OnFoot";
    this.player.setPosition(
      (DEFAULT_PLAYER_SPAWN_TILE.x + 0.5) * TILE_SIZE,
      (DEFAULT_PLAYER_SPAWN_TILE.y + 0.5) * TILE_SIZE,
    );
    showToast("Teleported to default spawn.", 1500);
  };

  private onResetAllShips = () => {
    if (this.activeShip) {
      this.activeShip = null;
      this.sceneState.mode = "OnFoot";
    }
    for (const inst of this.shipInstanceData) {
      const ship = this.ships.get(inst.id);
      if (!ship) continue;
      ship.finalizeDock({
        tx: inst.tileX,
        ty: inst.tileY,
        heading: inst.heading,
      });
    }
    showToast("Reset ship positions.", 1500);
  };

  protected onPlayerDeathRespawn(): void {
    this.player.setPosition(
      (DEFAULT_PLAYER_SPAWN_TILE.x + 0.5) * TILE_SIZE,
      (DEFAULT_PLAYER_SPAWN_TILE.y + 0.5) * TILE_SIZE,
    );
    foodRegen.reset();
  }

  // ─── GameplayScene hook implementations ──────────────────────────────────

  protected getMapId(): string {
    return "world";
  }

  protected isOnFoot(): boolean {
    return this.sceneState.mode === "OnFoot";
  }

  protected isDialogueActive(): boolean {
    return this.activeDialogue !== null;
  }

  protected isBlockedPx(x: number, y: number): boolean {
    return this.world.manager.isBlockedPx(x, y);
  }

  // ─── Building interiors ───────────────────────────────────────────

  /** Enter a building. Sleeps this scene and launches InteriorScene; the
   *  return payload is delivered back via SCENE_WAKE on exit. */
  private enterInterior(door: DoorSpawn) {
    if (this.activeDialogue) this.closeDialogue();
    // Horses stay outside — force dismount before crossing into an interior.
    if (this.player.mounted) this.player.setMount(null);
    const returnFacing = this.player.facing;
    this.sceneState.interior = {
      interiorKey: door.interiorKey,
      returnWorldTx: door.tileX,
      returnWorldTy: door.tileY,
      returnFacing,
    };
    this.sceneState.mode = "Interior";
    this.sceneState.activeScene = "Interior";
    void this.saveController.autosave();
    this.scene.sleep();
    this.scene.launch("Interior", {
      interiorKey: door.interiorKey,
      entryTx: door.entryTx,
      entryTy: door.entryTy,
      returnWorldTx: door.tileX,
      returnWorldTy: door.tileY,
      returnFacing,
    });
  }

  /** Called when InteriorScene hands control back via `scene.wake`. */
  private onInteriorWake(ret: InteriorReturnData | undefined) {
    const fromMap = this.sceneState.interior
      ? `interior:${this.sceneState.interior.interiorKey}`
      : null;
    this.sceneState.mode = "OnFoot";
    this.sceneState.activeScene = "World";
    this.sceneState.interior = null;
    bus.emitTyped("world:mapEntered", {
      mapId: "world",
      fromMapId: fromMap,
      reason: "transition",
    });
    if (ret) {
      this.player.setPosition(
        (ret.returnWorldTx + 0.5) * TILE_SIZE,
        (ret.returnWorldTy + 1.5) * TILE_SIZE,
      );
      this.lastDoorTile = {
        x: Math.floor(this.player.x / TILE_SIZE),
        y: Math.floor(this.player.y / TILE_SIZE),
      };
      const f = ret.returnFacing;
      if (
        f === "up" || f === "down" || f === "left" || f === "right" ||
        f === "up-left" || f === "up-right" || f === "down-left" || f === "down-right"
      ) {
        this.player.setFacing(f);
      }
    }
    this.cameras.main.startFollow(this.player.sprite, true, 0.15, 0.15);
    void this.saveController.autosave();
  }

  /**
   * Primary left-click handler for on-foot gameplay. Today this only fires a
   * bow when equipped; edit-mode clicks are routed earlier in the dispatcher.
   */
  private onLeftClick(worldX: number, worldY: number): void {
    if (this.activeDialogue) return;
    if (this.sceneState.mode !== "OnFoot") return;
    const mainHand = useGameStore.getState().equipment.equipped.mainHand;
    if (mainHand !== "bow") return;
    this.fireBow(worldX, worldY);
  }

  /**
   * Try to start a fishing cast on the water tile directly ahead of the
   * player. Returns true if a session started; false if the facing tile
   * isn't a fishable surface.
   */
  protected tryStartFishing(): boolean {
    const off = bobberOffsetPx(this.player.facing);
    const bobberX = this.player.x + off.dx;
    const bobberY = this.player.y + off.dy;
    const targetTx = Math.floor(bobberX / TILE_SIZE);
    const targetTy = Math.floor(bobberY / TILE_SIZE);
    const surface = this.world.manager.fishingSurface(targetTx, targetTy) as FishingSurface | null;
    if (!surface) return false;
    if (!this.player.enterFishingPose()) return false;
    const session = new FishingSession({
      scene: this,
      player: this.player,
      bobberX,
      bobberY,
      surface,
      contextKey: null,
      onCatch: (itemId, quantity) => {
        const leftover = useGameStore.getState().inventoryAdd(itemId as ItemId, quantity);
        if (leftover > 0) showToast("Inventory full — some fish got away.", 1500);
      },
    });
    this.fishingSession = session;
    session.start();
    return true;
  }

  protected nearestNodeForTool(toolId: string | undefined): GatheringNode | null {
    if (!toolId) return null;
    let best: GatheringNode | null = null;
    let bestDist = Infinity;
    for (const node of this.nodes) {
      if (!node.isAlive()) continue;
      if (node.def.requiredTool !== toolId) continue;
      const reach = NODE_INTERACT_RADIUS * (node.def.interactRadiusMul ?? 1);
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, node.x, node.y);
      if (d <= reach && d <= bestDist) {
        best = node;
        bestDist = d;
      }
    }
    return best;
  }

  protected nearestPalmWithCoconut(): GatheringNode | null {
    let best: GatheringNode | null = null;
    let bestDist = Infinity;
    for (const node of this.nodes) {
      if (!node.isAlive()) continue;
      if (node.def.id !== "tree_palm") continue;
      const reach = NODE_INTERACT_RADIUS * (node.def.interactRadiusMul ?? 1);
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, node.x, node.y);
      if (d <= reach && d <= bestDist) {
        best = node;
        bestDist = d;
      }
    }
    return best;
  }

  protected shakePalm(palm: GatheringNode) {
    const ok = this.player.playAction("chop", () => {
      this.dropPerHitFromNode(palm);
      const next = (this.palmShakeCounts.get(palm) ?? 0) + 1;
      this.palmShakeCounts.set(palm, next);
      if (next >= palm.def.hp) {
        const bare = this.nodeDefs.get("tree_palm_bare");
        if (!bare) return;
        palm.transformTo(this, bare);
        this.palmShakeCounts.delete(palm);
        this.time.delayedCall(2 * 60 * 1000, () => {
          if (!palm.isAlive()) return;
          if (palm.def.id !== "tree_palm_bare") return;
          const ripe = this.nodeDefs.get("tree_palm");
          if (!ripe) return;
          palm.transformTo(this, ripe);
        });
      }
    });
    if (!ok) return;
  }

  private nearestAnyNodeInReach(): GatheringNode | null {
    let best: GatheringNode | null = null;
    let bestDist = Infinity;
    for (const node of this.nodes) {
      if (!node.isAlive()) continue;
      const reach = NODE_INTERACT_RADIUS * (node.def.interactRadiusMul ?? 1);
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, node.x, node.y);
      if (d <= reach && d <= bestDist) {
        best = node;
        bestDist = d;
      }
    }
    return best;
  }

  protected gatherFromNode(node: GatheringNode) {
    const animState = node.def.kind === "tree" ? "chop" : "mine";
    const ok = this.player.playAction(animState, () => {
      const nodeDmg = 1;
      const broken = node.hit(this);
      spawnFloatingNumber(this, node.x, node.y - node.def.height / 2 - 4, nodeDmg, {
        kind: "damage-node",
      });
      useGameStore.getState().jobsAddXp(node.def.skill, node.def.xpPerHit);
      bus.emitTyped("gathering:nodeHit", {
        defId: node.def.id,
        mapId: "world",
      });
      if (node.def.perHitDrop) this.dropPerHitFromNode(node);
      if (broken) this.dropFromNode(node);
    });
    if (!ok) return;
  }

  private dropPerHitFromNode(node: GatheringNode) {
    const drop = node.def.perHitDrop;
    if (!drop) return;
    const offsetX = (Math.random() - 0.5) * TILE_SIZE * 0.5;
    const offsetY = TILE_SIZE * 0.4 + Math.random() * 6;
    const qMax = drop.quantityMax ?? drop.quantity;
    const quantity =
      drop.quantity + Math.floor(Math.random() * (qMax - drop.quantity + 1));
    if (quantity <= 0) return;
    const entry = this.droppedItemsState.add(
      drop.itemId,
      quantity,
      node.x + offsetX,
      node.y + offsetY,
      "world",
    );
    this.spawnDroppedSprite(entry);
  }

  private dropFromNode(node: GatheringNode) {
    const offsetX = (Math.random() - 0.5) * TILE_SIZE * 0.5;
    const offsetY = TILE_SIZE * 0.4 + Math.random() * 6;
    const x = node.x + offsetX;
    const y = node.y + offsetY;
    const { itemId, quantity: qMin, quantityMax } = node.def.drop;
    const qMax = quantityMax ?? qMin;
    const quantity = qMin + Math.floor(Math.random() * (qMax - qMin + 1));
    const entry = this.droppedItemsState.add(itemId, quantity, x, y, "world");
    this.spawnDroppedSprite(entry);
    showToast(`+${quantity} ${ITEMS[itemId].name}`, 1500);
    bus.emitTyped("gathering:nodeHarvested", {
      defId: node.def.id,
      mapId: "world",
      yieldedItemId: itemId,
      yieldedQuantity: quantity,
    });
  }

  private enemyGate: SpawnGateRegistry<EnemyInstanceData, Enemy> | null = null;
  private nodeGate: SpawnGateRegistry<NodeInstanceData, GatheringNode> | null = null;
  private stationGate: SpawnGateRegistry<CraftingStationInstanceData, CraftingStation> | null = null;

  private spawnEnemies(ctx: PredicateContext) {
    const file = enemiesDataRaw as EnemiesFile;
    this.enemyDefs = new Map(file.defs.map((d) => [d.id, d]));
    for (const def of file.defs) registerEnemyAnimations(this, def);
    this.enemyGate?.destroy();
    this.enemyGate = new SpawnGateRegistry({
      ctx,
      factory: (inst) => {
        const def = this.enemyDefs.get(inst.defId);
        if (!def) {
          console.warn(`Unknown enemy defId: ${inst.defId}`);
          return null;
        }
        const e = new Enemy(this, def, inst);
        this.addEnemy(e);
        return e;
      },
      teardown: (e) => {
        const idx = this.enemies.indexOf(e);
        if (idx >= 0) this.removeEnemyAt(idx);
      },
    });
    this.enemyGate.register(file.instances);
  }

  private spawnGatheringNodes(ctx: PredicateContext) {
    const file = loadNodesFile(nodesDataRaw);
    this.nodeDefs = indexDefs(file.defs);
    this.nodeGate?.destroy();
    this.nodeGate = new SpawnGateRegistry({
      ctx,
      factory: (inst) => {
        const def = this.nodeDefs.get(inst.defId);
        if (!def) {
          console.warn(`Unknown node defId: ${inst.defId}`);
          return null;
        }
        const n = new GatheringNode(this, def, inst);
        this.nodes.push(n);
        return n;
      },
      teardown: (n) => {
        const i = this.nodes.indexOf(n);
        if (i >= 0) this.nodes.splice(i, 1);
        n.destroy();
      },
    });
    this.nodeGate.register(file.instances);
  }

  /** Drain torches buffered during the eager chunk load (which runs before
   *  lighting is attached) and register them with the lighting system. */
  private flushPendingTorches() {
    for (const t of this.pendingTorches) this.spawnTorch(t);
    this.pendingTorches.length = 0;
  }

  private spawnTorch(t: TorchSpawn) {
    if (this.registeredTorchUids.has(t.uid)) return;
    this.registeredTorchUids.add(t.uid);

    const wx = t.tileX * TILE_SIZE + TILE_SIZE / 2;
    const wy = t.tileY * TILE_SIZE + TILE_SIZE / 2;

    // Small visual flame so the torch is locatable in daylight too. Color
    // matches the lit-area tint so the source reads as the same fire.
    const flame = this.add.circle(wx, wy, 2, t.color).setDepth(wy);
    this.add.circle(wx, wy, 1, 0xfff2c0).setDepth(wy + 0.1);
    this.tweens.add({
      targets: flame,
      scale: { from: 0.85, to: 1.15 },
      duration: 220,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    this.lighting.addLight({
      id: `torch:${t.uid}`,
      position: () => ({ x: wx, y: wy }),
      radius: t.radiusTiles * TILE_SIZE,
      intensity: t.intensity,
      color: t.color,
      tintStrength: t.tintStrength,
    });
  }

  private spawnDecorations() {
    const file = loadDecorationsFile(decorationsDataRaw);
    const defs = new Map(file.defs.map((d) => [d.id, d]));
    for (const inst of file.instances) {
      const def = defs.get(inst.defId);
      if (!def) {
        console.warn(`Unknown decoration defId: ${inst.defId}`);
        continue;
      }
      this.decorations.push(new Decoration(this, def, inst));
    }
  }

  private spawnCraftingStations(ctx: PredicateContext) {
    this.stationInstanceData = craftingStationInstances.map((i) => ({ ...i }));
    this.stationGate?.destroy();
    this.stationGate = new SpawnGateRegistry({
      ctx,
      factory: (inst) => {
        const def = craftingStations.tryGet(inst.defId);
        if (!def) {
          console.warn(`Unknown crafting station defId: ${inst.defId}`);
          return null;
        }
        const s = new CraftingStation(this, def, inst);
        this.craftingStations.push(s);
        return s;
      },
      teardown: (s) => {
        const i = this.craftingStations.indexOf(s);
        if (i >= 0) this.craftingStations.splice(i, 1);
        s.destroy();
      },
    });
    this.stationGate.register(this.stationInstanceData);
  }

  private spawnChests() {
    for (const c of this.chests) c.destroy();
    this.chests = [];
    this.chestPendingLoot.clear();
    const file = loadChestsFile(chestsDataRaw);
    this.chestInstanceData = file.instances.map((i) => ({ ...i }));
    const flags = getFlagStore();
    for (const inst of this.chestInstanceData) {
      const def = this.chestDef(inst.defId);
      if (!def) {
        console.warn(`Unknown chest defId: ${inst.defId}`);
        continue;
      }
      const looted = flags.getBool(chestLootedFlagKey(inst.id));
      this.chests.push(new Chest(this, def, inst, looted));
    }
  }

  private chestDef(defId: string) {
    const file = loadChestsFile(chestsDataRaw);
    return file.defs.find((d) => d.id === defId);
  }

  private spawnBusinessSigns() {
    for (const s of this.signs) s.destroy();
    this.signs = [];
    const file = loadBusinessSignsFile(businessSignsDataRaw);
    for (const inst of file.instances) {
      const def = businessRegistry.tryGet(inst.businessId);
      if (!def) {
        console.warn(`Unknown businessId on sign "${inst.id}": ${inst.businessId}`);
        continue;
      }
      this.signs.push(new BusinessSign(this, inst, def.displayName));
    }
  }

  private nearestSign(): BusinessSign | null {
    let best: BusinessSign | null = null;
    let bestDist = BUSINESS_SIGN_INTERACT_RADIUS;
    for (const sign of this.signs) {
      const d = Phaser.Math.Distance.Between(
        this.player.x,
        this.player.y,
        sign.x,
        sign.y,
      );
      if (d <= bestDist) {
        best = sign;
        bestDist = d;
      }
    }
    return best;
  }

  private getPlayerCoinTotal(): number {
    const slots = useGameStore.getState().inventory.slots;
    let t = 0;
    for (const s of slots) if (s?.itemId === "coin") t += s.quantity;
    return t;
  }

  private interactWithSign(sign: BusinessSign) {
    const def = businessRegistry.tryGet(sign.businessId);
    if (!def) return;
    const store = useBusinessStore.getState();
    const state = store.get(sign.businessId);
    if (state?.owned) {
      bus.emitTyped("business:open", { businessId: sign.businessId });
      return;
    }
    const coins = this.getPlayerCoinTotal();
    const canAfford = coins >= def.purchasePrice;
    const speaker = def.displayName;
    const pages = canAfford
      ? [`Buy ${def.displayName} for ${def.purchasePrice} coin?`]
      : [
          `${def.displayName} is for sale at ${def.purchasePrice} coin. ` +
            `You only have ${coins}.`,
        ];
    const choices: DialogueChoiceOption[] = canAfford
      ? [
          { label: "Buy it", goto: "" },
          { label: "Maybe later", goto: "" },
        ]
      : [{ label: "Walk away", goto: "" }];
    this.activeDialogue = {
      speaker,
      pages,
      page: 0,
      choices,
      onSelect: (index) => {
        if (!canAfford) return;
        if (index !== 0) return;
        const result = useBusinessStore.getState().purchase(sign.businessId);
        if (result.ok) {
          showToast(`You own ${def.displayName}!`, 2500, "success");
          bus.emitTyped("business:open", { businessId: sign.businessId });
        } else {
          const reasonMsg: Record<string, string> = {
            alreadyOwned: "You already own this property.",
            unknownBusiness: "This sign points to nothing.",
            insufficientCoin: "Not enough coin.",
            inventoryFull: "Inventory full.",
          };
          showToast(reasonMsg[result.reason] ?? "Purchase failed.", 1800, "warn");
        }
      },
    };
    this.emitDialogue();
  }

  private nearestChest(): Chest | null {
    const flags = getFlagStore();
    let best: Chest | null = null;
    let bestDist = CHEST_INTERACT_RADIUS;
    for (const c of this.chests) {
      if (flags.getBool(chestLootedFlagKey(c.id))) continue;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, c.x, c.y);
      if (d <= bestDist) {
        best = c;
        bestDist = d;
      }
    }
    return best;
  }

  private openChest(chest: Chest) {
    // Re-opening a chest the player closed mid-loot reuses its pending roll
    // so they don't re-roll loot by toggling the panel.
    let loot = this.chestPendingLoot.get(chest.id);
    if (!loot) {
      loot = rollChestLoot(chest.def);
      this.chestPendingLoot.set(chest.id, loot);
    }
    chest.playOpen(() => {
      // Re-check pending — the player may have moved away or another flow
      // may have invalidated the chest by the time the anim finishes.
      const finalLoot = this.chestPendingLoot.get(chest.id);
      if (!finalLoot) return;
      // Empty chests still show the panel ("Empty.") so the player can see
      // they've found one, then close it normally.
      useChestStore.getState().open(chest.id, chest.def.name, finalLoot);
      bus.emitTyped("chest:open", {
        chestId: chest.id,
        chestName: chest.def.name,
        loot: finalLoot,
      });
    });
  }

  private onChestTake = (req: ChestTakeRequest) => {
    const pending = this.chestPendingLoot.get(req.chestId);
    if (!pending) return;
    const entry = pending[req.index];
    if (!entry) return;
    const store = useGameStore.getState();
    const result = addToSlots(store.inventory.slots, entry.itemId, entry.qty);
    if (result.leftover >= entry.qty) {
      showToast("Inventory full.", 1500, "warn");
      return;
    }
    store.inventoryHydrate(result.slots);
    const taken = entry.qty - result.leftover;
    showToast(`+${taken} ${ITEMS[entry.itemId].name}`, 1300, "success");
    if (result.leftover > 0) {
      // Partial take — leave the remainder in the chest.
      pending[req.index] = { itemId: entry.itemId, qty: result.leftover };
      useChestStore.setState((s) => {
        const next = [...s.loot];
        next[req.index] = { itemId: entry.itemId, qty: result.leftover };
        return { loot: next };
      });
      return;
    }
    pending.splice(req.index, 1);
    useChestStore.getState().removeAt(req.index);
    if (pending.length === 0) this.finalizeChest(req.chestId);
  };

  private onChestTakeAll = (req: ChestTakeAllRequest) => {
    const pending = this.chestPendingLoot.get(req.chestId);
    if (!pending) return;
    const store = useGameStore.getState();
    let slots = store.inventory.slots;
    const remaining: Array<{ itemId: ItemId; qty: number }> = [];
    let anyTaken = false;
    let anyLeftover = false;
    for (const entry of pending) {
      const r = addToSlots(slots, entry.itemId, entry.qty);
      slots = r.slots;
      const taken = entry.qty - r.leftover;
      if (taken > 0) anyTaken = true;
      if (r.leftover > 0) {
        anyLeftover = true;
        remaining.push({ itemId: entry.itemId, qty: r.leftover });
      }
    }
    if (!anyTaken) {
      showToast("Inventory full.", 1500, "warn");
      return;
    }
    store.inventoryHydrate(slots);
    if (remaining.length === 0) {
      pending.length = 0;
      useChestStore.getState().clear();
      this.finalizeChest(req.chestId);
      showToast("Took all loot.", 1300, "success");
    } else {
      this.chestPendingLoot.set(req.chestId, remaining);
      useChestStore.getState().open(
        req.chestId,
        useChestStore.getState().openChestName,
        remaining,
      );
      if (anyLeftover) showToast("Inventory full — some items left in chest.", 1800, "warn");
    }
  };

  private onChestClose = () => {
    // Player closed the panel. If the chest still has loot, preserve it for
    // a future re-interact. If it was empty (or was emptied click-by-click
    // and then closed), finalize so it can't be re-opened forever.
    const chestId = useChestStore.getState().openChestId;
    if (!chestId) {
      useChestStore.getState().close();
      return;
    }
    const pending = this.chestPendingLoot.get(chestId);
    if (pending && pending.length === 0) {
      this.finalizeChest(chestId);
      return;
    }
    useChestStore.getState().close();
    const chest = this.chests.find((c) => c.id === chestId);
    chest?.playClose();
  };

  private finalizeChest(chestId: string) {
    this.chestPendingLoot.delete(chestId);
    getFlagStore().set(chestLootedFlagKey(chestId), true);
    useChestStore.getState().close();
    const chest = this.chests.find((c) => c.id === chestId);
    chest?.playClose();
  }

  private nearestCraftingStation(): CraftingStation | null {
    let best: CraftingStation | null = null;
    let bestDist = STATION_INTERACT_RADIUS;
    for (const st of this.craftingStations) {
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, st.x, st.y);
      if (d <= bestDist) {
        best = st;
        bestDist = d;
      }
    }
    return best;
  }

  private openCraftingStation(station: CraftingStation) {
    bus.emitTyped("crafting:open", { stationDefId: station.def.id });
    useCraftingStore.getState().openStation(station.def.id);
  }

  /** Emitted by the React modal when the player clicks "Craft" on a recipe.
   *  Instant (smelter-style) crafts are applied directly here; minigame
   *  (anvil-style) crafts pause World and hand off to CraftingScene. */
  private onCraftingBegin = (req: CraftingBeginRequest) => {
    const recipe = recipeRegistry.tryGet(req.recipeId);
    if (!recipe) {
      showToast("Unknown recipe.", 1500, "error");
      return;
    }
    const slots = useGameStore.getState().inventory.slots;
    if (!hasAllInputs(slots, recipe)) {
      showToast("Missing materials.", 1500, "warn");
      return;
    }
    if (recipe.minigame) {
      this.scene.pause();
      this.scene.launch("Crafting", {
        stationDefId: req.stationDefId,
        recipeId: req.recipeId,
      });
      return;
    }
    // Instant craft — consume inputs, grant output, award XP, toast.
    this.applyCraftResult(req.recipeId, "normal");
  };

  private onCraftingComplete = (res: CraftingCompleteResult) => {
    if (this.scene.isPaused()) this.scene.resume();
    this.applyCraftResult(res.recipeId, res.tier);
  };

  private onCraftingCancel = () => {
    if (this.scene.isPaused()) this.scene.resume();
  };

  private onXpGained = (payload: { jobId: JobId; amount: number }) => {
    if (!this.player || payload.amount <= 0) return;
    spawnFloatingNumber(this, this.player.x, this.player.y - 22, payload.amount, {
      kind: "xp",
    });
  };

  /** Tier → XP multiplier. Failing a craft still grants a smidge so the
   *  player doesn't feel robbed, but most of the reward is gated behind a
   *  clean finish. */
  private craftXpMultiplier(tier: CraftingCompleteResult["tier"]): number {
    switch (tier) {
      case "perfect": return 2;
      case "great": return 1.5;
      case "good": return 1;
      case "normal": return 0.75;
      case "fail": return 0.25;
    }
  }

  /** Tier → output-qty multiplier. Perfect doubles; Great has a 50% chance of
   *  a bonus copy; good/normal are 1×; fail produces nothing (handled earlier). */
  private craftOutputMultiplier(tier: CraftingCompleteResult["tier"]): number {
    switch (tier) {
      case "perfect": return 2;
      case "great": return Math.random() < 0.5 ? 2 : 1;
      case "good": return 1;
      case "normal": return 1;
      case "fail": return 0;
    }
  }

  private applyCraftResult(recipeId: string, tier: CraftingCompleteResult["tier"]) {
    const recipe = recipeRegistry.tryGet(recipeId);
    if (!recipe) return;
    const store = useGameStore.getState();
    const xpMult = this.craftXpMultiplier(tier);
    const xp = Math.max(1, Math.floor(recipe.xpReward * xpMult));

    if (tier === "fail") {
      // Consume inputs (stakes) but grant no output. A consolation XP drip
      // keeps the player progressing while still making failure sting.
      this.consumeInputs(recipe);
      store.jobsAddXp(recipe.skill, xp);
      showToast(`Ruined ${recipe.name} — materials lost.`, 1800, "warn");
      return;
    }

    const outputMult = this.craftOutputMultiplier(tier);
    const applied = applyCraft(store.inventory.slots, recipe, outputMult);
    if (!applied.ok) {
      showToast("Missing materials.", 1500, "warn");
      return;
    }
    if (applied.leftoverOutput && applied.leftoverOutput > 0) {
      showToast("Inventory full — no room for output.", 1800, "warn");
      return;
    }
    store.inventoryHydrate(applied.slots);
    store.jobsAddXp(recipe.skill, xp);

    const producedQty = Math.max(1, Math.floor(recipe.output.qty * outputMult));
    const tierLabel = tier === "normal" ? "" : ` (${tier})`;
    showToast(
      `+${producedQty} ${ITEMS[recipe.output.itemId].name}${tierLabel}`,
      1600,
      "success",
    );
  }

  /** Remove the recipe's input items from inventory without producing output.
   *  Re-reads the slots array each iteration because Zustand replaces it on
   *  every mutation — stale snapshots would wrong-count after the first take. */
  private consumeInputs(recipe: RecipeDef) {
    for (const inp of recipe.inputs) {
      let remaining = inp.qty;
      const len = useGameStore.getState().inventory.slots.length;
      for (let i = 0; i < len && remaining > 0; i++) {
        const s = useGameStore.getState().inventory.slots[i];
        if (!s || s.itemId !== inp.itemId) continue;
        const removed = useGameStore.getState().inventoryRemoveAt(
          i,
          Math.min(s.quantity, remaining),
        );
        remaining -= removed;
      }
    }
  }

  private onInteract() {
    if (this.activeDialogue) {
      // Let the dialogue UI handle advance via its own keybind; E here advances too.
      this.onDialogueAction({ type: "advance" });
      return;
    }
    if (this.sceneState.mode === "OnFoot") {
      const npc = this.nearestNpc();
      if (npc) {
        this.openDialogueWith(npc);
        return;
      }
      const station = this.nearestCraftingStation();
      if (station) {
        this.openCraftingStation(station);
        return;
      }
      const chest = this.nearestChest();
      if (chest) {
        this.openChest(chest);
        return;
      }
      const sign = this.nearestSign();
      if (sign) {
        this.interactWithSign(sign);
        return;
      }
      if (this.tryPickupNearby()) return;
      if (this.isNearHelm()) {
        if (this.player.mounted) {
          showToast("Dismount before taking the helm.", 1500);
        } else {
          this.takeHelm();
        }
      }
    } else if (this.sceneState.mode === "AtHelm") {
      this.beginAnchoring();
    }
  }

  private setupNpcReconciler() {
    this.npcData = npcDataRaw as NpcData;
    this.dialogues = this.npcData.dialogues ?? {};
    const worldMap: MapId = { kind: "world" };
    this.npcReconciler = new SpriteReconciler<NpcSprite | CharacterSprite>(
      this,
      worldMap,
      (scene, model) => {
        if (model.kind !== "npc") return null;
        const npc = model as NpcModel;
        if (npc.def.layered) {
          const manifest = scene.cache.json.get(charModelManifestKey(npc.def.layered.model)) as
            | CharacterModelManifest
            | undefined;
          if (manifest) return new CharacterSprite(scene, npc, manifest);
          // Model manifest missing (bad data) — fall through to legacy path
          // only if the NPC also declared a legacy sprite, else bail.
          if (!npc.def.sprite) return null;
        }
        return new NpcSprite(scene, npc);
      },
    );
    worldTicker.registerWalkable(worldMap, (x, y) => this.isWalkablePx(x, y));
    this.npcBinder = new SceneNpcBinder();
    // Bias NPC pathfinding toward the authored road network on the "ground"
    // tile layer: road tiles are baseline cost, off-road tiles cost more so
    // detours that stay on roads are preferred over straight-line crossings
    // through grass/sand. Off-road traversal is still allowed (never blocked)
    // so NPCs can leave roads to reach destinations that aren't on them.
    this.npcBinder.attach(
      this,
      "chunk:world",
      (x, y) => this.isWalkablePx(x, y),
      (tx, ty) =>
        this.world.manager.hasTileOnLayer(tx, ty, "ground")
          ? 1
          : ROAD_OFFROAD_COST,
    );
  }

  reloadNpcs(data: NpcData) {
    this.npcData = data;
    this.dialogues = data.dialogues ?? {};
    if (this.activeDialogue) this.closeDialogue();
    clearNpcs();
    bootstrapNpcs(data, getPredicateContext());
    // Sprites are re-created automatically by the reconciler via `added` events.
  }

  /** Every NPC model currently active on the player's map. */
  private activeNpcModels(): Iterable<NpcModel> {
    const mapId: MapId =
      this.sceneState.mode === "Interior" && this.sceneState.interior
        ? { kind: "interior", key: this.sceneState.interior.interiorKey }
        : { kind: "world" };
    return npcModelsIn(mapId);
  }

  private nearestNpc(): NpcModel | null {
    let best: NpcModel | null = null;
    let bestDist = Infinity;
    for (const npc of this.activeNpcModels()) {
      const radius = npc.def.interactRadiusTiles != null
        ? npc.def.interactRadiusTiles * TILE_SIZE
        : NPC_INTERACT_RADIUS;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, npc.x, npc.y);
      if (d <= radius && d < bestDist) {
        best = npc;
        bestDist = d;
      }
    }
    return best;
  }

  private openDialogueWith(npc: NpcModel) {
    const dialogue = this.dialogues[npc.def.dialogue];
    if (!dialogue) {
      showToast(`${npc.def.name} has nothing to say.`, 1500);
      return;
    }
    bus.emitTyped("npc:interacted", {
      npcId: npc.def.id,
      mapId: "world",
    });
    npc.faceToward(this.player.x, this.player.y);
    this.activeDialogue = {
      speaker: dialogue.speaker || npc.def.name,
      pages: dialogue.pages.slice(),
      page: 0,
      shopId: npc.def.shopId,
    };
    this.emitDialogue();
  }

  private closeDialogue() {
    this.activeDialogue = null;
    bus.emitTyped("dialogue:update", {
      visible: false,
      speaker: "",
      pages: [],
      page: 0,
    });
  }

  private emitDialogue() {
    if (!this.activeDialogue) return;
    bus.emitTyped("dialogue:update", {
      visible: true,
      speaker: this.activeDialogue.speaker,
      pages: this.activeDialogue.pages,
      page: this.activeDialogue.page,
      shopId: this.activeDialogue.shopId,
      choices: this.activeDialogue.choices,
    });
  }

  /** Resolve a cutscene actor reference. `"player"` → the local player
   *  (wrapped); anything else is matched against an NPC model id, falling
   *  back to a bare def id (so scripts can write `"brom_blacksmith"`
   *  instead of `"npc:brom_blacksmith"`). */
  private resolveCutsceneActor(ref: string): CutsceneActor | undefined {
    if (ref === "player") {
      const player = this.player;
      const wasFrozen = { value: player.frozen };
      return {
        get x() { return player.x; },
        get y() { return player.y; },
        setPositionPx: (x, y) => player.setPosition(x, y),
        setFacing: (dir: CutsceneFacing) => {
          player.setFacing(dir);
        },
        // Player anim is driven by its own state machine; ignore anim hints
        // from cutscenes for now.
        setAnimState: () => {},
        setScripted: (scripted) => {
          if (scripted) {
            wasFrozen.value = player.frozen;
            player.frozen = true;
          } else {
            player.frozen = wasFrozen.value;
          }
        },
      };
    }
    const direct = entityRegistry.get(ref);
    const candidate =
      (direct && direct.kind === "npc" ? (direct as NpcModel) : undefined) ??
      (entityRegistry.get(`npc:${ref}`) as NpcModel | undefined);
    if (!candidate) return undefined;
    return {
      get x() { return candidate.x; },
      get y() { return candidate.y; },
      setPositionPx: (x, y) => candidate.setPositionPx(x, y),
      setFacing: (dir: CutsceneFacing) => {
        candidate.setFacing(dir);
      },
      setAnimState: (state) => {
        candidate.animState = state;
      },
      setScripted: (scripted) => {
        candidate.scripted = scripted;
        if (scripted) candidate.animState = "idle";
      },
    };
  }

  private cutsceneHost: CutsceneHost = {
    getActor: (ref) => this.resolveCutsceneActor(ref),
  };

  private async playCutsceneById(id: string): Promise<void> {
    const def = this.cutsceneData.cutscenes.find((c) => c.id === id);
    if (!def) {
      showToast(`Unknown cutscene: ${id}`, 1500);
      return;
    }
    if (this.activeDialogue) this.closeDialogue();
    // Always lock player input during a cutscene so the player can't walk
    // off and trigger a regular NPC dialogue while a script is running.
    // Restored in the `finally` so a thrown step still releases control.
    const wasFrozen = this.player.frozen;
    this.player.frozen = true;
    try {
      await this.cutsceneDirector.play(def);
    } finally {
      this.player.frozen = wasFrozen;
    }
  }

  /** (Re)spawn ground items from authored data, filtered by the picked-up set.
   *  Also re-spawns editor-placed items tracked in `editorItems`. */
  private respawnGroundItems() {
    for (const gi of this.groundItems.values()) gi.sprite.destroy();
    this.groundItems.clear();

    for (const s of this.authoredItems) this.addGroundItemSprite(s, "authored");
    for (const e of this.editorItems.values()) {
      this.addGroundItemSprite(
        {
          kind: "item_spawn",
          uid: e.id,
          tileX: e.tileX,
          tileY: e.tileY,
          itemId: e.itemId,
          quantity: e.quantity,
        },
        "editor",
      );
    }

    // Respawn player-dropped items that haven't expired yet. Drops live in a
    // shared, game-scoped store keyed by mapId; this scene only owns sprites
    // for entries on the world map.
    const now = Date.now();
    for (const d of this.droppedItemsState.listForMap("world")) {
      if (d.expiresAt <= now) continue;
      this.spawnDroppedSprite(d);
    }

    this.initialGroundItemsBuilt = true;
  }

  private addGroundItemSprite(s: ItemSpawn, _source: "authored" | "editor") {
    if (this.groundItemsState.isPickedUp(s.uid)) return;
    this.spawnGroundItemSprite({
      uid: s.uid,
      itemId: s.itemId,
      quantity: s.quantity,
      x: (s.tileX + 0.5) * TILE_SIZE,
      y: (s.tileY + 0.5) * TILE_SIZE,
      source: "static",
    });
  }

  /** Persist authored/editor item pickups so they don't respawn next session. */
  protected onStaticPickedUp(uid: string): void {
    this.groundItemsState.markPickedUp(uid);
  }

  /** Closest docked ship whose helm tile is within the player's interact
   *  radius, if any. */
  private shipAtHelm(): Ship | null {
    let best: Ship | null = null;
    let bestDist = HELM_INTERACT_RADIUS;
    for (const ship of this.ships.values()) {
      if (ship.mode !== "docked") continue;
      const helmTile = ship.helmTileForPose(ship.docked);
      const hx = (helmTile.x + 0.5) * TILE_SIZE;
      const hy = (helmTile.y + 0.5) * TILE_SIZE;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, hx, hy);
      if (d <= bestDist) {
        best = ship;
        bestDist = d;
      }
    }
    return best;
  }

  private isNearHelm(): boolean {
    return this.shipAtHelm() !== null;
  }

  // ─── Mount toggle ──────────────────────────────────────────────────
  // Pressing M summons / dismisses a horse. Only allowed on-foot; you can't
  // mount up mid-helm, mid-anchor, or during a forced dialogue freeze.
  private toggleMount(): void {
    if (this.sceneState.mode !== "OnFoot") return;
    if (this.activeDialogue) return;
    if (this.player.frozen) return;
    if (this.player.mounted) {
      this.player.setMount(null);
      showToast("Dismounted.", 1000);
    } else {
      this.player.setMount("horse-brown");
      showToast("Mounted.", 1000);
    }
  }

  // ─── Transition: OnFoot → AtHelm ──────────────────────────────────

  private takeHelm() {
    const ship = this.shipAtHelm();
    if (!ship) return;
    this.activeShip = ship;
    const helm = ship.helmWorldPx();
    this.player.setPosition(helm.x, helm.y);
    this.player.frozen = true;
    ship.startSailing();
    this.sceneState.mode = "AtHelm";
    this.cameras.main.startFollow(ship.container, true, 0.1, 0.1);
    showToast("WASD steer, Shift/Ctrl trim sails, R reverse, E anchor. Watch the wind!", 5000);
    void this.saveController.autosave();
  }

  // ─── Mode: AtHelm ─────────────────────────────────────────────────

  private updateAtHelm(dt: number) {
    const ship = this.activeShip;
    if (!ship) return;

    // 8-directional input vector from WASD / arrows. Same shape as the
    // player's on-foot movement. A held direction both thrusts and sets the
    // ship's facing (with a sticky-axis preference on diagonals). R thrusts
    // opposite the current heading without changing it — momentum does the
    // rest, so pressing R while moving forward first decelerates, then backs up.
    let dx = 0;
    let dy = 0;
    if (this.keys.w.isDown || this.keys.up.isDown) dy -= 1;
    if (this.keys.s.isDown || this.keys.down.isDown) dy += 1;
    if (this.keys.a.isDown || this.keys.left.isDown) dx -= 1;
    if (this.keys.d.isDown || this.keys.right.isDown) dx += 1;

    // Input sets a *target* bearing; the ship rotates toward it over
    // several frames rather than snapping. Thrust is always applied along
    // the current bow (not the input vector) — reverse is a separate key
    // that pushes backward without changing the target.
    let thrust = 0;
    if (dx !== 0 || dy !== 0) {
      thrust = 1;
      ship.setTargetHeading(Math.atan2(dy, dx));
    } else {
      ship.setTargetHeading(null);
      if (this.keys.reverse.isDown) thrust = -1;
    }

    // Sail trim: Shift eases out (more canvas), Ctrl reefs in. Edge-
    // triggered so a held key doesn't spam through all four states in a
    // single frame.
    if (Phaser.Input.Keyboard.JustDown(this.keys.reefSail)) {
      const before = ship.sail;
      const after = ship.adjustSail(-1);
      if (after !== before) showToast(`Sails: ${after}`, 1200);
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.easeSail)) {
      const before = ship.sail;
      const after = ship.adjustSail(1);
      if (after !== before) showToast(`Sails: ${after}`, 1200);
    }

    this.wind.update(dt);
    // Other hulls the player's ship can collide with: every other known
    // ship (docked or sailing). Built each frame from current poses so
    // anchoring / moving ships stay accurate without an event plumbing.
    const otherHulls: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const s of this.ships.values()) {
      if (s !== ship) otherHulls.push(s.hitboxAABB());
    }
    const step = ship.updateSailing(
      dt,
      thrust,
      (tx, ty) => this.world.manager.shipTileState(tx, ty),
      this.wind.vector(),
      otherHulls,
    );
    if (step.blocked) {
      if (!this.wasBlocked) showToast("Ran aground! Turn to clear water.", 2500);
      this.wasBlocked = true;
      this.wasBeached = false;
    } else if (step.beached) {
      if (!this.wasBeached) showToast("Run aground on the beach. Steer away or press R.", 2500);
      this.wasBeached = true;
      this.wasBlocked = false;
    } else {
      this.wasBeached = false;
      this.wasBlocked = false;
    }
    this.accrueSailingXp(dt);

    const helm = ship.helmWorldPx();
    this.player.setPosition(helm.x, helm.y);
    this.player.sprite.setRotation(0);
    this.player.setFacing(HEADING_TO_FACING[ship.heading]);
  }

  // ─── Transition: AtHelm → Anchoring → OnFoot ──────────────────────

  private beginAnchoring() {
    const ship = this.activeShip;
    if (!ship) return;
    const clearTarget = findAnchorPose(
      (tx, ty) => this.world.manager.isAnchorable(tx, ty),
      ship.x,
      ship.y,
      ship.heading,
      ship.dims,
      TILE_SIZE,
    );
    // Fallback: if no clear water is reachable (e.g. ship is stuck on land),
    // anchor in place at the ship's current pose so the player can always
    // step off. Rounded from the continuous sailing position.
    const target: DockedPose = clearTarget ?? this.currentShipPose(ship);
    const stuck = clearTarget === null;

    this.sceneState.mode = "Anchoring";
    ship.mode = "anchoring";
    ship.vx = 0;
    ship.vy = 0;

    const targetCenter = Ship.bboxCenterPx(target, ship.dims);
    ship.setPose(ship.x, ship.y, target.heading);

    this.tweens.add({
      targets: ship,
      x: targetCenter.x,
      y: targetCenter.y,
      duration: 1000,
      ease: "Cubic.easeOut",
      onUpdate: () => {
        ship.setPose(ship.x, ship.y);
        const helm = ship.helmWorldPx();
        this.player.setPosition(helm.x, helm.y);
        this.player.sprite.setRotation(0);
        this.player.setFacing(HEADING_TO_FACING[ship.heading]);
      },
      onComplete: () => this.finishAnchoring(target),
    });

    showToast(stuck ? "Anchoring in place…" : "Dropping anchor…", 1200);
  }

  private currentShipPose(ship: Ship): DockedPose {
    const cx = ship.x / TILE_SIZE;
    const cy = ship.y / TILE_SIZE;
    const eastWest = ship.heading === 1 || ship.heading === 3;
    const bboxW = eastWest ? ship.dims.tilesLong : ship.dims.tilesWide;
    const bboxH = eastWest ? ship.dims.tilesWide : ship.dims.tilesLong;
    return {
      tx: Math.round(cx - bboxW / 2),
      ty: Math.round(cy - bboxH / 2),
      heading: ship.heading,
    };
  }

  private finishAnchoring(pose: DockedPose) {
    const ship = this.activeShip;
    if (!ship) return;
    ship.finalizeDock(pose);
    const helm = ship.helmWorldPx();
    this.player.setPosition(helm.x, helm.y);
    this.player.sprite.setRotation(0);
    this.player.frozen = false;
    this.sceneState.mode = "OnFoot";
    this.activeShip = null;
    this.cameras.main.startFollow(this.player.sprite, true, 0.15, 0.15);
    showToast("Anchored. Walk around or step off the ship.", 3000);
    void this.saveController.autosave();
  }

  // ─── Save / load application ─────────────────────────────────────

  /**
   * Called after SaveManager hydrates registered systems (or with env=null
   * for New Game). Resets scene-level side effects — ground item sprites,
   * camera follow, player-frozen — so they agree with the restored state.
   */
  private applyAfterLoad(env: SaveEnvelope | null) {
    foodRegen.reset();
    if (!env) {
      useGameStore.getState().healthReset();
      useGameStore.getState().inventoryReset();
      useShopStore.getState().reset();
      this.groundItemsState.reset();
      this.droppedItemsState.reset();
      this.resetShipsAndParkPlayer();
    } else if (
      (this.sceneState.mode === "AtHelm" || this.sceneState.mode === "Anchoring") &&
      this.activeShip === null
    ) {
      // Save says the player was at a helm but no ship hydrated into
      // sailing/anchoring mode — e.g. the ships block failed schema validation
      // in SaveManager.hydrateFrom() and was silently skipped. Without a
      // rescue, the player is stranded in open water with no ship to board.
      // Reset ships to their ships.json defaults and park the player beside
      // the first one so the game is playable again.
      console.warn(
        "[WorldScene] Saved scene mode expected an active ship but none was hydrated — resetting ships to defaults.",
      );
      this.resetShipsAndParkPlayer();
      showToast("Your ship's state couldn't be restored. Returned to port.", 4000);
    }

    this.respawnGroundItems();
    this.applySceneMode();
    this.emitHud();
  }

  /** Force every ship back to its ships.json initial dock pose and park the
   *  player beside the first ship. Used both on fresh starts (no save) and
   *  as a rescue when the saved ship state is unrecoverable. */
  private resetShipsAndParkPlayer(): void {
    this.sceneState.mode = "OnFoot";
    this.activeShip = null;
    for (const inst of this.shipInstanceData) {
      const ship = this.ships.get(inst.id);
      if (!ship) continue;
      ship.finalizeDock({
        tx: inst.tileX,
        ty: inst.tileY,
        heading: inst.heading,
      });
    }
    const first = this.shipInstanceData[0];
    if (first) {
      this.player.setPosition(
        (first.tileX + 0.5) * TILE_SIZE,
        (first.tileY + 1.5) * TILE_SIZE,
      );
    }
  }

  /** Re-enter the current scene mode to fix up camera, freeze, helm parking. */
  private applySceneMode() {
    if (this.sceneState.mode === "Interior") {
      const ret = this.sceneState.interior;
      if (!ret) {
        // Save was inconsistent — drop back to OnFoot rather than trap the
        // player in a non-existent room.
        this.sceneState.mode = "OnFoot";
        this.sceneState.activeScene = "World";
      } else {
        // Sleep this scene and wake InteriorScene with the persisted return
        // tile + facing so on-exit we drop back outside the correct door.
        const f = ret.returnFacing;
        const returnFacing: Facing =
          (f === "up" || f === "down" || f === "left" || f === "right" ||
           f === "up-left" || f === "up-right" || f === "down-left" || f === "down-right")
            ? f
            : "down";
        this.player.frozen = false;
        this.sceneState.activeScene = "Interior";
        this.scene.sleep();
        this.scene.launch("Interior", {
          interiorKey: ret.interiorKey,
          entryTx: Math.floor(this.player.x / TILE_SIZE),
          entryTy: Math.floor(this.player.y / TILE_SIZE),
          returnWorldTx: ret.returnWorldTx,
          returnWorldTy: ret.returnWorldTy,
          returnFacing,
        });
        return;
      }
    }
    if (this.sceneState.mode === "AtHelm") {
      // activeShip is bound by hydrateShips() from the hydrated ship modes.
      // If it's still null here, applyAfterLoad's consistency check has
      // already rescued the player — this branch is just a paranoia guard.
      const ship = this.activeShip;
      if (!ship) {
        this.sceneState.mode = "OnFoot";
        this.player.frozen = false;
        this.player.sprite.setRotation(0);
        this.cameras.main.startFollow(this.player.sprite, true, 0.15, 0.15);
        return;
      }
      this.player.frozen = true;
      ship.mode = "sailing";
      const helm = ship.helmWorldPx();
      this.player.setPosition(helm.x, helm.y);
      this.player.sprite.setRotation(0);
      this.player.setFacing(HEADING_TO_FACING[ship.heading]);
      this.cameras.main.startFollow(ship.container, true, 0.1, 0.1);
    } else {
      // Anchoring mid-save is degraded to OnFoot on load.
      if (this.sceneState.mode === "Anchoring") this.sceneState.mode = "OnFoot";
      this.player.frozen = false;
      this.player.sprite.setRotation(0);
      this.cameras.main.startFollow(this.player.sprite, true, 0.15, 0.15);
    }
  }

  // ─── Walkability ─────────────────────────────────────────────────

  protected isWalkablePx(px: number, py: number, ignoreEnemy?: Enemy): boolean {
    // Feet hitbox: axis-aligned rectangle centered on (px, py + offsetY).
    const hw = PLAYER_FEET_WIDTH / 2;
    const hh = PLAYER_FEET_HEIGHT / 2;
    const cy = py + PLAYER_FEET_OFFSET_Y;
    const samples: [number, number][] = [
      [px, cy],
      [px + hw, cy + hh],
      [px - hw, cy + hh],
      [px + hw, cy - hh],
      [px - hw, cy - hh],
    ];
    for (const [sx, sy] of samples) {
      if (!this.isPointWalkable(sx, sy, ignoreEnemy)) return false;
    }
    return true;
  }

  private isPointWalkable(px: number, py: number, ignoreEnemy?: Enemy): boolean {
    const tx = Math.floor(px / TILE_SIZE);
    const ty = Math.floor(py / TILE_SIZE);
    let onDeck = false;
    for (const ship of this.ships.values()) {
      if (ship.mode !== "docked") continue;
      if (Ship.footprint(ship.docked, ship.dims).some((t) => t.x === tx && t.y === ty)) {
        onDeck = true;
        break;
      }
    }
    // On a docked ship's deck, the deck is the walkable surface — the tiles
    // beneath (water, beach, or colliding ground) are irrelevant.
    if (!onDeck) {
      if (this.world.manager.isWater(tx, ty)) return false;
      if (this.world.manager.isBlockedPx(px, py)) return false;
    }
    for (const node of this.nodes) {
      if (node.blocksPx(px, py)) return false;
    }
    for (const st of this.craftingStations) {
      if (st.blocksPx(px, py)) return false;
    }
    for (const c of this.chests) {
      if (c.blocksPx(px, py)) return false;
    }
    for (const s of this.signs) {
      if (s.blocksPx(px, py)) return false;
    }
    // Enemies only collide with each other — players and enemies pass through freely.
    if (ignoreEnemy) {
      for (const enemy of this.enemies) {
        if (enemy === ignoreEnemy) continue;
        if (enemy.blocksPx(px, py)) return false;
      }
    }
    return true;
  }

  private onScaleResize(gameSize: Phaser.Structs.Size) {
    this.cameras.main.setViewport(0, 0, gameSize.width, gameSize.height);
  }

  private emitHud() {
    const hudMode =
      this.sceneState.mode === "AtHelm"
        ? "AtHelm"
        : this.sceneState.mode === "Anchoring"
          ? "Anchoring"
          : this.shipAtPlayer()
            ? "OnDeck"
            : "OnFoot";

    let prompt: string | null = null;
    if (this.sceneState.mode === "OnFoot" && !this.activeDialogue) {
      const npc = this.nearestNpc();
      const station = this.nearestCraftingStation();
      if (npc) {
        prompt = `Press E to talk to ${npc.def.name}`;
      } else if (station) {
        prompt = `Press E to use ${station.def.name}`;
      } else if (this.nearestChest()) {
        prompt = `Press E to open ${this.nearestChest()!.def.name}`;
      } else if (this.nearestSign()) {
        const sign = this.nearestSign()!;
        const owned =
          useBusinessStore.getState().get(sign.businessId)?.owned ?? false;
        prompt = owned ? "Press E to manage" : "Press E to inspect";
      } else {
        const pickup = this.nearestGroundItem();
        if (pickup) {
          const def = ITEMS[pickup.itemId];
          const qty = pickup.quantity > 1 ? ` ×${pickup.quantity}` : "";
          prompt = `Press E to pick up ${def.name}${qty}`;
        } else if (this.isNearHelm() && !this.player.mounted) {
          prompt = "Press E to take the helm";
        } else if (!this.player.mounted) {
          const enemy = this.nearestEnemyInReach(TILE_SIZE * 1.4);
          const mainHandPeek = useGameStore.getState().equipment.equipped.mainHand;
          if (enemy) {
            if (mainHandPeek === "sword" || mainHandPeek === "cutlass") {
              prompt = `Press Q to attack ${enemy.def.name}`;
            } else {
              prompt = `Equip a sword to fight ${enemy.def.name}`;
            }
          } else {
            const node = this.nearestAnyNodeInReach();
            if (node) {
              const tool = ITEMS[node.def.requiredTool];
              const mainHand = useGameStore.getState().equipment.equipped.mainHand;
              if (mainHand === node.def.requiredTool) {
                prompt = `Press Q to harvest ${node.def.name}`;
              } else {
                prompt = `Equip a ${tool?.name ?? node.def.requiredTool} to harvest ${node.def.name}`;
              }
            }
          }
        }
      }
    }

    const showSailingHud =
      this.sceneState.mode === "AtHelm" || this.sceneState.mode === "Anchoring";
    setHud({
      mode: hudMode,
      prompt,
      speed: this.activeShip ? Math.round(this.activeShip.speed) : 0,
      heading: this.activeShip ? normalizeAngle(this.activeShip.headingRad) : 0,
      stamina: Math.round(stamina.current),
      staminaMax: STAMINA_MAX,
      shipMaxSpeed: showSailingHud ? SHIP_MAX_SPEED : null,
      sail:
        showSailingHud && this.activeShip
          ? { state: this.activeShip.sail }
          : null,
    });
  }

  /**
   * Accrue Sailing XP proportional to distance covered under sail.
   * 1 XP per ~8 pixels of travel — a comfortable pace for early levels
   * without trivialising the curve.
   */
  private accrueSailingXp(dt: number) {
    if (!this.activeShip) return;
    const traveled = Math.abs(this.activeShip.speed) * dt;
    if (traveled <= 0) return;
    this.sailingXpAccum += traveled / 8;
    if (this.sailingXpAccum >= 1) {
      const whole = Math.floor(this.sailingXpAccum);
      this.sailingXpAccum -= whole;
      useGameStore.getState().jobsAddXp("sailing", whole);
    }
  }

  private grantDebugXp() {
    const id = ALL_JOB_IDS[Math.floor(Math.random() * ALL_JOB_IDS.length)];
    const amount = 250 + Math.floor(Math.random() * 750);
    useGameStore.getState().jobsAddXp(id, amount);
    showToast(`+${amount} ${id} XP`, 1200);
  }

  // ─── Authored item instances ─────────────────────────────────────
  // Loaded from src/game/data/itemInstances.json (authored via /editor).

  private loadEditorItems() {
    const file = itemInstancesRaw as ItemInstancesFile;
    for (const inst of file.instances) {
      if (inst.map && inst.map !== "world") continue;
      this.editorItems.set(inst.id, {
        id: inst.id,
        itemId: inst.itemId as ItemId,
        quantity: inst.quantity,
        tileX: inst.tileX,
        tileY: inst.tileY,
      });
    }
  }

  private grantRandomItem() {
    const id = ALL_ITEM_IDS[Math.floor(Math.random() * ALL_ITEM_IDS.length)];
    const qty = ITEMS[id].stackable ? 1 + Math.floor(Math.random() * 5) : 1;
    const leftover = useGameStore.getState().inventoryAdd(id, qty);
    const added = qty - leftover;
    if (added > 0) {
      showToast(`+${added} ${ITEMS[id].name}`, 1500);
    } else {
      showToast("Inventory is full.", 1500);
    }
  }
}

/** Iterate NpcModel entries in the registry filtered by map. */
function* npcModelsIn(mapId: MapId): Iterable<NpcModel> {
  for (const m of entityRegistry.getByMap(mapId)) {
    if (m.kind === "npc") yield m as NpcModel;
  }
}

// Vite HMR: when src/game/data/npcs.json changes, respawn NPCs in the
// running scene without reloading the page. Sprite sheets already in the
// Phaser texture cache are reused; new sheet references would need a full
// reload.
if (import.meta.hot) {
  import.meta.hot.accept("../data/npcs.json", (mod) => {
    if (!mod || !activeWorldScene) return;
    const data = ((mod as unknown) as { default?: NpcData }).default ?? ((mod as unknown) as NpcData);
    activeWorldScene.reloadNpcs(data);
    showToast("NPCs reloaded.", 1200);
  });
}
