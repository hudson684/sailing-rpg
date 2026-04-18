import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { bus, type DialogueAction, type InventoryAction } from "../bus";
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
  type Facing,
} from "../entities/Player";
import { syncPlayerVisualsFromEquipment } from "../entities/playerEquipmentVisuals";
import { CF_WARDROBE_LAYERS } from "../entities/playerWardrobe";
import {
  Ship,
  normalizeAngle,
  type DockedPose,
  type Heading,
} from "../entities/Ship";

const HEADING_TO_FACING: Record<Heading, Facing> = {
  0: "up",
  1: "right",
  2: "down",
  3: "left",
};
import { VESSEL_TEMPLATES } from "../entities/vessels";
import { loadWorld, type WorldMap } from "../world/worldMap";
import type { ItemSpawn } from "../world/spawns";
import type { WorldManifest } from "../world/chunkManager";
import { findAnchorPose } from "../util/anchor";
import { CHUNK_KEY_PREFIX, WORLD_MANIFEST_KEY, itemIconTextureKey } from "./BootScene";
import { Npc, NPC_INTERACT_RADIUS, registerNpcAnimations } from "../entities/Npc";
import { SKIN_PALETTES, bakePlayerSkin, type SkinPaletteId } from "../entities/playerSkin";
import type { NpcData, DialogueDef } from "../entities/npcTypes";
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
import { Enemy, registerEnemyAnimations } from "../entities/Enemy";
import type {
  DropTable,
  DropTablesFile,
  EnemiesFile,
} from "../entities/enemyTypes";
import enemiesDataRaw from "../data/enemies.json";
import dropTablesDataRaw from "../data/dropTables.json";
import { spawnFloatingNumber } from "../fx/floatingText";
import {
  SaveController,
  SceneState,
  systems as saveSystems,
  type SaveEnvelope,
} from "../save";

const HELM_INTERACT_RADIUS = TILE_SIZE * 0.7;
const PICKUP_RADIUS = TILE_SIZE * 0.8;
const SHOP_CLICK_RADIUS = TILE_SIZE * 1.5;
/** Time after last damage before player HP regen kicks in. */
const PLAYER_OUT_OF_COMBAT_MS = 6000;
/** HP per second regenerated while out of combat (fractional ok). */
const PLAYER_REGEN_PER_SEC = 1.0;

const ZOOM_STEPS = [0.5, 1, 1.5, 2, 3, 4, 6, 8] as const;
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const ZOOM_SMOOTH_RATE = 12;
const ZOOM_SNAP_EPSILON = 0.001;
const WHEEL_SETTLE_MS = 140;

interface GroundItem {
  uid: string;
  itemId: import("../inventory/items").ItemId;
  quantity: number;
  x: number;
  y: number;
  sprite: Phaser.GameObjects.Image;
  /** "authored" = from map; "dropped" = player-dropped with TTL. */
  source: "authored" | "dropped";
}

let activeWorldScene: WorldScene | null = null;

