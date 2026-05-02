import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import {
  bus,
  type DialogueAction,
  type DialogueChoiceOption,
} from "../bus";
import { businesses as businessRegistry, businessKinds } from "../business/registry";
import { useBusinessStore } from "../business/businessStore";
import { findUpgradeNode } from "../business/upgradeEffects";
import { getHireable, spritePackSourceNpc } from "../business/hireables";
import type { HiredNpc } from "../business/businessTypes";
import { CustomerSim } from "../business/customerSim";
import { setHud, showToast } from "../../ui/store/ui";
import { Player, type Facing, FACING_VALUES } from "../entities/Player";
import { getOrCreatePlayerModel } from "../entities/Player";
import { bindPlayerVisualSubscriptions } from "../entities/playerEquipmentVisuals";
import { useGameStore } from "../store/gameStore";
import { useShopStore } from "../store/shopStore";
import { stamina, STAMINA_MAX } from "../player/stamina";
import { NpcSprite, NPC_INTERACT_RADIUS } from "../entities/NpcSprite";
import { CharacterSprite } from "../entities/CharacterSprite";
import { charModelManifestKey, type CharacterModelManifest } from "../entities/npcTypes";
import { NpcModel } from "../entities/NpcModel";
import { SpriteReconciler } from "../entities/SpriteReconciler";
import { entityRegistry } from "../entities/registry";
import type { MapId } from "../entities/mapId";
import { worldTicker } from "../entities/WorldTicker";
import type { DialogueDef, NpcData } from "../entities/npcTypes";
import npcDataRaw from "../data/npcs.json";
import { Enemy, registerEnemyAnimations } from "../entities/Enemy";
import enemiesDataRaw from "../data/enemies.json";
import type { EnemiesFile, EnemyDef } from "../entities/enemyTypes";
import { GameplayScene } from "./GameplayScene";
import { foodRegen } from "../player/foodRegen";
import { GatheringNode, type NodeDef } from "../world/GatheringNode";
import { loadNodesFile } from "../world/GatheringNode";
import nodesDataRaw from "../data/nodes.json";
import { CraftingStation } from "../world/CraftingStation";
import { craftingStations } from "../crafting/stations";
import type { CraftingStationInstanceData } from "../crafting/types";
import {
  loadInteriorInstances,
  type InteriorEditorItem,
} from "../data/interiorInstancesLoader";
import {
  buildInteriorTilemap,
  destroyInteriorTilemap,
  interiorPixelSize,
  type InteriorTilemap,
} from "../world/interiorTilemap";
import type { InteriorExitSpawn, RepairTargetSpawn, WorkstationSpawn } from "../world/spawns";
import { getActiveSaveController } from "../save/activeController";
import { bindSceneToVirtualInput } from "../input/virtualInputBridge";
import { FishingSession } from "../fishing/fishingSession";
import { bobberOffsetPx, type FishingSurface } from "../fishing/fishingSurface";
import { ITEMS, type ItemId } from "../inventory/items";
import { ZoomController } from "../camera/ZoomController";
import { MovementController } from "../player/MovementController";

const DOOR_INTERACT_RADIUS = TILE_SIZE * 0.9;
const SHOP_CLICK_RADIUS = TILE_SIZE * 1.5;
const REPAIR_TARGET_INTERACT_RADIUS = TILE_SIZE * 1.6;

/** Payload passed to `scene.launch("Interior", ...)` from WorldScene. */
export interface InteriorLaunchData {
  interiorKey: string;
  entryTx: number;
  entryTy: number;
  /** Tile in the world (outside the door) to return to on exit. */
  returnWorldTx: number;
  returnWorldTy: number;
  /** Facing to restore on return. */
  returnFacing: Facing;
}

/** Payload WorldScene receives when Interior hands control back. */
export interface InteriorReturnData {
  returnWorldTx: number;
  returnWorldTy: number;
  returnFacing: Facing;
}

