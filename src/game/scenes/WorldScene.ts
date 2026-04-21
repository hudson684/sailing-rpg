import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import {
  bus,
  type DialogueAction,
  type EditDeleteRequest,
  type EditEntityKind,
  type EditMoveRequest,
  type EditPlaceRequest,
  type EditShopUpdate,
  type EditSnapshot,
  type InventoryAction,
} from "../bus";
import { ALL_ITEM_IDS, ITEMS } from "../inventory/items";
import { ALL_JOB_IDS } from "../jobs/jobs";
import { useGameStore } from "../store/gameStore";
import { useShopStore } from "../store/shopStore";
import { useSettingsStore } from "../store/settingsStore";
import { setHud, showToast } from "../../ui/store/ui";
import {
  Player,
  PLAYER_SPEED,
  PLAYER_FEET_WIDTH,
  PLAYER_FEET_HEIGHT,
  PLAYER_FEET_OFFSET_Y,
  getOrCreatePlayerModel,
  type Facing,
} from "../entities/Player";
import { syncPlayerVisualsFromEquipment } from "../entities/playerEquipmentVisuals";
import { stamina, STAMINA_MAX } from "../player/stamina";
import { healthRegen } from "../player/regen";
import { CF_WARDROBE_LAYERS } from "../entities/playerWardrobe";
import {
  Ship,
  normalizeAngle,
  type DockedPose,
  type Heading,
} from "../entities/Ship";
import { loadShipsFile, type ShipInstanceData, type VesselTemplate } from "../entities/vessels";
import type { VirtualKey } from "../input/virtualInput";
import { bindSceneToVirtualInput } from "../input/virtualInputBridge";

const SPRINT_SPEED_MULT = 1.35;

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
} from "../world/spawns";
import { type WorldManifest } from "../world/chunkManager";
import type { InteriorReturnData } from "./InteriorScene";
import { findAnchorPose } from "../util/anchor";
import {
  CHUNK_KEY_PREFIX,
  WORLD_MANIFEST_KEY,
  itemIconTextureKey,
} from "../assets/keys";
import { NpcSprite, NPC_INTERACT_RADIUS, registerNpcAnimations } from "../entities/NpcSprite";
import { NpcModel } from "../entities/NpcModel";
import { SpriteReconciler } from "../entities/SpriteReconciler";
import { entityRegistry } from "../entities/registry";
import type { MapId } from "../entities/mapId";
import { worldTicker } from "../entities/WorldTicker";
import { addNpc, clearNpcs, bootstrapNpcs, removeNpcById } from "../entities/npcBootstrap";
import { SKIN_PALETTES, bakePlayerSkin, type SkinPaletteId } from "../entities/playerSkin";
import {
  type NpcData,
  type DialogueDef,
} from "../entities/npcTypes";
import npcDataRaw from "../data/npcs.json";
import { DebugOverlays, type OverlayName } from "../debug/DebugOverlays";
import { GroundItemsState } from "../world/groundItemsState";
import { DroppedItemsState, type DroppedItem } from "../world/droppedItemsState";
import {
  GatheringNode,
  NODE_INTERACT_RADIUS,
  indexDefs,
  loadNodesFile,
} from "../world/GatheringNode";
import nodesDataRaw from "../data/nodes.json";
import {
  CraftingStation,
  STATION_INTERACT_RADIUS,
} from "../world/CraftingStation";
import {
  craftingStations,
  craftingStationInstances,
} from "../crafting/stations";
import { recipes as recipeRegistry } from "../crafting/recipes";
import { applyCraft, hasAllInputs } from "../crafting/operations";
import type { RecipeDef } from "../crafting/types";
import { useCraftingStore } from "../store/craftingStore";
import type {
  CraftingBeginRequest,
  CraftingCompleteResult,
} from "../bus";
import { Enemy, registerEnemyAnimations } from "../entities/Enemy";
import { Projectile, rayBlocked } from "../entities/Projectile";
import type {
  DropTable,
  DropTablesFile,
  EnemiesFile,
  EnemyDef,
  EnemyInstanceData,
} from "../entities/enemyTypes";
import enemiesDataRaw from "../data/enemies.json";
import dropTablesDataRaw from "../data/dropTables.json";
import itemInstancesRaw from "../data/itemInstances.json";
import shopsDataRaw from "../data/shops.json";
import type { NodeDef, NodeInstanceData } from "../world/GatheringNode";
import type { ShopDef } from "../shops/types";
import type { ItemId } from "../inventory/items";
import { spawnFloatingNumber } from "../fx/floatingText";
import {
  SaveController,
  SceneState,
  systems as saveSystems,
  type SaveEnvelope,
} from "../save";
import { setActiveSaveController } from "../save/activeController";
import { PREFETCHED_SAVE_REGISTRY_KEY } from "./PreloadScene";

const HELM_INTERACT_RADIUS = TILE_SIZE * 0.7;
const DOOR_INTERACT_RADIUS = TILE_SIZE * 0.9;
const PICKUP_RADIUS = TILE_SIZE * 0.8;
const SHOP_CLICK_RADIUS = TILE_SIZE * 1.5;
/** Time after last damage before player HP regen kicks in. */
/** Tile where a new game drops the player — center of the starter village
 *  on the chunk (1,0) island, not at the dock. Loaded saves override this
 *  via the hydrated player position. */
const DEFAULT_PLAYER_SPAWN_TILE = { x: 48, y: 17 } as const;

const ZOOM_STEPS = [0.5, 1, 1.5, 2, 3, 4, 6, 8] as const;
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const ZOOM_SMOOTH_RATE = 12;
const ZOOM_SNAP_EPSILON = 0.001;
const WHEEL_SETTLE_MS = 140;

interface GroundItem {
  uid: string;
  itemId: ItemId;
  quantity: number;
  x: number;
  y: number;
  sprite: Phaser.GameObjects.Image;
  /** "authored" = from map TMJ; "editor" = from itemInstances.json (also
   *  dev-authored, but mutable via the in-game edit overlay); "dropped" =
   *  player-dropped at runtime with a TTL. */
  source: "authored" | "editor" | "dropped";
}

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

interface ShopsFile {
  shops: ShopDef[];
}

interface EditorItemData {
  id: string;
  itemId: ItemId;
  quantity: number;
  tileX: number;
  tileY: number;
}

/**
 * Snap a radian angle to the nearest 8-way `Facing`. The player sprite sheets
 * only ship 8 directions, so every aim angle collapses to the closest octant
 * for rendering purposes — the projectile still flies at the true angle.
 */
function angleToFacing(angle: number): Facing {
  // Normalize to [0, 2π). 0 rad = "right"; angles grow clockwise in screen
  // space (+y points down in Phaser world coords).
  const twoPi = Math.PI * 2;
  let a = angle % twoPi;
  if (a < 0) a += twoPi;
  const octant = Math.round(a / (Math.PI / 4)) % 8;
  const byOctant: Facing[] = [
    "right",
    "down-right",
    "down",
    "down-left",
    "left",
    "up-left",
    "up",
    "up-right",
  ];
  return byOctant[octant];
}

let activeWorldScene: WorldScene | null = null;

export class WorldScene extends Phaser.Scene {
  private world!: WorldMap;
  private player!: Player;
  /** All ship instances, keyed by instance id. */
  private ships = new Map<string, Ship>();
  /** Cached vessel defs (for edit-mode placement and respawn). */
  private shipDefs = new Map<string, VesselTemplate>();
  /** Initial instance list from ships.json (for resetting on new game). */
  private shipInstanceData: ShipInstanceData[] = [];
  /** Ship the player is currently piloting / anchoring aboard. */
  private activeShip: Ship | null = null;
  private readonly groundItemsState = new GroundItemsState();
  private readonly droppedItemsState = new DroppedItemsState();
  private droppedExpiryAccum = 0;
  private readonly sceneState = new SceneState();
  private readonly saveController = new SaveController({
    getSceneKey: () => "World",
    onApplied: (env) => this.applyAfterLoad(env),
    canAutosave: () => this.sceneState.mode !== "Anchoring",
  });
  private groundItems = new Map<string, GroundItem>();
  private doors: DoorSpawn[] = [];
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
  private craftingStations: CraftingStation[] = [];
  private enemies: Enemy[] = [];
  private projectiles: Projectile[] = [];
  /** Monotonic ms remaining until the player may fire their bow again. */
  private bowCooldownMs = 0;
  /** Graphics layer for the bow aiming reticle. Hidden unless a bow is equipped. */
  private bowReticle?: Phaser.GameObjects.Graphics;
  private dropTables = new Map<string, DropTable>();
  /** Owns scene-local sprites for world-mapped NPC models. Interior NPC
   *  sprites are owned by InteriorScene's own reconciler. */
  private npcReconciler!: SpriteReconciler<NpcSprite>;
  /** Cached NPC data used for edit-mode templates and export. The registry
   *  is source-of-truth for runtime state; this stays for authoring flows. */
  private npcData: NpcData = npcDataRaw as NpcData;
  private dialogues: Record<string, DialogueDef> = {};
  private activeDialogue: { speaker: string; pages: string[]; page: number; shopId?: string } | null = null;