export class WorldScene extends Phaser.Scene {
  private world!: WorldMap;
  private player!: Player;
  private ship!: Ship;
  private decorativeVessels: Ship[] = [];
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
  private nodes: GatheringNode[] = [];
  private enemies: Enemy[] = [];
  private lastPlayerDamagedAt = 0;
  private playerRegenAccum = 0;
  private dropTables = new Map<string, DropTable>();
  private npcs: Npc[] = [];
  private dialogues: Record<string, DialogueDef> = {};
  private activeDialogue: { speaker: string; pages: string[]; page: number } | null = null;

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
  };

  private sailingXpAccum = 0;

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
    this.world = loadWorld({
      scene: this,
      manifest,
      chunkKeyPrefix: CHUNK_KEY_PREFIX,
    });

    const { ship: shipSpawn, dock, items } = this.world.spawns;
    const spawnPx = {
      x: (dock.tileX + 0.5) * TILE_SIZE,
      y: (dock.tileY + 0.5) * TILE_SIZE,
    };
    this.player = new Player(this, spawnPx.x, spawnPx.y);
    this.ship = new Ship(this, {
      tx: shipSpawn.tileX,
      ty: shipSpawn.tileY,
      heading: shipSpawn.heading,
    });

    // Decorative galleon moored east of the larger L-dock, south of the rowboat.
    this.decorativeVessels.push(
      new Ship(this, { tx: 73, ty: 20, heading: 1 }, VESSEL_TEMPLATES.galleon),
    );

    this.respawnGroundItems(items);
    this.spawnNpcs();
    this.spawnGatheringNodes();
    this.loadDropTables();
    this.spawnEnemies();

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
    };

    this.keys.interact.on("down", () => this.onInteract());

    // Right-click opens a shop when the click lands on (or near) an NPC with
    // a `shopId`. Suppress the native browser context menu so the game owns
    // that gesture.
    this.input.mouse?.disableContextMenu();
    this.input.on(
      "pointerdown",
      (pointer: Phaser.Input.Pointer) => {
        if (!pointer.rightButtonDown()) return;
        this.onRightClick(pointer.worldX, pointer.worldY);
      },
    );
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

    // Cardinal-only helm input: tap A/D (or ←/→) to turn 90° port/starboard.
    const turnPort = () => {
      if (this.sceneState.mode === "AtHelm") this.ship.turn(-1);
    };
    const turnStarboard = () => {
      if (this.sceneState.mode === "AtHelm") this.ship.turn(1);
    };
    this.keys.a.on("down", turnPort);
    this.keys.left.on("down", turnPort);
    this.keys.d.on("down", turnStarboard);
    this.keys.right.on("down", turnStarboard);

    this.debug = new DebugOverlays(this, this.world, {
      getShipPose: () =>
        this.ship ? { x: this.ship.x, y: this.ship.y, rotation: this.ship.rotation } : null,
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
    });
    const overlayKeys: Array<[Phaser.Input.Keyboard.Key, OverlayName]> = [
      [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F1), "walkability"],
      [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F2), "chunkGrid"],
      [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F3), "spawns"],
      [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F4), "anchorSearch"],
      [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F6), "hitbox"],
    ];
    for (const [key, name] of overlayKeys) key.on("down", () => this.debug.toggle(name));

    bus.onTyped("inventory:action", this.onInventoryAction);
    bus.onTyped("dialogue:action", this.onDialogueAction);
    bus.onTyped("skin:apply", this.onSkinApply);
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

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      bus.offTyped("inventory:action", this.onInventoryAction);
      bus.offTyped("dialogue:action", this.onDialogueAction);
      bus.offTyped("skin:apply", this.onSkinApply);
      unsubEquipment();
      unsubWardrobe();
      if (activeWorldScene === this) activeWorldScene = null;
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
    this.saveController.registerSystems([
      saveSystems.inventorySaveable(),
      saveSystems.equipmentSaveable(),
      saveSystems.jobsSaveable(),
      saveSystems.healthSaveable(),
      saveSystems.playerSaveable(this.player),
      saveSystems.shipSaveable(this.ship),
      saveSystems.groundItemsSaveable(this.groundItemsState),
      saveSystems.droppedItemsSaveable(this.droppedItemsState),
      saveSystems.sceneSaveable(this.sceneState),
      saveSystems.appearanceSaveable(),
      saveSystems.shopsSaveable(),
    ]);
    await this.saveController.refreshMenu();
    await this.saveController.loadLatest();
  }

  update(_time: number, dtMs: number) {
    const dt = dtMs / 1000;
    this.world.manager.tick(dtMs);
    this.saveController.playtime.tick();
    if (this.sceneState.mode === "OnFoot" && !this.activeDialogue) this.updateOnFoot(dt);
    else if (this.sceneState.mode === "AtHelm") this.updateAtHelm(dt);
    else if (this.sceneState.mode === "Anchoring") {
      // Tween drives the ship; nothing to do here.
    }
    for (const npc of this.npcs) npc.update(dtMs, (x, y) => this.isWalkablePx(x, y));
    for (const node of this.nodes) node.update(this.time.now);
    {
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
    }
    this.tickPlayerRegen(dtMs);
    const pTile = this.player.tile();
    this.world.manager.updateOverheadFade(pTile.x, pTile.y, dtMs);
    this.droppedExpiryAccum += dtMs;
    if (this.droppedExpiryAccum >= 1000) {
      this.droppedExpiryAccum = 0;
      this.expireDroppedItems();
    }
    this.syncPlayerShipDepth();
    this.updateZoom(dtMs);
    this.emitHud();
    this.debug.update();
  }

  /** Player rides above the hull whenever on the ship — the ship's container
   *  depth uses the footprint bottom, which would otherwise cover the player. */
  private syncPlayerShipDepth() {
    if (!this.ship) {
      this.player.depthOverride = null;
      return;
    }
    const onShip =
      this.sceneState.mode === "AtHelm" ||
      this.sceneState.mode === "Anchoring" ||
      (this.sceneState.mode === "OnFoot" &&
        this.ship.isOnDeck(this.player.x, this.player.y));
    this.player.depthOverride = onShip ? this.ship.sortY() + 1 : null;
    this.player.sprite.setDepth(this.player.depthOverride ?? this.player.sortY());
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
    this.player.tryMove(dx * PLAYER_SPEED * dt, dy * PLAYER_SPEED * dt, (px, py) =>
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

  private npcAtWorldPoint(x: number, y: number): Npc | null {
    let best: Npc | null = null;
    let bestDist = SHOP_CLICK_RADIUS;
    for (const npc of this.npcs) {
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
    this.lastPlayerDamagedAt = this.time.now;
    this.playerRegenAccum = 0;
    this.flashPlayer();
    spawnFloatingNumber(this, this.player.x, this.player.y - 22, taken, {
      kind: "damage-player",
    });
    if (useGameStore.getState().health.current <= 0) this.handlePlayerDeath();
  }

  private tickPlayerRegen(dtMs: number) {
    if (this.time.now - this.lastPlayerDamagedAt < PLAYER_OUT_OF_COMBAT_MS) return;
    const store = useGameStore.getState();
    const { current } = store.health;
    if (current <= 0) return;
    this.playerRegenAccum += PLAYER_REGEN_PER_SEC * (dtMs / 1000);
    if (this.playerRegenAccum < 1) return;
    const whole = Math.floor(this.playerRegenAccum);
    const healed = store.healthHeal(whole);
    this.playerRegenAccum -= whole;
    if (healed === 0) this.playerRegenAccum = 0; // already full; don't stockpile
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

  private handlePlayerDeath() {
    showToast("You were defeated. Respawning…", 2500, "error");
    const dock = this.world.spawns.dock;
    this.player.setPosition(
      (dock.tileX + 0.5) * TILE_SIZE,
      (dock.tileY + 0.5) * TILE_SIZE,
    );
    useGameStore.getState().healthReset();
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
    } else {
      showToast("Equip a sword, pickaxe, axe, or rod to act with Q.", 1500);
    }
  }

  private nearestNodeForTool(toolId: string | undefined): GatheringNode | null {
    if (!toolId) return null;
    let best: GatheringNode | null = null;
    let bestDist = NODE_INTERACT_RADIUS;
    for (const node of this.nodes) {
      if (!node.isAlive()) continue;
      if (node.def.requiredTool !== toolId) continue;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, node.x, node.y);
      if (d <= bestDist) {
        best = node;
        bestDist = d;
      }
    }
    return best;
  }

  private nearestAnyNodeInReach(): GatheringNode | null {
    let best: GatheringNode | null = null;
    let bestDist = NODE_INTERACT_RADIUS;
    for (const node of this.nodes) {
      if (!node.isAlive()) continue;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, node.x, node.y);
      if (d <= bestDist) {
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
    const entry = this.droppedItemsState.add(
      node.def.drop.itemId,
      node.def.drop.quantity,
      x,
      y,
    );
    this.spawnDroppedSprite(entry);
    showToast(
      `+${node.def.drop.quantity} ${ITEMS[node.def.drop.itemId].name}`,
      1500,
    );
  }

  private loadDropTables() {
    const file = dropTablesDataRaw as DropTablesFile;
    for (const t of file.tables) this.dropTables.set(t.id, t);
  }

  private spawnEnemies() {
    const file = enemiesDataRaw as EnemiesFile;
    const defs = new Map(file.defs.map((d) => [d.id, d]));
    for (const def of file.defs) registerEnemyAnimations(this, def);
    for (const inst of file.instances) {
      const def = defs.get(inst.defId);
      if (!def) {
        console.warn(`Unknown enemy defId: ${inst.defId}`);
        continue;
      }
      this.enemies.push(new Enemy(this, def, inst));
    }
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
    const defs = indexDefs(file.defs);
    for (const inst of file.instances) {
      const def = defs.get(inst.defId);
      if (!def) {
        console.warn(`Unknown node defId: ${inst.defId}`);
        continue;
      }
      this.nodes.push(new GatheringNode(this, def, inst));
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
      const pickup = this.nearestGroundItem();
      if (pickup) {
        this.pickUp(pickup);
        return;
      }
      if (this.isNearHelm()) this.takeHelm();
    } else if (this.sceneState.mode === "AtHelm") {
      this.beginAnchoring();
    }
  }

  private spawnNpcs(data: NpcData = npcDataRaw as NpcData) {
    this.dialogues = data.dialogues ?? {};
    for (const def of data.npcs) {
      registerNpcAnimations(this, def);
      this.npcs.push(new Npc(this, def));
    }
  }

  reloadNpcs(data: NpcData) {
    for (const npc of this.npcs) npc.sprite.destroy();
    this.npcs = [];
    if (this.activeDialogue) this.closeDialogue();
    this.spawnNpcs(data);
  }

  private nearestNpc(): Npc | null {
    let best: Npc | null = null;
    let bestDist = NPC_INTERACT_RADIUS;
    for (const npc of this.npcs) {
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, npc.x, npc.y);
      if (d <= bestDist) {
        best = npc;
        bestDist = d;
      }
    }
    return best;
  }

  private openDialogueWith(npc: Npc) {
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
    });
  }

  /** (Re)spawn ground items from authored data, filtered by the picked-up set. */
  private respawnGroundItems(spawns: ItemSpawn[]) {
    for (const gi of this.groundItems.values()) gi.sprite.destroy();
    this.groundItems.clear();

    for (const s of spawns) {
      if (this.groundItemsState.isPickedUp(s.uid)) continue;
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
        source: "authored",
      });
    }

    // Respawn player-dropped items that haven't expired yet.
    const now = Date.now();
    for (const d of this.droppedItemsState.list()) {
      if (d.expiresAt <= now) continue;
      this.spawnDroppedSprite(d);
    }
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
      if (gi.source === "authored") {
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

  private isNearHelm(): boolean {
    if (this.ship.mode !== "docked") return false;
    const helmTile = Ship.helmTile(this.ship.docked);
    const helmPx = {
      x: (helmTile.x + 0.5) * TILE_SIZE,
      y: (helmTile.y + 0.5) * TILE_SIZE,
    };
    const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, helmPx.x, helmPx.y);
    return d <= HELM_INTERACT_RADIUS;
  }

  // ─── Transition: OnFoot → AtHelm ──────────────────────────────────

  private takeHelm() {
    const helm = this.ship.helmWorldPx();
    this.player.setPosition(helm.x, helm.y);
    this.player.frozen = true;
    this.ship.startSailing();
    this.sceneState.mode = "AtHelm";
    this.cameras.main.startFollow(this.ship.container, true, 0.1, 0.1);
    showToast("W/S throttle, A/D turn 90°, E to drop anchor.", 4500);
    void this.saveController.autosave();
  }

  // ─── Mode: AtHelm ─────────────────────────────────────────────────

  private updateAtHelm(dt: number) {
    if (this.keys.w.isDown || this.keys.up.isDown) {
      this.ship.targetThrottle = Math.min(1, this.ship.targetThrottle + 0.6 * dt);
    } else if (this.keys.s.isDown || this.keys.down.isDown) {
      this.ship.targetThrottle = Math.max(0, this.ship.targetThrottle - 0.6 * dt);
    }

    this.ship.updateSailing(dt);
    this.accrueSailingXp(dt);

    const helm = this.ship.helmWorldPx();
    this.player.setPosition(helm.x, helm.y);
    this.player.sprite.setRotation(0);
    this.player.setFacing(HEADING_TO_FACING[this.ship.heading]);
  }

  // ─── Transition: AtHelm → Anchoring → OnFoot ──────────────────────

  private beginAnchoring() {
    const target = findAnchorPose(
      (tx, ty) => this.world.manager.isAnchorable(tx, ty),
      this.ship.x,
      this.ship.y,
      this.ship.heading,
      this.ship.dims,
      TILE_SIZE,
    );
    if (!target) {
      showToast("No clear water to anchor. Steer away from land.", 2500);
      return;
    }

    this.sceneState.mode = "Anchoring";
    this.ship.mode = "anchoring";
    this.ship.targetThrottle = 0;

    const targetCenter = Ship.bboxCenterPx(target);
    this.ship.setPose(this.ship.x, this.ship.y, target.heading);

    this.tweens.add({
      targets: this.ship,
      x: targetCenter.x,
      y: targetCenter.y,
      duration: 1000,
      ease: "Cubic.easeOut",
      onUpdate: () => {
        this.ship.setPose(this.ship.x, this.ship.y);
        const helm = this.ship.helmWorldPx();
        this.player.setPosition(helm.x, helm.y);
        this.player.sprite.setRotation(0);
        this.player.setFacing(HEADING_TO_FACING[this.ship.heading]);
      },
      onComplete: () => this.finishAnchoring(target),
    });

    showToast("Dropping anchor…", 1200);
  }

  private finishAnchoring(pose: DockedPose) {
    this.ship.finalizeDock(pose);
    const helmTile = Ship.helmTile(pose);
    this.player.setPosition(
      (helmTile.x + 0.5) * TILE_SIZE,
      (helmTile.y + 0.5) * TILE_SIZE,
    );
    this.player.sprite.setRotation(0);
    this.player.frozen = false;
    this.sceneState.mode = "OnFoot";
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
      this.sceneState.mode = "OnFoot";
      this.player.setPosition(
        (this.world.spawns.dock.tileX + 0.5) * TILE_SIZE,
        (this.world.spawns.dock.tileY + 0.5) * TILE_SIZE,
      );
      this.ship.finalizeDock({
        tx: this.world.spawns.ship.tileX,
        ty: this.world.spawns.ship.tileY,
        heading: this.world.spawns.ship.heading,
      });
    }

    this.respawnGroundItems(this.world.spawns.items);
    this.applySceneMode();
    this.emitHud();
  }

  /** Re-enter the current scene mode to fix up camera, freeze, helm parking. */
  private applySceneMode() {
    if (this.sceneState.mode === "AtHelm") {
      this.player.frozen = true;
      this.ship.mode = "sailing";
      const helm = this.ship.helmWorldPx();
      this.player.setPosition(helm.x, helm.y);
      this.player.sprite.setRotation(0);
      this.player.setFacing(HEADING_TO_FACING[this.ship.heading]);
      this.cameras.main.startFollow(this.ship.container, true, 0.1, 0.1);
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
    const onDeck =
      this.ship &&
      this.ship.mode === "docked" &&
      Ship.footprint(this.ship.docked).some((t) => t.x === tx && t.y === ty);
    // Water blocks only when the player isn't standing on a docked ship's deck.
    if (!onDeck && this.world.manager.isWater(tx, ty)) return false;
    // Tile-level `collides: true` + sub-tile shape collision (poles, etc.).
    if (this.world.manager.isBlockedPx(px, py)) return false;
    for (const node of this.nodes) {
      if (node.blocksPx(px, py)) return false;
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
          : this.ship && this.ship.isOnDeck(this.player.x, this.player.y)
            ? "OnDeck"
            : "OnFoot";

    let prompt: string | null = null;
    if (this.sceneState.mode === "OnFoot" && !this.activeDialogue) {
      const npc = this.nearestNpc();
      if (npc) {
        prompt = `Press E to talk to ${npc.def.name}`;
      } else {
        const pickup = this.nearestGroundItem();
        if (pickup) {
          const def = ITEMS[pickup.itemId];
          const qty = pickup.quantity > 1 ? ` ×${pickup.quantity}` : "";
          prompt = `Press E to pick up ${def.name}${qty}`;
        } else if (this.isNearHelm()) {
          prompt = "Press E to take the helm";
        } else {
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
    } else if (this.sceneState.mode === "AtHelm") {
      prompt = "Press E to drop anchor";
    }

    setHud({
      mode: hudMode,
      prompt,
      speed: this.ship ? Math.round(this.ship.speed) : 0,
      heading: this.ship ? normalizeAngle(this.ship.rotation) : 0,
    });
  }

  /**
   * Accrue Sailing XP proportional to distance covered under sail.
   * 1 XP per ~8 pixels of travel — a comfortable pace for early levels
   * without trivialising the curve.
   */
  private accrueSailingXp(dt: number) {
    const traveled = Math.abs(this.ship.speed) * dt;
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