export class InteriorScene extends GameplayScene {
  private launchData!: InteriorLaunchData;
  private interior!: InteriorTilemap;
  private npcReconciler!: SpriteReconciler<NpcSprite | CharacterSprite>;
  private lastExitTile: { x: number; y: number } | null = null;
  private dialogues: Record<string, DialogueDef> = {};
  private activeDialogue: {
    speaker: string;
    pages: string[];
    page: number;
    shopId?: string;
    choices?: DialogueChoiceOption[];
    onSelect?: (index: number) => void;
  } | null = null;
  // Interior-scoped entities (editor-placed, loaded from interiorInstances.json).
  private nodes: GatheringNode[] = [];
  private craftingStationsList: CraftingStation[] = [];
  private stationInstanceData: CraftingStationInstanceData[] = [];
  private enemyDefs: Map<string, EnemyDef> = new Map();
  private nodeDefs: Map<string, NodeDef> = new Map();
  private editorItems = new Map<string, InteriorEditorItem>();
  /** Entity-registry ids of NPCs spawned for the staff of business(es)
   *  whose `interiorKey` matches this scene. Tracked separately from
   *  `npcDataRaw`-sourced NPCs so we can selectively rebuild them on
   *  `business:staffChanged` without disturbing static NPCs. */
  private hiredStaffNpcIds: string[] = [];
  /** Per-business customer sims for whichever owned business(es) this
   *  interior hosts. Created on enter, torn down on exit. */
  private customerSims: CustomerSim[] = [];