  // ── Edit mode ──────────────────────────────────────────────────
  private editMode = false;
  private editHighlight?: Phaser.GameObjects.Graphics;
  private editDrag:
    | { kind: EditEntityKind; id: string; startWorldX: number; startWorldY: number; moved: boolean }
    | null = null;
  /** Editor-placed ground items (sidecar to TMJ-authored items). Keyed by uid.
   *  Survives across edit-mode toggles inside one session; serialized to
   *  itemInstances.json on save. */
  private editorItems = new Map<string, EditorItemData>();
  private editAutoIncrement = 0;
  /** Cached defs the React overlay can pick from when placing new entities. */
  private enemyDefs = new Map<string, EnemyDef>();
  private nodeDefs = new Map<string, NodeDef>();
  /** Initial shops (mutated by edit:shopUpdate; read on snapshot). */
  private shopsForEdit: ShopDef[] = [];

  private zoomTarget = useSettingsStore.getState().zoom;
  private wheelZoomDir: 1 | -1 | 0 = 0;
  private lastWheelAt = 0;

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
    // advance
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
    const manifest = this.cache.json.get(WORLD_MANIFEST_KEY) as WorldManifest;
    // Spawns arrive as chunks instantiate — once synchronously here for every
    // chunk whose tilesets were in the eager preload batch, and again later
    // for each streamed chunk in `streamRemainingChunks`. Append to
    // scene-level lists and (when the initial rebuild is done) drop each
    // new authored item into the world as its own sprite.
    this.doors = [];
    this.authoredItems = [];
    this.world = loadWorld({
      scene: this,
      manifest,
      chunkKeyPrefix: CHUNK_KEY_PREFIX,
      onChunkReady: (_chunk, spawns) => {
        this.doors.push(...spawns.doors);
        this.authoredItems.push(...spawns.items);
        if (this.initialGroundItemsBuilt) {
          for (const s of spawns.items) this.addGroundItemSprite(s, "authored");
        }
      },
    });

    const spawnPx = {
      x: (DEFAULT_PLAYER_SPAWN_TILE.x + 0.5) * TILE_SIZE,
      y: (DEFAULT_PLAYER_SPAWN_TILE.y + 0.5) * TILE_SIZE,
    };
    // Model is shared across scenes (registry-owned, survives sleep/wake);
    // the sprite is scene-local and torn down on shutdown.
    const playerModel = getOrCreatePlayerModel({ x: spawnPx.x, y: spawnPx.y });
    entityRegistry.setMap(playerModel.id, { kind: "world" });
    this.player = new Player(this, playerModel);

    const shipsFile = loadShipsFile();
    this.shipDefs = shipsFile.defs;
    this.shipInstanceData = shipsFile.instances.map((i) => ({ ...i }));
    for (const inst of this.shipInstanceData) {
      this.spawnShip(inst);
    }

    this.loadEditorItems();
    this.respawnGroundItems();
    // Populate the registry before subscribing the reconciler so it picks up
    // existing models via getByMap with this live scene, instead of being
    // triggered by registry mutations from outside the scene lifecycle.
    bootstrapNpcs(this.npcData);
    this.setupNpcReconciler();
    this.spawnGatheringNodes();
    this.spawnCraftingStations();
    this.loadDropTables();
    this.spawnEnemies();
    this.shopsForEdit = (shopsDataRaw as ShopsFile).shops.map((s) => ({
      ...s,
      stock: s.stock.map((row) => ({ ...row })),
    }));

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
    this.cameras.main.setZoom(this.zoomTarget);

    // Keep the camera viewport in sync with the canvas when it resizes
    // (window resize, orientation change, mobile URL-bar collapse). Without
    // this the main camera stays at its initial size and anything past it
    // renders as the WebGL clear colour (black).
    this.scale.on("resize", this.onScaleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off("resize", this.onScaleResize, this);
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
    };

    this.input.keyboard!.addCapture([
      Phaser.Input.Keyboard.KeyCodes.SHIFT,
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
      helmThrottleUp: this.keys.sprint,
      helmThrottleDown: this.keys.reverse,
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
        if (this.editMode && pointer.leftButtonDown()) {
          this.onEditPointerDown(pointer.worldX, pointer.worldY);
          return;
        }
        if (pointer.leftButtonDown()) {
          this.onLeftClick(pointer.worldX, pointer.worldY);
          return;
        }
        if (!pointer.rightButtonDown()) return;
        this.onRightClick(pointer.worldX, pointer.worldY);
      },
    );
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.editMode || !this.editDrag) return;
      this.onEditPointerMove(pointer.worldX, pointer.worldY);
    });
    this.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
      if (!this.editMode) return;
      this.onEditPointerUp(pointer.worldX, pointer.worldY);
    });
    this.keys.attack.on("down", () => this.onAttack());

    // Number keys 1–5 quick-equip the corresponding hotbar slot's item.
    const digitCodes = [
      Phaser.Input.Keyboard.KeyCodes.ONE,
      Phaser.Input.Keyboard.KeyCodes.TWO,
      Phaser.Input.Keyboard.KeyCodes.THREE,
      Phaser.Input.Keyboard.KeyCodes.FOUR,
      Phaser.Input.Keyboard.KeyCodes.FIVE,
    ];
    digitCodes.forEach((code, i) => {
      const key = this.input.keyboard!.addKey(code);
      key.on("down", () => this.onHotbarKey(i));
    });
    this.keys.debugGrant.on("down", () => this.grantRandomItem());
    this.keys.debugXp.on("down", () => this.grantDebugXp());
    this.keys.quicksave.on("down", () => void this.saveController.save("quicksave"));
    this.keys.quickload.on("down", () => void this.saveController.load("quicksave"));
    this.keys.mount.on("down", () => this.toggleMount());

    // Camera zoom: mouse wheel + `+`/`=` and `-` keys.
    const zoomInPlus = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.PLUS);
    const zoomInEq = this.input.keyboard!.addKey("=");
    const zoomOut = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.MINUS);
    zoomInPlus.on("down", () => this.stepZoomKeyboard(+1));
    zoomInEq.on("down", () => this.stepZoomKeyboard(+1));
    zoomOut.on("down", () => this.stepZoomKeyboard(-1));
    this.input.on(
      "wheel",
      (_p: unknown, _o: unknown, _dx: number, dy: number) => {
        if (dy === 0) return;
        const factor = Math.exp(-dy * WHEEL_ZOOM_SENSITIVITY);
        this.zoomTarget = Phaser.Math.Clamp(
          this.zoomTarget * factor,
          MIN_ZOOM,
          MAX_ZOOM,
        );
        useSettingsStore.getState().setZoom(this.zoomTarget);
        this.wheelZoomDir = dy < 0 ? 1 : -1;
        this.lastWheelAt = this.time.now;
      },
    );

    this.editHighlight = this.add.graphics().setDepth(9500).setVisible(false);

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
    }

    bus.onTyped("inventory:action", this.onInventoryAction);
    bus.onTyped("dialogue:action", this.onDialogueAction);
    bus.onTyped("skin:apply", this.onSkinApply);
    bus.onTyped("crafting:begin", this.onCraftingBegin);
    bus.onTyped("crafting:complete", this.onCraftingComplete);
    bus.onTyped("crafting:cancel", this.onCraftingCancel);
    if (import.meta.env.DEV) {
      bus.onTyped("edit:toggle", this.onEditToggle);
      bus.onTyped("edit:requestSnapshot", this.onEditRequestSnapshot);
      bus.onTyped("edit:move", this.onEditMove);
      bus.onTyped("edit:place", this.onEditPlace);
      bus.onTyped("edit:delete", this.onEditDelete);
      bus.onTyped("edit:shopUpdate", this.onEditShopUpdate);
      bus.onTyped("edit:requestExport", this.onEditRequestExport);
      bus.onTyped("player:resetSpawn", this.onResetSpawn);
      bus.onTyped("ships:resetAll", this.onResetAllShips);
      const editKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F7);
      editKey.on("down", () => bus.emitTyped("edit:toggle"));
    }
    activeWorldScene = this;

    // Mirror the equipment loadout onto the player's paper-doll. Apply the
    // current state once for the initial render, then subscribe so future
    // equip/unequip ops re-sync. The selector returns the equipped map by
    // reference, so Zustand's default Object.is comparison fires only when a
    // store action actually replaces it.
    // Apply the wardrobe baseline first, then layer equipment overlays on top
    // so an equipped chest piece (e.g.) wins over the wardrobe shirt.
    const initialWardrobe = useSettingsStore.getState().wardrobe;
    for (const layer of CF_WARDROBE_LAYERS) {
      this.player.setBaselineLayer(layer, initialWardrobe[layer] ?? null);
    }
    syncPlayerVisualsFromEquipment(this.player, useGameStore.getState().equipment.equipped);
    const unsubEquipment = useGameStore.subscribe((state, prev) => {
      if (state.equipment.equipped === prev.equipment.equipped) return;
      syncPlayerVisualsFromEquipment(this.player, state.equipment.equipped);
    });
    const unsubWardrobe = useSettingsStore.subscribe((state, prev) => {
      if (state.wardrobe === prev.wardrobe) return;
      for (const layer of CF_WARDROBE_LAYERS) {
        const next = state.wardrobe[layer] ?? null;
        const previous = prev.wardrobe[layer] ?? null;
        if (next !== previous) this.player.setBaselineLayer(layer, next);
      }
      // Re-overlay equipment so a wardrobe change to a slot occupied by gear
      // doesn't visually drop the equipped item.
      syncPlayerVisualsFromEquipment(this.player, useGameStore.getState().equipment.equipped);
    });

    this.events.on(Phaser.Scenes.Events.WAKE, (_sys: unknown, data: InteriorReturnData | undefined) => {
      this.onInteriorWake(data);
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      bus.offTyped("inventory:action", this.onInventoryAction);
      bus.offTyped("dialogue:action", this.onDialogueAction);
      bus.offTyped("skin:apply", this.onSkinApply);
      bus.offTyped("crafting:begin", this.onCraftingBegin);
      bus.offTyped("crafting:complete", this.onCraftingComplete);
      bus.offTyped("crafting:cancel", this.onCraftingCancel);
      if (import.meta.env.DEV) {
        bus.offTyped("edit:toggle", this.onEditToggle);
        bus.offTyped("edit:requestSnapshot", this.onEditRequestSnapshot);
        bus.offTyped("edit:move", this.onEditMove);
        bus.offTyped("edit:place", this.onEditPlace);
        bus.offTyped("edit:delete", this.onEditDelete);
        bus.offTyped("edit:shopUpdate", this.onEditShopUpdate);
        bus.offTyped("edit:requestExport", this.onEditRequestExport);
        bus.offTyped("player:resetSpawn", this.onResetSpawn);
        bus.offTyped("ships:resetAll", this.onResetAllShips);
      }
      unsubEquipment();
      unsubWardrobe();
      this.unsubVirtualInput?.();
      this.unsubVirtualInput = null;
      if (activeWorldScene === this) activeWorldScene = null;
      for (const e of this.enemies) entityRegistry.remove(e.id);
      this.enemies = [];
      for (const p of this.projectiles) p.destroy();
      this.projectiles = [];
      this.bowReticle?.destroy();
      this.bowReticle = undefined;
      worldTicker.unregisterWalkable({ kind: "world" });
      this.npcReconciler?.shutdown();
      // Destroy the scene-local sprite; the PlayerModel persists in the
      // registry and rebinds to whichever scene wakes next.
      this.player?.destroy();
      this.saveController.shutdown();
    });

    setHud({
      mode: "OnFoot",
      prompt: null,
      speed: 0,
      heading: 0,
      message: null,
    });
    showToast("WASD/Arrows to move. E interact. ESC menu.", 4000);

    void this.initSave();
  }

  private async initSave(): Promise<void> {
    await this.saveController.init();
    setActiveSaveController(this.saveController);
    this.saveController.registerSystems([
      saveSystems.inventorySaveable(),
      saveSystems.equipmentSaveable(),
      saveSystems.jobsSaveable(),
      saveSystems.healthSaveable(),
      saveSystems.playerSaveable(this.player),
      saveSystems.shipsSaveable(() => Array.from(this.ships.values()), (states) => this.hydrateShips(states)),
      saveSystems.groundItemsSaveable(this.groundItemsState),
      saveSystems.droppedItemsSaveable(this.droppedItemsState),
      saveSystems.sceneSaveable(this.sceneState),
      saveSystems.appearanceSaveable(),
      saveSystems.shopsSaveable(),
    ]);
    await this.saveController.refreshMenu();
    // If PreloadScene prefetched the latest envelope while the title was up,
    // hydrate from it synchronously here — no IDB round-trip on the critical
    // path. We pop it from the registry so a later scene re-entry can't apply
    // a stale snapshot.
    const registry = this.game.registry;
    if (registry.has(PREFETCHED_SAVE_REGISTRY_KEY)) {
      const prefetched = registry.get(PREFETCHED_SAVE_REGISTRY_KEY) as SaveEnvelope | null;
      registry.remove(PREFETCHED_SAVE_REGISTRY_KEY);
      this.saveController.loadPrefetched(prefetched);
    } else {
      await this.saveController.loadLatest();
    }
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
    // Pull NPC sprites forward to match models mutated by the global ticker.
    this.npcReconciler?.syncAll();
    this.updateZoom(dtMs);
    this.emitHud();
    this.debug.update();
  }

  private tickExterior(dt: number, dtMs: number) {
    this.world.manager.tick(dtMs);
    if (this.editMode) {
      this.redrawEditHighlights();
      return;
    }
    if (this.sceneState.mode === "OnFoot" && !this.activeDialogue) this.updateOnFoot(dt);
    else if (this.sceneState.mode === "AtHelm") this.updateAtHelm(dt);
    else if (this.sceneState.mode === "Anchoring") {
      // Tween drives the ship; nothing to do here.
    }
    for (const node of this.nodes) node.update(this.time.now);
    // Enemies are passive while the player is at the helm or anchoring.
    const playerCtx =
      this.sceneState.mode === "OnFoot"
        ? {
            x: this.player.x,
            y: this.player.y,
            onHit: (dmg: number) => this.onPlayerHit(dmg),
          }
        : undefined;
    for (const enemy of this.enemies) {
      enemy.update(
        dtMs,
        this.time.now,
        (x, y) => this.isWalkablePx(x, y, enemy),
        playerCtx,
      );
    }
    this.updateProjectiles(dtMs);
    this.updateBowReticle();
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
    let dx = 0;
    let dy = 0;
    if (this.keys.left.isDown || this.keys.a.isDown) dx -= 1;
    if (this.keys.right.isDown || this.keys.d.isDown) dx += 1;
    if (this.keys.up.isDown || this.keys.w.isDown) dy -= 1;
    if (this.keys.down.isDown || this.keys.s.isDown) dy += 1;
    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.SQRT2;
      dx *= inv;
      dy *= inv;
    }
    const moving = dx !== 0 || dy !== 0;
    const mounted = this.player.mounted;
    // Mounts cruise at sprint speed without burning stamina — that's the
    // whole point of climbing onto one.
    const sprinting = !mounted && moving && this.keys.sprint.isDown && stamina.current > 0;
    if (sprinting) stamina.drain(dt);
    const speed = PLAYER_SPEED * (mounted || sprinting ? SPRINT_SPEED_MULT : 1);
    this.player.tryMove(dx * speed * dt, dy * speed * dt, (px, py) =>
      this.isWalkablePx(px, py),
    );
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

  private onHotbarKey(index: number) {
    if (this.activeDialogue) return;
    if (this.sceneState.mode !== "OnFoot") return;
    if (useShopStore.getState().openShopId) return;
    const store = useGameStore.getState();
    const slot = store.inventory.slots[index];
    if (!slot) return;
    const def = ITEMS[slot.itemId];
    if (def?.consumable) {
      const res = store.useConsumable(index);
      if (!res.ok && res.reason === "no_effect") showToast("Already at full health.", 1200);
      else if (res.ok && def.consumable.healHp) showToast(`+${def.consumable.healHp} HP`, 1200, "success");
      return;
    }
    if (!def?.slot) return;
    const res = store.equipFromInventory(index);
    if (!res.ok && res.reason === "inventory_full") {
      showToast("Inventory full", 1500);
    }
  }

  /** Apply enemy damage to the player. Handles death → respawn at the dock. */
  private onPlayerHit(damage: number) {
    if (damage <= 0) return;
    const taken = useGameStore.getState().healthDamage(damage);
    if (taken <= 0) return;
    healthRegen.noteDamage();
    this.flashPlayer();
    spawnFloatingNumber(this, this.player.x, this.player.y - 22, taken, {
      kind: "damage-player",
    });
    if (useGameStore.getState().health.current <= 0) this.handlePlayerDeath();
  }


  private flashPlayer() {
    this.tweens.add({
      targets: this.player.sprite,
      alpha: 0.35,
      duration: 80,
      yoyo: true,
      repeat: 1,
    });
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

  private handlePlayerDeath() {
    showToast("You were defeated. Respawning…", 2500, "error");
    this.player.setPosition(
      (DEFAULT_PLAYER_SPAWN_TILE.x + 0.5) * TILE_SIZE,
      (DEFAULT_PLAYER_SPAWN_TILE.y + 0.5) * TILE_SIZE,
    );
    useGameStore.getState().healthReset();
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
    this.sceneState.mode = "OnFoot";
    this.sceneState.activeScene = "World";
    this.sceneState.interior = null;
    if (ret) {
      this.player.setPosition(
        (ret.returnWorldTx + 0.5) * TILE_SIZE,
        (ret.returnWorldTy + 1.5) * TILE_SIZE,
      );
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

  private onAttack() {
    if (this.activeDialogue) return;
    if (this.sceneState.mode !== "OnFoot") return;
    const mainHand = useGameStore.getState().equipment.equipped.mainHand;

    // If a matching gathering node is in reach, harvest it.
    const node = this.nearestNodeForTool(mainHand);
    if (node) {
      this.gatherFrom(node);
      return;
    }

    if (mainHand === "pickaxe") {
      const ok = this.player.playAction("mine", () => {
        useGameStore.getState().jobsAddXp("orecheologist", 10);
      });
      if (!ok) return;
      showToast("Mining…", 800);
    } else if (mainHand === "axe") {
      const ok = this.player.playAction("chop", () => {});
      if (!ok) return;
      showToast("No tree in reach.", 1200);
    } else if (mainHand === "fishing_rod") {
      const ok = this.player.playAction("fish", () => {});
      if (!ok) return;
      showToast("No fishing spot in reach.", 1200);
    } else if (mainHand === "sword" || mainHand === "cutlass") {
      const reach = TILE_SIZE * 1.4;
      const target = this.nearestEnemyInReach(reach);
      this.player.playAction("attack", () => {
        useGameStore.getState().jobsAddXp("combat", 5);
        if (!target || !target.isAlive()) return;
        const swordDmg = 1;
        const killed = target.hit(this, swordDmg, this.player.x, this.player.y);
        const enemyHeadY =
          target.sprite.y - (target.def.sprite.frameHeight * target.def.display.scale) / 2 - 4;
        spawnFloatingNumber(this, target.sprite.x, enemyHeadY, swordDmg, {
          kind: "damage-enemy",
        });
        if (killed) {
          useGameStore.getState().jobsAddXp(target.def.xpSkill, target.def.xpPerKill);
          this.rollAndDrop(target.def.dropTable, target.x, target.y);
          target.beginRespawn(this.time.now);
          showToast(`Slain — ${target.def.name}`, 1200);
        }
      });
    } else if (mainHand === "bow") {
      showToast("Left-click to fire the bow.", 1500);
    } else {
      showToast("Equip a sword, pickaxe, axe, or rod to act with Q.", 1500);
    }
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

  private fireBow(worldX: number, worldY: number): void {
    const def = ITEMS["bow"];
    const ranged = def?.ranged;
    if (!ranged) return;
    if (this.bowCooldownMs > 0) return;

    const slots = useGameStore.getState().inventory.slots;
    const ammoIdx = slots.findIndex((s) => s && s.itemId === ranged.projectile);
    if (ammoIdx < 0) {
      showToast("Out of arrows.", 1200);
      return;
    }

    const fromX = this.player.x;
    const fromY = this.player.y - 10; // eye-ish height so the arrow leaves the torso, not the feet
    const angle = Math.atan2(worldY - fromY, worldX - fromX);
    // Snap player sprite to the nearest 8-way facing for the shoot anim.
    this.player.setFacing(angleToFacing(angle));
    const ok = this.player.playAction("shoot", () => {
      useGameStore.getState().jobsAddXp("ranger", 2);
    });
    if (!ok) return;

    const removed = useGameStore.getState().inventoryRemoveAt(ammoIdx, 1);
    if (removed <= 0) return;

    // Release the arrow mid-animation (frame ~4 of 6 @ 12 fps) so it leaves
    // the bow when the string snaps forward, not on the first draw frame.
    const releaseDelayMs = 330;
    this.time.delayedCall(releaseDelayMs, () => {
      if (!this.scene.isActive()) return;
      const projectile = new Projectile(this, {
        x: this.player.x,
        y: this.player.y - 10,
        angle,
        speedPx: ranged.projectileSpeedPx,
        rangePx: ranged.rangePx,
        damage: ranged.damage,
        ownerId: "player",
      });
      this.projectiles.push(projectile);
    });
    this.bowCooldownMs = ranged.cooldownMs;
  }

  private updateProjectiles(dtMs: number): void {
    if (this.bowCooldownMs > 0) this.bowCooldownMs = Math.max(0, this.bowCooldownMs - dtMs);
    if (this.projectiles.length === 0) return;
    const stillAlive: Projectile[] = [];
    for (const p of this.projectiles) {
      const hit = p.update(dtMs, this.enemies, (x, y) => this.world.manager.isBlockedPx(x, y));
      if (hit) {
        this.applyArrowHit(hit.enemy, p);
        p.destroy();
        continue;
      }
      if (p.isAlive()) stillAlive.push(p);
    }
    this.projectiles = stillAlive;
  }

  private applyArrowHit(target: Enemy, projectile: Projectile): void {
    const dmg = projectile.damage;
    const killed = target.hit(this, dmg, projectile.x, projectile.y);
    const enemyHeadY =
      target.sprite.y - (target.def.sprite.frameHeight * target.def.display.scale) / 2 - 4;
    spawnFloatingNumber(this, target.sprite.x, enemyHeadY, dmg, {
      kind: "damage-enemy",
    });
    if (killed) {
      // Bow kills train ranger, not the enemy's default combat xpSkill.
      useGameStore.getState().jobsAddXp("ranger", target.def.xpPerKill);
      this.rollAndDrop(target.def.dropTable, target.x, target.y);
      if (Math.random() < 0.5) {
        const ox = (Math.random() - 0.5) * TILE_SIZE * 0.6;
        const oy = (Math.random() - 0.5) * TILE_SIZE * 0.4;
        const entry = this.droppedItemsState.add("arrow", 1, target.x + ox, target.y + oy);
        this.spawnDroppedSprite(entry);
      }
      target.beginRespawn(this.time.now);
      showToast(`Slain — ${target.def.name}`, 1200);
    }
  }

  private updateBowReticle(): void {
    const equipped = useGameStore.getState().equipment.equipped.mainHand;
    const show =
      equipped === "bow" &&
      this.sceneState.mode === "OnFoot" &&
      !this.activeDialogue &&
      !this.player.mounted;
    if (!show) {
      if (this.bowReticle?.visible) this.bowReticle.setVisible(false);
      return;
    }
    if (!this.bowReticle) {
      this.bowReticle = this.add.graphics().setDepth(9600);
    }
    const pointer = this.input.activePointer;
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const wx = worldPoint.x;
    const wy = worldPoint.y;
    const def = ITEMS["bow"];
    const ranged = def?.ranged;
    if (!ranged) return;
    const fromX = this.player.x;
    const fromY = this.player.y - 10;
    const dist = Phaser.Math.Distance.Between(fromX, fromY, wx, wy);
    const inRange = dist <= ranged.rangePx;
    const blocked = rayBlocked(fromX, fromY, wx, wy, (x, y) => this.world.manager.isBlockedPx(x, y));
    const color = !inRange || blocked ? 0xff4a4a : 0xffe27a;

    const g = this.bowReticle;
    g.clear();
    g.setVisible(true);
    g.lineStyle(2, color, 1);
    g.strokeCircle(wx, wy, 8);
    g.lineStyle(1, color, 0.8);
    g.beginPath();
    g.moveTo(wx - 12, wy);
    g.lineTo(wx - 4, wy);
    g.moveTo(wx + 4, wy);
    g.lineTo(wx + 12, wy);
    g.moveTo(wx, wy - 12);
    g.lineTo(wx, wy - 4);
    g.moveTo(wx, wy + 4);
    g.lineTo(wx, wy + 12);
    g.strokePath();
  }

  private nearestNodeForTool(toolId: string | undefined): GatheringNode | null {
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

  private gatherFrom(node: GatheringNode) {
    const animState =
      node.def.kind === "fish" ? "fish" : node.def.kind === "tree" ? "chop" : "mine";
    const ok = this.player.playAction(animState, () => {
      const nodeDmg = 1;
      const broken = node.hit(this);
      spawnFloatingNumber(this, node.x, node.y - node.def.height / 2 - 4, nodeDmg, {
        kind: "damage-node",
      });
      useGameStore.getState().jobsAddXp(node.def.skill, node.def.xpPerHit);
      if (broken) this.dropFromNode(node);
    });
    if (!ok) return;
  }

  private dropFromNode(node: GatheringNode) {
    const offsetX = (Math.random() - 0.5) * TILE_SIZE * 0.5;
    const offsetY = TILE_SIZE * 0.4 + Math.random() * 6;
    const x = node.x + offsetX;
    const y = node.y + offsetY;
    const { itemId, quantity: qMin, quantityMax } = node.def.drop;
    const qMax = quantityMax ?? qMin;
    const quantity = qMin + Math.floor(Math.random() * (qMax - qMin + 1));
    const entry = this.droppedItemsState.add(itemId, quantity, x, y);
    this.spawnDroppedSprite(entry);
    showToast(`+${quantity} ${ITEMS[itemId].name}`, 1500);
  }

  private loadDropTables() {
    const file = dropTablesDataRaw as DropTablesFile;
    for (const t of file.tables) this.dropTables.set(t.id, t);
  }

  private spawnEnemies() {
    const file = enemiesDataRaw as EnemiesFile;
    this.enemyDefs = new Map(file.defs.map((d) => [d.id, d]));
    for (const def of file.defs) registerEnemyAnimations(this, def);
    for (const inst of file.instances) {
      const def = this.enemyDefs.get(inst.defId);
      if (!def) {
        console.warn(`Unknown enemy defId: ${inst.defId}`);
        continue;
      }
      this.addEnemy(new Enemy(this, def, inst));
    }
  }

  private addEnemy(enemy: Enemy) {
    this.enemies.push(enemy);
    entityRegistry.add(enemy);
  }

  private removeEnemyAt(index: number) {
    const e = this.enemies[index];
    if (!e) return;
    entityRegistry.remove(e.id);
    e.destroy();
    this.enemies.splice(index, 1);
  }

  /** Roll a drop table and spawn drops at (x, y) as dropped items. */
  private rollAndDrop(tableId: string, x: number, y: number) {
    const table = this.dropTables.get(tableId);
    if (!table) return;
    for (const roll of table.rolls) {
      if (Math.random() > roll.chance) continue;
      const qty = roll.min + Math.floor(Math.random() * (roll.max - roll.min + 1));
      if (qty <= 0) continue;
      const ox = (Math.random() - 0.5) * TILE_SIZE * 0.6;
      const oy = (Math.random() - 0.5) * TILE_SIZE * 0.4;
      const entry = this.droppedItemsState.add(roll.itemId, qty, x + ox, y + oy);
      this.spawnDroppedSprite(entry);
    }
  }

  private nearestEnemyInReach(rangePx: number): Enemy | null {
    let best: Enemy | null = null;
    let bestDist = rangePx;
    for (const e of this.enemies) {
      if (!e.isAlive()) continue;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, e.x, e.y);
      if (d <= bestDist) {
        best = e;
        bestDist = d;
      }
    }
    return best;
  }

  private spawnGatheringNodes() {
    const file = loadNodesFile(nodesDataRaw);
    this.nodeDefs = indexDefs(file.defs);
    for (const inst of file.instances) {
      const def = this.nodeDefs.get(inst.defId);
      if (!def) {
        console.warn(`Unknown node defId: ${inst.defId}`);
        continue;
      }
      this.nodes.push(new GatheringNode(this, def, inst));
    }
  }

  private spawnCraftingStations() {
    for (const inst of craftingStationInstances) {
      const def = craftingStations.tryGet(inst.defId);
      if (!def) {
        console.warn(`Unknown crafting station defId: ${inst.defId}`);
        continue;
      }
      this.craftingStations.push(new CraftingStation(this, def, inst));
    }
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
      const door = this.nearestDoor();
      if (door) {
        this.enterInterior(door);
        return;
      }
      const pickup = this.nearestGroundItem();
      if (pickup) {
        this.pickUp(pickup);
        return;
      }
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

  private nearestDoor(): DoorSpawn | null {
    let best: DoorSpawn | null = null;
    let bestDist = DOOR_INTERACT_RADIUS;
    for (const d of this.doors) {
      const dx = (d.tileX + 0.5) * TILE_SIZE - this.player.x;
      const dy = (d.tileY + 0.5) * TILE_SIZE - this.player.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= bestDist) {
        best = d;
        bestDist = dist;
      }
    }
    return best;
  }

  private setupNpcReconciler() {
    this.npcData = npcDataRaw as NpcData;
    this.dialogues = this.npcData.dialogues ?? {};
    const worldMap: MapId = { kind: "world" };
    this.npcReconciler = new SpriteReconciler<NpcSprite>(
      this,
      worldMap,
      (scene, model) => {
        if (model.kind !== "npc") return null;
        return new NpcSprite(scene, model as NpcModel);
      },
    );
    worldTicker.registerWalkable(worldMap, (x, y) => this.isWalkablePx(x, y));
  }

  reloadNpcs(data: NpcData) {
    this.npcData = data;
    this.dialogues = data.dialogues ?? {};
    if (this.activeDialogue) this.closeDialogue();
    clearNpcs();
    bootstrapNpcs(data);
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
    });
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

    // Respawn player-dropped items that haven't expired yet.
    const now = Date.now();
    for (const d of this.droppedItemsState.list()) {
      if (d.expiresAt <= now) continue;
      this.spawnDroppedSprite(d);
    }

    this.initialGroundItemsBuilt = true;
  }

  private addGroundItemSprite(s: ItemSpawn, source: "authored" | "editor") {
    if (this.groundItemsState.isPickedUp(s.uid)) return;
    const x = (s.tileX + 0.5) * TILE_SIZE;
    const y = (s.tileY + 0.5) * TILE_SIZE;
    const sprite = this.add
      .image(x, y, itemIconTextureKey(s.itemId))
      .setOrigin(0.5)
      .setDepth(y);
    sprite.setDisplaySize(20, 20);
    this.tweens.add({
      targets: sprite,
      y: y - 3,
      duration: 900,
      ease: "Sine.easeInOut",
      yoyo: true,
      repeat: -1,
    });
    this.groundItems.set(s.uid, {
      uid: s.uid,
      itemId: s.itemId,
      quantity: s.quantity,
      x,
      y,
      sprite,
      source,
    });
  }

  private spawnDroppedSprite(d: DroppedItem) {
    const sprite = this.add
      .image(d.x, d.y, itemIconTextureKey(d.itemId))
      .setOrigin(0.5)
      .setDepth(d.y);
    sprite.setDisplaySize(20, 20);
    this.tweens.add({
      targets: sprite,
      y: d.y - 3,
      duration: 900,
      ease: "Sine.easeInOut",
      yoyo: true,
      repeat: -1,
    });
    this.groundItems.set(d.uid, {
      uid: d.uid,
      itemId: d.itemId,
      quantity: d.quantity,
      x: d.x,
      y: d.y,
      sprite,
      source: "dropped",
    });
  }

  private nearestGroundItem(): GroundItem | null {
    let best: GroundItem | null = null;
    let bestDist = PICKUP_RADIUS;
    for (const gi of this.groundItems.values()) {
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, gi.x, gi.y);
      if (d <= bestDist) {
        best = gi;
        bestDist = d;
      }
    }
    return best;
  }

  private pickUp(gi: GroundItem) {
    const leftover = useGameStore.getState().inventoryAdd(gi.itemId, gi.quantity);
    const taken = gi.quantity - leftover;
    if (taken <= 0) {
      showToast("Inventory is full.", 1500);
      return;
    }
    const def = ITEMS[gi.itemId];
    if (leftover > 0) {
      gi.quantity = leftover;
      showToast(`Picked up ${taken} ${def.name} (full).`, 1800);
    } else {
      gi.sprite.destroy();
      this.groundItems.delete(gi.uid);
      if (gi.source === "authored" || gi.source === "editor") {
        this.groundItemsState.markPickedUp(gi.uid);
      } else {
        this.droppedItemsState.remove(gi.uid);
      }
      showToast(`Picked up ${taken} ${def.name}.`, 1500);
    }
  }

  private expireDroppedItems() {
    const now = Date.now();
    const expired = this.droppedItemsState.pruneExpired(now);
    for (const d of expired) {
      const gi = this.groundItems.get(d.uid);
      if (gi) {
        gi.sprite.destroy();
        this.groundItems.delete(d.uid);
      }
    }
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
    showToast("WASD to steer, R to reverse, E to anchor.", 4500);
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

    let thrust: { x: number; y: number } | null = null;
    if (dx !== 0 || dy !== 0) {
      ship.setHeadingFromInput(dx, dy);
      const len = Math.hypot(dx, dy);
      thrust = { x: dx / len, y: dy / len };
    } else if (this.keys.reverse.isDown) {
      const h = ship.heading;
      thrust = {
        x: h === 1 ? -1 : h === 3 ? 1 : 0,
        y: h === 2 ? -1 : h === 0 ? 1 : 0,
      };
    }

    const step = ship.updateSailing(dt, thrust, (tx, ty) => this.world.manager.shipTileState(tx, ty));
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
    const target = findAnchorPose(
      (tx, ty) => this.world.manager.isAnchorable(tx, ty),
      ship.x,
      ship.y,
      ship.heading,
      ship.dims,
      TILE_SIZE,
    );
    if (!target) {
      showToast("No clear water to anchor. Steer away from land.", 2500);
      return;
    }

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

    showToast("Dropping anchor…", 1200);
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
    } else if (
      this.sceneState.mode === "OnFoot" &&
      !this.isWalkablePx(this.player.x, this.player.y)
    ) {
      // OnFoot but the hydrated player position isn't walkable. Happens when
      // a broken load degraded AtHelm → OnFoot and then autosave persisted
      // that state, leaving the player saved at ocean coords with no ship
      // nearby. Rescue them to the nearest dock — otherwise reloading keeps
      // regurgitating the stuck state.
      console.warn(
        "[WorldScene] Hydrated player position is not walkable — returning to port.",
      );
      this.resetShipsAndParkPlayer();
      showToast("You were adrift at sea. Returned to port.", 4000);
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

  private isWalkablePx(px: number, py: number, ignoreEnemy?: Enemy): boolean {
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

  private stepZoomKeyboard(dir: 1 | -1) {
    const cur = this.zoomTarget;
    let target: number;
    if (dir > 0) {
      const next = ZOOM_STEPS.find((s) => s > cur + ZOOM_SNAP_EPSILON);
      target = next ?? MAX_ZOOM;
    } else {
      let prev: number = MIN_ZOOM;
      for (const s of ZOOM_STEPS) {
        if (s < cur - ZOOM_SNAP_EPSILON) prev = s;
        else break;
      }
      target = prev;
    }
    this.zoomTarget = Phaser.Math.Clamp(target, MIN_ZOOM, MAX_ZOOM);
    useSettingsStore.getState().setZoom(this.zoomTarget);
  }

  private updateZoom(dtMs: number) {
    if (
      this.wheelZoomDir !== 0 &&
      this.time.now - this.lastWheelAt >= WHEEL_SETTLE_MS
    ) {
      const cur = this.zoomTarget;
      let snapped: number;
      if (this.wheelZoomDir > 0) {
        const next = ZOOM_STEPS.find((s) => s >= cur - ZOOM_SNAP_EPSILON);
        snapped = next ?? MAX_ZOOM;
      } else {
        let prev: number = MIN_ZOOM;
        for (const s of ZOOM_STEPS) {
          if (s <= cur + ZOOM_SNAP_EPSILON) prev = s;
          else break;
        }
        snapped = prev;
      }
      this.zoomTarget = Phaser.Math.Clamp(snapped, MIN_ZOOM, MAX_ZOOM);
      useSettingsStore.getState().setZoom(this.zoomTarget);
      this.wheelZoomDir = 0;
    }
    const cam = this.cameras.main;
    const diff = this.zoomTarget - cam.zoom;
    if (Math.abs(diff) < ZOOM_SNAP_EPSILON) {
      if (cam.zoom !== this.zoomTarget) cam.setZoom(this.zoomTarget);
      return;
    }
    const t = 1 - Math.exp(-ZOOM_SMOOTH_RATE * (dtMs / 1000));
    cam.setZoom(cam.zoom + diff * t);
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
      } else if (this.nearestDoor()) {
        prompt = "Press E to go inside";
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

    setHud({
      mode: hudMode,
      prompt,
      speed: this.activeShip ? Math.round(this.activeShip.speed) : 0,
      heading: this.activeShip ? normalizeAngle(this.activeShip.rotation) : 0,
      stamina: Math.round(stamina.current),
      staminaMax: STAMINA_MAX,
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

  // ─── Edit mode ────────────────────────────────────────────────────

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
      // Pick the highest numeric suffix so the id allocator never collides
      // with previously-saved editor items.
      const m = /^ed-(\d+)$/.exec(inst.id);
      if (m) this.editAutoIncrement = Math.max(this.editAutoIncrement, Number(m[1]));
    }
  }

  private nextEditId(prefix: string): string {
    // `editAutoIncrement` is only seeded from `ed-N` item ids, so enemy /
    // node / ship ids authored in previous sessions (e.g. `skeleton-7`) may
    // collide. Bump past any taken id before returning.
    for (;;) {
      this.editAutoIncrement += 1;
      const candidate = `${prefix}-${this.editAutoIncrement}`;
      if (!entityRegistry.get(candidate)) return candidate;
    }
  }

  private onEditToggle = () => {
    this.editMode = !this.editMode;
    if (this.editMode) showToast("Edit mode ON — left-click to select/place. F7 to exit.", 2500);
    else showToast("Edit mode OFF.", 1500);
    if (!this.editMode) {
      this.editHighlight?.clear();
      this.editHighlight?.setVisible(false);
    }
    this.emitEditState();
  };

  private redrawEditHighlights() {
    const g = this.editHighlight;
    if (!g) return;
    g.clear();
    g.setVisible(true);
    const r = this.EDIT_PICK_RADIUS;
    const colors: Record<EditEntityKind, number> = {
      npc: 0x5fd7ff,
      enemy: 0xff6b6b,
      node: 0xffd65f,
      item: 0xb57bff,
      ship: 0x7bffc7,
    };
    const circle = (kind: EditEntityKind, x: number, y: number) => {
      g.lineStyle(2, colors[kind], 0.9);
      g.strokeCircle(x, y, r);
    };
    for (const npc of npcModelsIn({ kind: "world" })) circle("npc", npc.x, npc.y);
    for (const e of this.enemies) circle("enemy", e.x, e.y);
    for (const n of this.nodes) circle("node", n.x, n.y);
    for (const gi of this.groundItems.values()) {
      if (gi.source === "dropped") continue;
      circle("item", gi.x, gi.y);
    }
    for (const ship of this.ships.values()) circle("ship", ship.x, ship.y);
  }

  private onEditRequestSnapshot = () => {
    this.emitEditState();
  };

  private emitEditState() {
    bus.emitTyped("edit:state", {
      active: this.editMode,
      snapshot: this.editMode ? this.buildEditSnapshot() : null,
    });
  }

  private buildEditSnapshot(): EditSnapshot {
    const npcs = Array.from(npcModelsIn({ kind: "world" })).map((n) => ({
      id: n.def.id,
      name: n.def.name,
      tileX: Math.floor(n.x / TILE_SIZE),
      tileY: Math.floor(n.y / TILE_SIZE),
      shopId: n.def.shopId,
      map: "world",
    }));
    const enemies = this.enemies.map((e) => ({
      id: e.id,
      defId: e.def.id,
      defName: e.def.name,
      tileX: Math.floor(e.x / TILE_SIZE),
      tileY: Math.floor(e.y / TILE_SIZE),
    }));
    const nodes = this.nodes.map((n) => ({
      id: n.id,
      defId: n.def.id,
      defName: n.def.name,
      tileX: Math.floor(n.x / TILE_SIZE),
      tileY: Math.floor(n.y / TILE_SIZE),
    }));
    const items = Array.from(this.groundItems.values())
      .filter((gi) => gi.source !== "dropped")
      .map((gi) => ({
        id: gi.uid,
        itemId: gi.itemId,
        itemName: ITEMS[gi.itemId]?.name ?? gi.itemId,
        quantity: gi.quantity,
        tileX: Math.floor(gi.x / TILE_SIZE),
        tileY: Math.floor(gi.y / TILE_SIZE),
        source: gi.source as "authored" | "editor",
      }));
    const headingStr: Record<number, "N" | "E" | "S" | "W"> = { 0: "N", 1: "E", 2: "S", 3: "W" };
    const ships = Array.from(this.ships.values()).map((s) => ({
      id: s.id,
      defId: s.vessel.id,
      defName: s.vessel.id,
      tileX: s.docked.tx,
      tileY: s.docked.ty,
      heading: headingStr[s.docked.heading],
    }));
    return {
      npcs,
      enemies,
      nodes,
      items,
      ships,
      defs: {
        npcs: this.npcData.npcs.map((n) => ({ id: n.id, name: n.name })),
        enemies: Array.from(this.enemyDefs.values()).map((d) => ({ id: d.id, name: d.name })),
        nodes: Array.from(this.nodeDefs.values()).map((d) => ({ id: d.id, name: d.name })),
        items: ALL_ITEM_IDS.map((id) => ({ id, name: ITEMS[id]?.name ?? id })),
        ships: Array.from(this.shipDefs.values()).map((d) => ({ id: d.id, name: d.id })),
      },
      shops: this.shopsForEdit.map((s) => ({
        id: s.id,
        name: s.name,
        greeting: s.greeting,
        stock: s.stock.map((row) => ({ ...row })),
      })),
    };
  }

  private onEditLeftClick(worldX: number, worldY: number) {
    const tileX = Math.floor(worldX / TILE_SIZE);
    const tileY = Math.floor(worldY / TILE_SIZE);
    const hit = this.findEditableAt(worldX, worldY);
    bus.emitTyped("edit:click", { worldX, worldY, tileX, tileY, hit });
  }

  private onEditPointerDown(worldX: number, worldY: number) {
    const hit = this.findEditableAt(worldX, worldY);
    if (hit) {
      this.editDrag = {
        kind: hit.kind,
        id: hit.id,
        startWorldX: worldX,
        startWorldY: worldY,
        moved: false,
      };
    } else {
      this.editDrag = null;
    }
  }

  private onEditPointerMove(worldX: number, worldY: number) {
    const drag = this.editDrag;
    if (!drag) return;
    const dx = worldX - drag.startWorldX;
    const dy = worldY - drag.startWorldY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    this.dragEntityTo(drag.kind, drag.id, worldX, worldY);
  }

  private onEditPointerUp(worldX: number, worldY: number) {
    const drag = this.editDrag;
    this.editDrag = null;
    if (drag && drag.moved) {
      const tileX = Math.floor(worldX / TILE_SIZE);
      const tileY = Math.floor(worldY / TILE_SIZE);
      this.onEditMove({ kind: drag.kind, id: drag.id, tileX, tileY });
      return;
    }
    // No-drag click on a ship cycles its heading; other kinds fall through.
    if (drag && !drag.moved && drag.kind === "ship") {
      const ship = this.ships.get(drag.id);
      if (ship) {
        const nextH = ((ship.docked.heading + 1) % 4) as 0 | 1 | 2 | 3;
        ship.finalizeDock({ tx: ship.docked.tx, ty: ship.docked.ty, heading: nextH });
        const stored = this.shipInstanceData.find((s) => s.id === drag.id);
        if (stored) stored.heading = nextH;
        this.emitEditState();
        return;
      }
    }
    // Treat a no-drag click as select/place: existing behavior.
    this.onEditLeftClick(worldX, worldY);
  }

  private dragEntityTo(kind: EditEntityKind, id: string, px: number, py: number) {
    if (kind === "npc") {
      const model = entityRegistry.get(`npc:${id}`) as NpcModel | undefined;
      if (!model) return;
      model.setPositionPx(px, py);
      // Reconciler's next syncAll picks up new position; force an immediate
      // sync here so the drag feels responsive in the same frame.
      this.npcReconciler.spriteFor(model.id)?.syncFromModel();
    } else if (kind === "enemy") {
      const e = this.enemies.find((x) => x.id === id);
      if (!e) return;
      e.sprite.setPosition(px, py);
      e.sprite.setDepth(e.sortY());
    } else if (kind === "node") {
      const n = this.nodes.find((x) => x.id === id);
      if (!n) return;
      n.setPositionPx(px, py);
    } else if (kind === "item") {
      const gi = this.groundItems.get(id);
      if (!gi || gi.source !== "editor") return;
      gi.x = px;
      gi.y = py;
      gi.sprite.setPosition(px, py);
      gi.sprite.setDepth(py);
    } else if (kind === "ship") {
      const ship = this.ships.get(id);
      if (!ship) return;
      const tx = Math.floor(px / TILE_SIZE);
      const ty = Math.floor(py / TILE_SIZE);
      ship.finalizeDock({ tx, ty, heading: ship.docked.heading });
    }
  }

  private readonly EDIT_PICK_RADIUS = TILE_SIZE * 0.9;

  private findEditableAt(
    worldX: number,
    worldY: number,
  ): { kind: EditEntityKind; id: string } | null {
    const radius = this.EDIT_PICK_RADIUS;
    interface Hit { kind: EditEntityKind; id: string; dist: number }
    const hits: Hit[] = [];
    const consider = (kind: EditEntityKind, id: string, x: number, y: number) => {
      const d = Phaser.Math.Distance.Between(worldX, worldY, x, y);
      if (d > radius) return;
      hits.push({ kind, id, dist: d });
    };
    for (const npc of npcModelsIn({ kind: "world" })) consider("npc", npc.def.id, npc.x, npc.y);
    for (const e of this.enemies) consider("enemy", e.id, e.x, e.y);
    for (const n of this.nodes) consider("node", n.id, n.x, n.y);
    for (const gi of this.groundItems.values()) {
      if (gi.source === "dropped") continue;
      consider("item", gi.uid, gi.x, gi.y);
    }
    for (const ship of this.ships.values()) {
      consider("ship", ship.id, ship.x, ship.y);
    }
    if (hits.length === 0) return null;
    hits.sort((a, b) => a.dist - b.dist);
    return { kind: hits[0].kind, id: hits[0].id };
  }

  private onEditMove = (req: EditMoveRequest) => {
    const px = (req.tileX + 0.5) * TILE_SIZE;
    const py = (req.tileY + 0.5) * TILE_SIZE;
    if (req.kind === "npc") {
      const model = entityRegistry.get(`npc:${req.id}`) as NpcModel | undefined;
      if (!model) return;
      // Mutate the def so a subsequent restart spawns at the same tile and
      // the next snapshot reads the right home position.
      model.def.spawn = { tileX: req.tileX, tileY: req.tileY };
      model.setPositionPx(px, py);
      this.npcReconciler.spriteFor(model.id)?.syncFromModel();
    } else if (req.kind === "enemy") {
      const e = this.enemies.find((x) => x.id === req.id);
      if (!e) return;
      e.sprite.setPosition(px, py);
      e.sprite.setDepth(e.sortY());
    } else if (req.kind === "node") {
      // Nodes use their constructor pos as `x/y` and a container — recreate.
      const idx = this.nodes.findIndex((n) => n.id === req.id);
      if (idx === -1) return;
      const old = this.nodes[idx];
      old.destroy();
      this.nodes[idx] = new GatheringNode(this, old.def, {
        id: old.id,
        defId: old.def.id,
        tileX: req.tileX,
        tileY: req.tileY,
      });
    } else if (req.kind === "item") {
      const gi = this.groundItems.get(req.id);
      if (!gi || gi.source !== "editor") return;
      gi.x = px;
      gi.y = py;
      gi.sprite.setPosition(px, py);
      gi.sprite.setDepth(py);
      const stored = this.editorItems.get(req.id);
      if (stored) {
        stored.tileX = req.tileX;
        stored.tileY = req.tileY;
      }
    } else if (req.kind === "ship") {
      const ship = this.ships.get(req.id);
      if (!ship) return;
      ship.finalizeDock({ tx: req.tileX, ty: req.tileY, heading: ship.docked.heading });
      const stored = this.shipInstanceData.find((s) => s.id === req.id);
      if (stored) {
        stored.tileX = req.tileX;
        stored.tileY = req.tileY;
      }
    }
    this.emitEditState();
  };

  private onEditPlace = (req: EditPlaceRequest) => {
    if (req.kind === "npc") {
      const template = this.npcData.npcs.find((n) => n.id === req.defId);
      if (!template) return;
      const newId = this.nextEditId(`${template.id}-copy`);
      const clone = JSON.parse(JSON.stringify(template));
      clone.id = newId;
      clone.spawn = { tileX: req.tileX, tileY: req.tileY };
      clone.map = "world";
      this.npcData.npcs.push(clone);
      // Newly-authored NPC: animations aren't registered yet because it's a
      // runtime clone. The clone reuses the template's sprite sheets, so the
      // existing anim keys already match (keyed by id). Since the clone gets
      // a fresh id, register fresh anim keys for it.
      registerNpcAnimations(this, clone);
      addNpc(clone, { kind: "world" });
    } else if (req.kind === "enemy") {
      const def = this.enemyDefs.get(req.defId);
      if (!def) return;
      const inst: EnemyInstanceData = {
        id: this.nextEditId(`${def.id}`),
        defId: def.id,
        tileX: req.tileX,
        tileY: req.tileY,
      };
      this.addEnemy(new Enemy(this, def, inst));
    } else if (req.kind === "node") {
      const def = this.nodeDefs.get(req.defId);
      if (!def) return;
      const inst: NodeInstanceData = {
        id: this.nextEditId(`${def.id}`),
        defId: def.id,
        tileX: req.tileX,
        tileY: req.tileY,
      };
      this.nodes.push(new GatheringNode(this, def, inst));
    } else if (req.kind === "item") {
      const id = this.nextEditId("ed");
      this.editorItems.set(id, {
        id,
        itemId: req.defId as ItemId,
        quantity: req.quantity ?? 1,
        tileX: req.tileX,
        tileY: req.tileY,
      });
      // Re-render via respawn for sprite consistency.
      this.respawnGroundItems();
    } else if (req.kind === "ship") {
      const def = this.shipDefs.get(req.defId);
      if (!def) return;
      const id = this.nextEditId(`${def.id}`);
      const inst: ShipInstanceData = {
        id,
        defId: def.id,
        tileX: req.tileX,
        tileY: req.tileY,
        heading: 1,
      };
      this.shipInstanceData.push(inst);
      this.spawnShip(inst);
    }
    this.emitEditState();
  };

  private onEditDelete = (req: EditDeleteRequest) => {
    if (req.kind === "npc") {
      if (!entityRegistry.get(`npc:${req.id}`)) return;
      removeNpcById(req.id);
      this.npcData.npcs = this.npcData.npcs.filter((n) => n.id !== req.id);
    } else if (req.kind === "enemy") {
      const idx = this.enemies.findIndex((e) => e.id === req.id);
      if (idx === -1) return;
      this.removeEnemyAt(idx);
    } else if (req.kind === "node") {
      const idx = this.nodes.findIndex((n) => n.id === req.id);
      if (idx === -1) return;
      this.nodes[idx].destroy();
      this.nodes.splice(idx, 1);
    } else if (req.kind === "item") {
      const gi = this.groundItems.get(req.id);
      if (!gi || gi.source !== "editor") return;
      gi.sprite.destroy();
      this.groundItems.delete(req.id);
      this.editorItems.delete(req.id);
    } else if (req.kind === "ship") {
      const ship = this.ships.get(req.id);
      if (!ship) return;
      ship.destroy();
      this.ships.delete(req.id);
      this.shipInstanceData = this.shipInstanceData.filter((s) => s.id !== req.id);
      if (this.activeShip === ship) this.activeShip = null;
    }
    this.emitEditState();
  };

  private onEditRequestExport = () => {
    // Apply moved positions back into the def list before serializing.
    for (const model of entityRegistry.all()) {
      if (model.kind !== "npc") continue;
      const npc = model as NpcModel;
      const def = this.npcData.npcs.find((n) => n.id === npc.def.id);
      if (def) def.spawn = { tileX: Math.floor(npc.x / TILE_SIZE), tileY: Math.floor(npc.y / TILE_SIZE) };
    }
    const enemiesFile: EnemiesFile = {
      defs: (enemiesDataRaw as EnemiesFile).defs,
      instances: this.enemies.map((e) => ({
        id: e.id,
        defId: e.def.id,
        tileX: Math.floor(e.x / TILE_SIZE),
        tileY: Math.floor(e.y / TILE_SIZE),
      })),
    };
    const nodesFile = {
      defs: (loadNodesFile(nodesDataRaw)).defs,
      instances: this.nodes.map((n) => ({
        id: n.id,
        defId: n.def.id,
        tileX: Math.floor(n.x / TILE_SIZE),
        tileY: Math.floor(n.y / TILE_SIZE),
      })),
    };
    const itemInstancesFile: ItemInstancesFile = {
      instances: Array.from(this.editorItems.values()).map((e) => ({
        id: e.id,
        itemId: e.itemId,
        quantity: e.quantity,
        tileX: e.tileX,
        tileY: e.tileY,
      })),
    };
    const shopsFile: ShopsFile = { shops: this.shopsForEdit };

    const headingStr: Record<number, "N" | "E" | "S" | "W"> = { 0: "N", 1: "E", 2: "S", 3: "W" };
    const shipsFile = {
      defs: Array.from(this.shipDefs.values()),
      instances: this.shipInstanceData.map((s) => ({
        id: s.id,
        defId: s.defId,
        tileX: s.tileX,
        tileY: s.tileY,
        heading: headingStr[s.heading],
      })),
    };

    const stringify = (obj: unknown) => JSON.stringify(obj, null, 2) + "\n";
    bus.emitTyped("edit:export", {
      files: [
        { name: "npcs.json", content: stringify(this.npcData) },
        { name: "enemies.json", content: stringify(enemiesFile) },
        { name: "nodes.json", content: stringify(nodesFile) },
        { name: "itemInstances.json", content: stringify(itemInstancesFile) },
        { name: "shops.json", content: stringify(shopsFile) },
        { name: "ships.json", content: stringify(shipsFile) },
      ],
    });
  };

  private onEditShopUpdate = (req: EditShopUpdate) => {
    const shop = this.shopsForEdit.find((s) => s.id === req.shopId);
    if (!shop) return;
    shop.stock = req.stock.map((row) => ({
      itemId: row.itemId as ItemId,
      restockQuantity: row.restockQuantity,
    }));
    // Drop any cached runtime instance for this shop so the next open reads
    // the new stock list.
    useShopStore.getState().reset();
    this.emitEditState();
  };

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