  private zoom!: ZoomController;
  private movement!: MovementController;

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
    quicksave: Phaser.Input.Keyboard.Key;
    quickload: Phaser.Input.Keyboard.Key;
    sprint: Phaser.Input.Keyboard.Key;
  };

  private unsubPlayerVisuals: (() => void) | null = null;

  constructor() {
    super("Interior");
  }

  init(data: InteriorLaunchData) {
    this.launchData = data;
  }

  create() {
    const built = buildInteriorTilemap(this, this.launchData.interiorKey);
    if (!built) {
      console.error(`InteriorScene: failed to build '${this.launchData.interiorKey}'; returning to World.`);
      this.exitBack();
      return;
    }
    this.interior = built;

    const npcData = npcDataRaw as NpcData;
    this.dialogues = npcData.dialogues ?? {};

    // Player: bind to the shared model, position at the authored
    // `interior_entry` object if present, else one tile north of the
    // `interior_exit`, else the door's entryTx/entryTy launch fallback.
    const entry = this.interior.entries[0];
    const exit = this.interior.exits[0];
    const entryTx = entry ? entry.tileX : exit ? exit.tileX : this.launchData.entryTx;
    const entryTy = entry ? entry.tileY : exit ? exit.tileY - 1 : this.launchData.entryTy;
    const model = getOrCreatePlayerModel();
    const mapId: MapId = { kind: "interior", key: this.launchData.interiorKey };
    entityRegistry.setMap(model.id, mapId);
    model.x = (entryTx + 0.5) * TILE_SIZE;
    model.y = (entryTy + 0.5) * TILE_SIZE;
    model.facing =
      entry && FACING_VALUES.includes(entry.facing as Facing)
        ? (entry.facing as Facing)
        : "up";
    model.frozen = false;
    this.player = new Player(this, model);
    this.lastExitTile = { x: entryTx, y: entryTy };

    // Camera: bounds to interior, center on player, restore persisted zoom.
    this.cameras.main.startFollow(this.player.sprite, true, 0.15, 0.15);
    this.cameras.main.setBackgroundColor("#1a1208");
    this.zoom = new ZoomController(this, {
      onZoomApplied: () => this.updateCenteredCameraBounds(),
    });
    this.updateCenteredCameraBounds();

    // Track canvas resizes (window/orientation change). Otherwise the main
    // camera viewport stays at its initial size and any extra canvas area
    // renders as the WebGL clear colour (black).
    this.scale.on("resize", this.onScaleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off("resize", this.onScaleResize, this);
    });

    // Interior NPC reconciler + walkability provider.
    this.npcReconciler = new SpriteReconciler<NpcSprite | CharacterSprite>(
      this,
      mapId,
      (scene, m) => {
        if (m.kind !== "npc") return null;
        const npc = m as NpcModel;
        if (npc.def.layered) {
          const manifest = scene.cache.json.get(charModelManifestKey(npc.def.layered.model)) as
            | CharacterModelManifest
            | undefined;
          if (manifest) return new CharacterSprite(scene, npc, manifest);
          if (!npc.def.sprite) return null;
        }
        return new NpcSprite(scene, npc);
      },
    );
    worldTicker.registerWalkable(mapId, (x, y) => this.isWalkablePx(x, y));

    // Input.
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
      quicksave: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F5),
      quickload: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F9),
      sprint: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT),
    };
    this.input.keyboard!.addCapture([
      Phaser.Input.Keyboard.KeyCodes.SHIFT,
      Phaser.Input.Keyboard.KeyCodes.UP,
      Phaser.Input.Keyboard.KeyCodes.DOWN,
      Phaser.Input.Keyboard.KeyCodes.LEFT,
      Phaser.Input.Keyboard.KeyCodes.RIGHT,
    ]);

    this.keys.interact.on("down", () => this.onInteract());

    // Right-click an NPC with a `shopId` to open their shop directly.
    this.input.mouse?.disableContextMenu();
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (!pointer.rightButtonDown()) return;
      this.onRightClick(pointer.worldX, pointer.worldY);
    });

    // Route mobile touch controls through the same Phaser Key objects the
    // keyboard populates, so `isDown` polling and `"down"` handlers both fire.
    bindSceneToVirtualInput(this, {
      up: this.keys.up,
      down: this.keys.down,
      left: this.keys.left,
      right: this.keys.right,
      interact: this.keys.interact,
      sprint: this.keys.sprint,
    });
    this.keys.quicksave.on("down", () => {
      bus.emitTyped("save:request", { type: "save", slot: "quicksave" });
    });
    this.keys.quickload.on("down", () => {
      bus.emitTyped("save:request", { type: "load", slot: "quicksave" });
    });

    this.movement = new MovementController({
      keys: this.keys,
      player: this.player,
      isWalkablePx: (px, py) => this.isWalkablePx(px, py),
      slopeAtPx: (px, py) => {
        const tx = Math.floor(px / TILE_SIZE);
        const ty = Math.floor(py / TILE_SIZE);
        return this.interior.registry.slopeAt(tx, ty);
      },
    });

    // Wire equipment + wardrobe to the interior's Player instance. (These
    // stores are global, but the sprite layers are per-Player and must be
    // refreshed when a new Player is built in a newly-woken scene.)
    this.unsubPlayerVisuals = bindPlayerVisualSubscriptions(this.player);
    bus.onTyped("dialogue:action", this.onDialogueAction);
    bus.onTyped("business:staffChanged", this.onStaffChanged);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.onShutdown());

    // Wire combat (Q-attack, hotbar, projectiles, drop-table loader). Must
    // run after `this.player` is assigned.
    this.setupCombat();

    this.spawnInteriorEntities();

    showToast("Inside. Walk back through the door to leave.", 2500);
    bus.emitTyped("world:mapEntered", {
      mapId: `interior:${this.launchData.interiorKey}`,
      fromMapId: "world",
      reason: "transition",
    });
    void getActiveSaveController()?.autosave();
  }

  update(_time: number, dtMs: number) {
    const dt = dtMs / 1000;
    if (!this.activeDialogue) this.updateOnFoot(dt);
    this.checkAutoExit();
    for (const node of this.nodes) node.update(this.time.now);
    // Enemies, projectiles, and bow reticle are owned by the GameplayScene base.
    this.tickCombat(dtMs);
    this.tickCustomerSims(dtMs);
    this.npcReconciler.syncAll();
    this.zoom.update(dtMs);
    this.emitHud();
  }

  private updateOnFoot(dt: number) {
    this.movement.update(dt);
  }

  protected isWalkablePx(px: number, py: number): boolean {
    const tx = Math.floor(px / TILE_SIZE);
    const ty = Math.floor(py / TILE_SIZE);
    if (
      tx < 0 || ty < 0 ||
      tx >= this.interior.tilemap.width ||
      ty >= this.interior.tilemap.height
    ) return false;
    if (this.interior.registry.isBlocked(tx, ty)) return false;
    return !this.interior.shapes.isBlockedAtLocalPx(px, py);
  }

  // ─── GameplayScene hook implementations ──────────────────────────────────

  protected getMapId(): string {
    return `interior:${this.launchData.interiorKey}`;
  }

  /** Interior is always on-foot when not in dialogue — no helm or anchoring. */
  protected isOnFoot(): boolean {
    return !this.activeDialogue;
  }

  protected isDialogueActive(): boolean {
    return this.activeDialogue !== null;
  }

  protected isBlockedPx(x: number, y: number): boolean {
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    if (
      tx < 0 || ty < 0 ||
      tx >= this.interior.tilemap.width ||
      ty >= this.interior.tilemap.height
    ) return true;
    if (this.interior.registry.isBlocked(tx, ty)) return true;
    return this.interior.shapes.isBlockedAtLocalPx(x, y);
  }

  protected nearestNodeForTool(toolId: string | undefined): GatheringNode | null {
    if (!toolId) return null;
    let best: GatheringNode | null = null;
    let bestDist = Infinity;
    for (const node of this.nodes) {
      if (!node.isAlive()) continue;
      if (node.def.requiredTool !== toolId) continue;
      const reach = TILE_SIZE * 1.4 * (node.def.interactRadiusMul ?? 1);
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, node.x, node.y);
      if (d <= reach && d <= bestDist) {
        best = node;
        bestDist = d;
      }
    }
    return best;
  }

  protected gatherFromNode(node: GatheringNode): void {
    const animState = node.def.kind === "tree" ? "chop" : "mine";
    const mapId = this.getMapId();
    this.player.playAction(animState, () => {
      const broken = node.hit(this);
      useGameStore.getState().jobsAddXp(node.def.skill, node.def.xpPerHit);
      bus.emitTyped("gathering:nodeHit", { defId: node.def.id, mapId });
      if (node.def.perHitDrop) {
        const drop = node.def.perHitDrop;
        const ox = (Math.random() - 0.5) * TILE_SIZE * 0.5;
        const oy = TILE_SIZE * 0.4 + Math.random() * 6;
        const qMax = drop.quantityMax ?? drop.quantity;
        const qty = drop.quantity + Math.floor(Math.random() * (qMax - drop.quantity + 1));
        if (qty > 0) this.dropLoot(drop.itemId, qty, node.x + ox, node.y + oy);
      }
      if (broken) {
        const { itemId, quantity: qMin, quantityMax } = node.def.drop;
        const qMax = quantityMax ?? qMin;
        const quantity = qMin + Math.floor(Math.random() * (qMax - qMin + 1));
        const ox = (Math.random() - 0.5) * TILE_SIZE * 0.5;
        const oy = TILE_SIZE * 0.4 + Math.random() * 6;
        this.dropLoot(itemId, quantity, node.x + ox, node.y + oy);
        showToast(`+${quantity} ${ITEMS[itemId].name}`, 1500);
        bus.emitTyped("gathering:nodeHarvested", {
          defId: node.def.id,
          mapId,
          yieldedItemId: itemId,
          yieldedQuantity: quantity,
        });
      }
    });
  }

  // spawnDroppedSprite + pickup helpers are inherited from GameplayScene.

  /** On death inside an interior, kick the player back out to the world
   *  and let `onInteriorWake` snap them to the saved respawn point. */
  protected onPlayerDeathRespawn(): void {
    foodRegen.reset();
    this.exitBack();
  }

  private onInteract() {
    if (this.activeDialogue) {
      this.onDialogueAction({ type: "advance" });
      return;
    }
    // Active fishing cast: E reels or cancels.
    if (this.fishingSession && this.fishingSession.isActive()) {
      this.fishingSession.pressReel();
      return;
    }
    const npc = this.nearestNpc();
    if (npc) {
      this.openDialogueWith(npc);
      return;
    }
    const repair = this.nearestRepairTarget();
    if (repair) {
      this.interactWithRepairTarget(repair);
      return;
    }
    if (this.tryPickupNearby()) return;
    const exit = this.nearestExit();
    if (exit) {
      this.exitBack();
      return;
    }
    if (useGameStore.getState().equipment.equipped.mainHand === "fishing_rod") {
      this.tryStartFishing();
    }
  }

  private nearestRepairTarget(): RepairTargetSpawn | null {
    let best: RepairTargetSpawn | null = null;
    let bestDist = REPAIR_TARGET_INTERACT_RADIUS;
    const unlocked = (id: string) => {
      const state = useBusinessStore.getState().get(id);
      return new Set(state?.unlockedNodes ?? []);
    };
    for (const r of this.interior.repairTargets) {
      // Already-unlocked nodes don't show a prompt — the repaired view has
      // taken over.
      if (unlocked(r.businessId).has(r.nodeId)) continue;
      const x = (r.tileX + 0.5) * TILE_SIZE;
      const y = (r.tileY + 0.5) * TILE_SIZE;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, x, y);
      if (d <= bestDist) {
        best = r;
        bestDist = d;
      }
    }
    return best;
  }

  private interactWithRepairTarget(target: RepairTargetSpawn) {
    const def = businessRegistry.tryGet(target.businessId);
    if (!def) {
      showToast("Unknown business.", 1500, "warn");
      return;
    }
    const kind = businessKinds.tryGet(def.kindId);
    if (!kind) return;
    const node = findUpgradeNode(kind, target.nodeId);
    if (!node) {
      showToast("Unknown upgrade.", 1500, "warn");
      return;
    }
    const state = useBusinessStore.getState().get(target.businessId);
    if (!state || !state.owned) {
      showToast(`You don't own ${def.displayName}.`, 1800, "warn");
      return;
    }
    const coffers = state.coffers;
    const canAfford = coffers >= node.cost;
    const speaker = node.displayName;
    const pages = canAfford
      ? [
          `${node.description}\n\nPay ${node.cost} coin from coffers? ` +
            `(coffers: ${coffers})`,
        ]
      : [
          `${node.description}\n\nNeeds ${node.cost} coin in the till. ` +
            `Coffers hold ${coffers}.`,
        ];
    const choices: DialogueChoiceOption[] = canAfford
      ? [
          { label: "Yes — fix it", goto: "" },
          { label: "Not yet", goto: "" },
        ]
      : [{ label: "Walk away", goto: "" }];
    this.activeDialogue = {
      speaker,
      pages,
      page: 0,
      choices,
      onSelect: (index) => {
        if (!canAfford || index !== 0) return;
        const result = useBusinessStore
          .getState()
          .tryUnlockNode(target.businessId, target.nodeId);
        if (result.ok) {
          showToast(`${node.displayName} — done!`, 2500, "success");
        } else {
          const reasonMsg: Record<string, string> = {
            unknownBusiness: "Unknown business.",
            unknownNode: "Unknown upgrade.",
            notOwned: "You don't own this property.",
            alreadyUnlocked: "Already done.",
            missingPrerequisites: "Finish the earlier repairs first.",
            insufficientCoffers: "Not enough coin in the till.",
          };
          showToast(reasonMsg[result.reason] ?? "Repair failed.", 1800, "warn");
        }
      },
    };
    this.emitDialogue();
  }

  protected tryStartFishing(): boolean {
    const off = bobberOffsetPx(this.player.facing);
    const bobberX = this.player.x + off.dx;
    const bobberY = this.player.y + off.dy;
    const targetTx = Math.floor(bobberX / TILE_SIZE);
    const targetTy = Math.floor(bobberY / TILE_SIZE);
    if (
      targetTx < 0 || targetTy < 0 ||
      targetTx >= this.interior.tilemap.width ||
      targetTy >= this.interior.tilemap.height
    ) return false;
    const surface = this.interior.registry.fishingSurface(targetTx, targetTy) as FishingSurface | null;
    if (!surface) return false;
    if (!this.player.enterFishingPose()) return false;
    const session = new FishingSession({
      scene: this,
      player: this.player,
      bobberX,
      bobberY,
      surface,
      contextKey: this.launchData.interiorKey,
      onCatch: (itemId, quantity) => {
        const leftover = useGameStore.getState().inventoryAdd(itemId as ItemId, quantity);
        if (leftover > 0) showToast("Inventory full — some fish got away.", 1500);
      },
    });
    this.fishingSession = session;
    session.start();
    return true;
  }

  private onRightClick(worldX: number, worldY: number) {
    if (this.activeDialogue) return;
    const npc = this.npcAtWorldPoint(worldX, worldY);
    if (!npc || !npc.def.shopId) return;
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
    const mapId: MapId = { kind: "interior", key: this.launchData.interiorKey };
    let best: NpcModel | null = null;
    let bestDist = SHOP_CLICK_RADIUS;
    for (const m of entityRegistry.getByMap(mapId)) {
      if (m.kind !== "npc") continue;
      const npc = m as NpcModel;
      const d = Phaser.Math.Distance.Between(x, y, npc.x, npc.y);
      if (d <= bestDist) {
        best = npc;
        bestDist = d;
      }
    }
    return best;
  }

  private nearestNpc(): NpcModel | null {
    const mapId: MapId = { kind: "interior", key: this.launchData.interiorKey };
    let best: NpcModel | null = null;
    let bestDist = Infinity;
    for (const m of entityRegistry.getByMap(mapId)) {
      if (m.kind !== "npc") continue;
      const npc = m as NpcModel;
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

  private nearestExit(): InteriorExitSpawn | null {
    let best: InteriorExitSpawn | null = null;
    let bestDist = DOOR_INTERACT_RADIUS;
    for (const e of this.interior.exits) {
      const dx = (e.tileX + 0.5) * TILE_SIZE - this.player.x;
      const dy = (e.tileY + 0.5) * TILE_SIZE - this.player.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= bestDist) {
        best = e;
        bestDist = dist;
      }
    }
    return best;
  }

  private checkAutoExit() {
    const tx = Math.floor(this.player.x / TILE_SIZE);
    const ty = Math.floor(this.player.y / TILE_SIZE);
    const last = this.lastExitTile;
    if (last && last.x === tx && last.y === ty) return;
    this.lastExitTile = { x: tx, y: ty };
    for (const e of this.interior.exits) {
      if (e.promptOnly) continue;
      if (e.tileX === tx && e.tileY === ty) {
        this.exitBack();
        return;
      }
    }
  }

  /** Hand control back to WorldScene and stop this scene. */
  private exitBack() {
    const ret: InteriorReturnData = {
      returnWorldTx: this.launchData.returnWorldTx,
      returnWorldTy: this.launchData.returnWorldTy,
      returnFacing: this.player.facing,
    };
    // Wake World first; pass the return payload via wake data — WorldScene
    // listens for SCENE_WAKE. Then stop self.
    this.scene.wake("World", ret);
    this.scene.stop();
  }

  private openDialogueWith(npc: NpcModel) {
    const dialogue = this.dialogues[npc.def.dialogue];
    if (!dialogue) {
      showToast(`${npc.def.name} has nothing to say.`, 1500);
      return;
    }
    bus.emitTyped("npc:interacted", {
      npcId: npc.def.id,
      mapId: `interior:${this.launchData.interiorKey}`,
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

  private closeDialogue() {
    this.activeDialogue = null;
    bus.emitTyped("dialogue:update", { visible: false, speaker: "", pages: [], page: 0 });
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

  private emitHud() {
    let prompt: string | null = null;
    if (!this.activeDialogue) {
      const npc = this.nearestNpc();
      if (npc) {
        prompt = `Press E to talk to ${npc.def.name}`;
      } else {
        const repair = this.nearestRepairTarget();
        if (repair) {
          const kind = (() => {
            const def = businessRegistry.tryGet(repair.businessId);
            return def ? businessKinds.tryGet(def.kindId) : null;
          })();
          const node = kind ? findUpgradeNode(kind, repair.nodeId) : null;
          prompt = node
            ? `Press E — ${node.displayName.toLowerCase()}`
            : "Press E to repair";
        } else {
          const exit = this.nearestExit();
          if (exit?.promptOnly) prompt = "Press E to leave";
        }
      }
    }
    setHud({
      mode: "OnFoot",
      prompt,
      speed: 0,
      heading: 0,
      message: null,
      stamina: Math.round(stamina.current),
      staminaMax: STAMINA_MAX,
    });
  }

  private onScaleResize(gameSize: Phaser.Structs.Size) {
    this.cameras.main.setViewport(0, 0, gameSize.width, gameSize.height);
    this.updateCenteredCameraBounds();
  }

  /** Set camera bounds so a small interior is centered in the viewport
   *  instead of pinned to the top-left.
   *
   *  When `bounds.size === camera display size` on an axis, Phaser's
   *  `clampToBounds` locks `scrollX/Y` to `bounds.x/y` (because the clamp
   *  range collapses to a single value). We exploit this by expanding the
   *  bounds to the viewport size on any axis where the map is smaller, and
   *  shifting `bounds.x/y` so the clamp lands on the centered scroll. On
   *  axes where the map is larger, normal scroll-to-follow behavior is
   *  preserved. */
  private updateCenteredCameraBounds() {
    if (!this.interior) return;
    const cam = this.cameras.main;
    const { w: mapW, h: mapH } = interiorPixelSize(this.interior);
    const zoom = cam.zoom > 0 ? cam.zoom : 1;
    const viewW = cam.width / zoom;
    const viewH = cam.height / zoom;

    let bx = 0;
    let by = 0;
    let bw = mapW;
    let bh = mapH;
    if (mapW < viewW) {
      bx = -(viewW - mapW) / 2;
      bw = viewW;
    }
    if (mapH < viewH) {
      by = -(viewH - mapH) / 2;
      bh = viewH;
    }
    cam.setBounds(bx, by, bw, bh, false);
  }

  private onShutdown() {
    this.fishingSession?.cancel("scene");
    this.fishingSession = null;
    bus.offTyped("dialogue:action", this.onDialogueAction);
    bus.offTyped("business:staffChanged", this.onStaffChanged);
    this.stopCustomerSims();
    this.despawnHiredStaff();
    this.unsubPlayerVisuals?.();
    this.unsubPlayerVisuals = null;
    const mapId: MapId = { kind: "interior", key: this.launchData.interiorKey };
    worldTicker.unregisterWalkable(mapId);
    this.npcReconciler?.shutdown();
    this.teardownCombat();
    for (const n of this.nodes) n.destroy();
    this.nodes = [];
    for (const s of this.craftingStationsList) s.destroy();
    this.craftingStationsList = [];
    for (const gi of this.groundItems.values()) gi.sprite.destroy();
    this.groundItems.clear();
    // Destroy the scene's Player view; the model lives on in the registry.
    this.player?.destroy();
    if (this.interior) destroyInteriorTilemap(this.interior);
    // Close any open dialogue so it doesn't bleed into World.
    if (this.activeDialogue) this.closeDialogue();
  }

  // ── Interior entity spawning ─────────────────────────────────────
  private spawnInteriorEntities() {
    const file = enemiesDataRaw as EnemiesFile;
    for (const def of file.defs) {
      this.enemyDefs.set(def.id, def);
      registerEnemyAnimations(this, def);
    }
    const nodes = loadNodesFile(nodesDataRaw);
    for (const def of nodes.defs) this.nodeDefs.set(def.id, def);

    const inst = loadInteriorInstances(this.launchData.interiorKey);

    for (const e of inst.enemies) {
      const def = this.enemyDefs.get(e.defId);
      if (!def) continue;
      this.addEnemy(new Enemy(this, def, e));
      this.bumpAutoIncrement(e.id);
    }
    for (const n of inst.nodes) {
      const def = this.nodeDefs.get(n.defId);
      if (!def) continue;
      this.nodes.push(new GatheringNode(this, def, n));
      this.bumpAutoIncrement(n.id);
    }
    for (const s of inst.stations) {
      const def = craftingStations.tryGet(s.defId);
      if (!def) continue;
      this.stationInstanceData.push({ ...s });
      this.craftingStationsList.push(new CraftingStation(this, def, s));
      this.bumpAutoIncrement(s.id);
    }
    for (const it of inst.items) {
      this.editorItems.set(it.id, { ...it });
      this.addGroundItemSprite(it);
    }
    this.spawnHiredStaff();
    this.startCustomerSims();
  }

  private startCustomerSims(): void {
    for (const def of businessRegistry.all()) {
      if (def.interiorKey !== this.launchData.interiorKey) continue;
      const state = useBusinessStore.getState().get(def.id);
      if (!state || !state.owned) continue;
      const sim = new CustomerSim({
        scene: this,
        businessId: def.id,
        interiorKey: this.launchData.interiorKey,
        interior: this.interior,
        isWalkablePx: (px, py) => this.isWalkablePx(px, py),
      });
      sim.start();
      this.customerSims.push(sim);
    }
  }

  private tickCustomerSims(dtMs: number): void {
    for (const sim of this.customerSims) sim.tick(dtMs);
  }

  private stopCustomerSims(): void {
    for (const sim of this.customerSims) sim.stop();
    this.customerSims = [];
  }

  /** Spawn one wandering NpcModel per HiredNpc whose business `interiorKey`
   *  matches this scene's interior. Each is anchored at the workstation
   *  Tiled object whose `tag` matches the role's `workstationTag`. Staff
   *  with no matching workstation fall back to the entry tile so they're
   *  not invisible — easy to spot and fix in Tiled. */
  private spawnHiredStaff() {
    const interiorKey = this.launchData.interiorKey;
    const wsByTag = new Map<string, WorkstationSpawn[]>();
    for (const w of this.interior.workstations) {
      const list = wsByTag.get(w.tag) ?? [];
      list.push(w);
      wsByTag.set(w.tag, list);
    }
    const fallbackEntry = this.interior.entries[0];
    const fallbackTile = fallbackEntry
      ? { tileX: fallbackEntry.tileX, tileY: fallbackEntry.tileY }
      : { tileX: 1, tileY: 1 };

    const mapId: MapId = { kind: "interior", key: interiorKey };
    for (const bizDef of businessRegistry.all()) {
      if (bizDef.interiorKey !== interiorKey) continue;
      const state = useBusinessStore.getState().get(bizDef.id);
      if (!state || !state.owned) continue;
      const kind = businessKinds.tryGet(bizDef.kindId);
      if (!kind) continue;
      const rolesById = new Map(kind.roles.map((r) => [r.id, r]));
      for (const hire of state.staff) {
        const role = rolesById.get(hire.roleId);
        if (!role) continue;
        const sources = wsByTag.get(role.workstationTag) ?? [];
        // Pick a stable workstation per (hireableId) so re-spawns land in
        // the same spot — hash the id into the slot index.
        const tile = sources.length > 0
          ? sources[hashIndex(hire.hireableId, sources.length)]
          : fallbackTile;
        const npc = this.synthesizeStaffNpc(bizDef.id, hire, tile.tileX, tile.tileY);
        if (!npc) continue;
        if (entityRegistry.get(npc.id)) entityRegistry.remove(npc.id);
        const model = new NpcModel(npc, mapId);
        entityRegistry.add(model);
        this.hiredStaffNpcIds.push(model.id);
      }
    }
  }

  private despawnHiredStaff() {
    for (const id of this.hiredStaffNpcIds) {
      if (entityRegistry.get(id)) entityRegistry.remove(id);
    }
    this.hiredStaffNpcIds = [];
  }

  private synthesizeStaffNpc(
    businessId: string,
    hire: HiredNpc,
    tileX: number,
    tileY: number,
  ): import("../entities/npcTypes").NpcDef | null {
    const hireableDef = getHireable(hire.hireableId);
    if (!hireableDef) return null;
    const source = spritePackSourceNpc(hireableDef.spritePack);
    if (!source || !source.sprite) return null;
    return {
      id: `staff:${businessId}:${hire.hireableId}`,
      name: hireableDef.name,
      sprite: source.sprite,
      spritePackId: source.id,
      display: source.display,
      map: { interior: this.launchData.interiorKey },
      spawn: { tileX, tileY },
      facing: "down",
      movement: {
        type: "wander",
        radiusTiles: 1.2,
        moveSpeed: 18,
        pauseMs: 1500,
        stepMs: 900,
      },
      dialogue: "",
    };
  }

  private onStaffChanged = ({ businessId }: { businessId: string }) => {
    const def = businessRegistry.tryGet(businessId);
    if (!def) return;
    if (def.interiorKey !== this.launchData.interiorKey) return;
    this.despawnHiredStaff();
    this.spawnHiredStaff();
  };

  private bumpAutoIncrement(_id: string) {
    // No-op since edit-mode placement was removed; kept for call-site stability.
  }

  private addGroundItemSprite(it: InteriorEditorItem) {
    this.spawnGroundItemSprite({
      uid: it.id,
      itemId: it.itemId,
      quantity: it.quantity,
      x: (it.tileX + 0.5) * TILE_SIZE,
      y: (it.tileY + 0.5) * TILE_SIZE,
      source: "static",
    });
  }

  /** Drop the editor record so a re-spawn within this scene visit doesn't
   *  re-create the picked-up item. (Interior pickups don't currently persist
   *  across re-entry; the JSON file is reloaded each time.) */
  protected onStaticPickedUp(uid: string): void {
    this.editorItems.delete(uid);
  }

}

function hashIndex(s: string, mod: number): number {
  if (mod <= 1) return 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % mod;
}
