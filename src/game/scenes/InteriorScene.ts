import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import {
  bus,
  type DialogueAction,
  type EditDeleteRequest,
  type EditEntityKind,
  type EditMapId,
  type EditMoveRequest,
  type EditPlaceRequest,
  type EditShopUpdate,
  type EditSnapshot,
} from "../bus";
import { setHud, showToast } from "../../ui/store/ui";
import { Player, PLAYER_SPEED, type Facing } from "../entities/Player";
import { getOrCreatePlayerModel } from "../entities/Player";
import { syncPlayerVisualsFromEquipment } from "../entities/playerEquipmentVisuals";
import { CF_WARDROBE_LAYERS } from "../entities/playerWardrobe";
import { useGameStore } from "../store/gameStore";
import { useSettingsStore } from "../store/settingsStore";
import { stamina, STAMINA_MAX } from "../player/stamina";
import { NpcSprite, NPC_INTERACT_RADIUS, registerNpcAnimations } from "../entities/NpcSprite";
import { CharacterSprite } from "../entities/CharacterSprite";
import { charModelManifestKey, type CharacterModelManifest } from "../entities/npcTypes";
import { NpcModel } from "../entities/NpcModel";
import { SpriteReconciler } from "../entities/SpriteReconciler";
import { entityRegistry } from "../entities/registry";
import type { MapId } from "../entities/mapId";
import { worldTicker } from "../entities/WorldTicker";
import type { DialogueDef, NpcData } from "../entities/npcTypes";
import { addNpc, removeNpcById } from "../entities/npcBootstrap";
import npcDataRaw from "../data/npcs.json";
import { Enemy, registerEnemyAnimations } from "../entities/Enemy";
import enemiesDataRaw from "../data/enemies.json";
import type { EnemiesFile, EnemyDef, EnemyInstanceData } from "../entities/enemyTypes";
import { GatheringNode, type NodeDef, type NodeInstanceData } from "../world/GatheringNode";
import { loadNodesFile } from "../world/GatheringNode";
import nodesDataRaw from "../data/nodes.json";
import { CraftingStation } from "../world/CraftingStation";
import { craftingStations } from "../crafting/stations";
import type { CraftingStationInstanceData } from "../crafting/types";
import { ALL_ITEM_IDS, ITEMS } from "../inventory/items";
import { itemIconTextureKey } from "../assets/keys";
import { EditSystem } from "../edit/EditSystem";
import type { EditHost, EditEntityRef } from "../edit/EditHost";
import {
  loadInteriorInstances,
  mergeInteriorInstances,
  type InteriorEditorItem,
} from "../edit/interiorInstances";
import {
  buildInteriorTilemap,
  destroyInteriorTilemap,
  interiorPixelSize,
  type InteriorTilemap,
} from "../world/interiorTilemap";
import type { InteriorExitSpawn } from "../world/spawns";
import { getActiveSaveController } from "../save/activeController";
import { bindSceneToVirtualInput } from "../input/virtualInputBridge";
import { FishingSession } from "../fishing/fishingSession";
import { bobberOffsetPx, type FishingSurface } from "../fishing/fishingSurface";
import type { ItemId } from "../inventory/items";

const SPRINT_SPEED_MULT = 1.35;
const DOOR_INTERACT_RADIUS = TILE_SIZE * 0.9;

const ZOOM_STEPS = [0.5, 1, 1.5, 2, 3, 4, 6, 8] as const;
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const ZOOM_SMOOTH_RATE = 12;
const ZOOM_SNAP_EPSILON = 0.001;
const WHEEL_SETTLE_MS = 140;

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

interface InteriorGroundItem {
  uid: string;
  itemId: string;
  quantity: number;
  x: number;
  y: number;
  sprite: Phaser.GameObjects.Image;
}

export class InteriorScene extends Phaser.Scene implements EditHost {
  private launchData!: InteriorLaunchData;
  private interior!: InteriorTilemap;
  private player!: Player;
  private npcReconciler!: SpriteReconciler<NpcSprite | CharacterSprite>;
  private lastExitTile: { x: number; y: number } | null = null;
  private dialogues: Record<string, DialogueDef> = {};
  private activeDialogue: { speaker: string; pages: string[]; page: number; shopId?: string } | null = null;
  private fishingSession: FishingSession | null = null;

  // Interior-scoped entities (editor-placed, loaded from interiorInstances.json).
  private enemies: Enemy[] = [];
  private nodes: GatheringNode[] = [];
  private craftingStationsList: CraftingStation[] = [];
  private stationInstanceData: CraftingStationInstanceData[] = [];
  private enemyDefs: Map<string, EnemyDef> = new Map();
  private nodeDefs: Map<string, NodeDef> = new Map();
  private editorItems = new Map<string, InteriorEditorItem>();
  private groundItems = new Map<string, InteriorGroundItem>();
  private editAutoIncrement = 0;
  private editSystem?: EditSystem;
  private npcData: NpcData = npcDataRaw as NpcData;

  private zoomTarget = useSettingsStore.getState().zoom;
  private wheelZoomDir: 1 | -1 | 0 = 0;
  private lastWheelAt = 0;

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

  private unsubEquipment: (() => void) | null = null;
  private unsubWardrobe: (() => void) | null = null;

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

    // Player: bind to the shared model, position one tile north of the
    // interior_exit if present — the exit object is the authoritative door
    // location inside the interior. Fall back to the door's entryTx/entryTy
    // only when the interior has no exit object.
    const exit = this.interior.exits[0];
    const entryTx = exit ? exit.tileX : this.launchData.entryTx;
    const entryTy = exit ? exit.tileY - 1 : this.launchData.entryTy;
    const model = getOrCreatePlayerModel();
    const mapId: MapId = { kind: "interior", key: this.launchData.interiorKey };
    entityRegistry.setMap(model.id, mapId);
    model.x = (entryTx + 0.5) * TILE_SIZE;
    model.y = (entryTy + 0.5) * TILE_SIZE;
    model.facing = "up";
    model.frozen = false;
    this.player = new Player(this, model);
    this.lastExitTile = { x: entryTx, y: entryTy };

    // Camera: bounds to interior, center on player, restore persisted zoom.
    const { w: wPx, h: hPx } = interiorPixelSize(this.interior);
    this.cameras.main.setBounds(0, 0, wPx, hPx, true);
    this.cameras.main.setZoom(this.zoomTarget);
    this.cameras.main.startFollow(this.player.sprite, true, 0.15, 0.15);
    this.cameras.main.setBackgroundColor("#1a1208");

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
        this.zoomTarget = Phaser.Math.Clamp(this.zoomTarget * factor, MIN_ZOOM, MAX_ZOOM);
        useSettingsStore.getState().setZoom(this.zoomTarget);
        this.wheelZoomDir = dy < 0 ? 1 : -1;
        this.lastWheelAt = this.time.now;
      },
    );

    // Wire equipment + wardrobe to the interior's Player instance. (These
    // stores are global, but the sprite layers are per-Player and must be
    // refreshed when a new Player is built in a newly-woken scene.)
    const initialWardrobe = useSettingsStore.getState().wardrobe;
    for (const layer of CF_WARDROBE_LAYERS) {
      this.player.setBaselineLayer(layer, initialWardrobe[layer] ?? null);
    }
    syncPlayerVisualsFromEquipment(this.player, useGameStore.getState().equipment.equipped);
    this.unsubEquipment = useGameStore.subscribe((state, prev) => {
      if (state.equipment.equipped === prev.equipment.equipped) return;
      syncPlayerVisualsFromEquipment(this.player, state.equipment.equipped);
    });
    this.unsubWardrobe = useSettingsStore.subscribe((state, prev) => {
      if (state.wardrobe === prev.wardrobe) return;
      for (const layer of CF_WARDROBE_LAYERS) {
        const next = state.wardrobe[layer] ?? null;
        const previous = prev.wardrobe[layer] ?? null;
        if (next !== previous) this.player.setBaselineLayer(layer, next);
      }
      syncPlayerVisualsFromEquipment(this.player, useGameStore.getState().equipment.equipped);
    });

    bus.onTyped("dialogue:action", this.onDialogueAction);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.onShutdown());

    this.spawnInteriorEntities();

    if (import.meta.env.DEV) {
      this.editSystem = new EditSystem(this);
    }

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
    if (this.editSystem?.isActive()) {
      this.npcReconciler.syncAll();
      this.updateZoom(dtMs);
      this.emitHud();
      return;
    }
    if (!this.activeDialogue) this.updateOnFoot(dt);
    this.checkAutoExit();
    for (const node of this.nodes) node.update(this.time.now);
    const playerCtx = this.activeDialogue
      ? undefined
      : {
          x: this.player.x,
          y: this.player.y,
          onHit: (_dmg: number) => {},
        };
    for (const enemy of this.enemies) {
      enemy.update(
        dtMs,
        this.time.now,
        (x, y) => this.isWalkablePx(x, y),
        playerCtx,
      );
    }
    this.npcReconciler.syncAll();
    this.updateZoom(dtMs);
    this.emitHud();
  }

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
    const sprinting = moving && this.keys.sprint.isDown && stamina.current > 0;
    if (sprinting) stamina.drain(dt);
    const speed = PLAYER_SPEED * (sprinting ? SPRINT_SPEED_MULT : 1);
    this.player.tryMove(dx * speed * dt, dy * speed * dt, (px, py) => this.isWalkablePx(px, py));
  }

  private isWalkablePx(px: number, py: number): boolean {
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
    const exit = this.nearestExit();
    if (exit) {
      this.exitBack();
      return;
    }
    this.tryStartFishing();
  }

  private tryStartFishing(): void {
    const mainHand = useGameStore.getState().equipment.equipped.mainHand;
    if (mainHand !== "fishing_rod") return;
    const off = bobberOffsetPx(this.player.facing);
    const bobberX = this.player.x + off.dx;
    const bobberY = this.player.y + off.dy;
    const targetTx = Math.floor(bobberX / TILE_SIZE);
    const targetTy = Math.floor(bobberY / TILE_SIZE);
    if (
      targetTx < 0 || targetTy < 0 ||
      targetTx >= this.interior.tilemap.width ||
      targetTy >= this.interior.tilemap.height
    ) return;
    const surface = this.interior.registry.fishingSurface(targetTx, targetTy) as FishingSurface | null;
    if (!surface) return;
    if (!this.player.enterFishingPose()) return;
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
      returnFacing: this.launchData.returnFacing,
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
    });
  }

  private emitHud() {
    let prompt: string | null = null;
    if (!this.activeDialogue) {
      const npc = this.nearestNpc();
      if (npc) {
        prompt = `Press E to talk to ${npc.def.name}`;
      } else {
        const exit = this.nearestExit();
        if (exit?.promptOnly) prompt = "Press E to leave";
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
    if (this.wheelZoomDir !== 0 && this.time.now - this.lastWheelAt >= WHEEL_SETTLE_MS) {
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

  private onShutdown() {
    this.fishingSession?.cancel("scene");
    this.fishingSession = null;
    bus.offTyped("dialogue:action", this.onDialogueAction);
    this.unsubEquipment?.();
    this.unsubWardrobe?.();
    this.unsubEquipment = null;
    this.unsubWardrobe = null;
    const mapId: MapId = { kind: "interior", key: this.launchData.interiorKey };
    worldTicker.unregisterWalkable(mapId);
    this.npcReconciler?.shutdown();
    for (const e of this.enemies) {
      entityRegistry.remove(e.id);
      e.destroy();
    }
    this.enemies = [];
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
      const enemy = new Enemy(this, def, e);
      this.enemies.push(enemy);
      entityRegistry.add(enemy);
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
      const m = /^ed-(\d+)$/.exec(it.id);
      if (m) this.editAutoIncrement = Math.max(this.editAutoIncrement, Number(m[1]));
    }
  }

  private bumpAutoIncrement(id: string) {
    const m = /-(\d+)$/.exec(id);
    if (m) this.editAutoIncrement = Math.max(this.editAutoIncrement, Number(m[1]));
  }

  private nextEditId(prefix: string): string {
    for (;;) {
      this.editAutoIncrement += 1;
      const candidate = `${prefix}-${this.editAutoIncrement}`;
      if (!entityRegistry.get(candidate)) return candidate;
    }
  }

  private addGroundItemSprite(it: InteriorEditorItem) {
    const x = (it.tileX + 0.5) * TILE_SIZE;
    const y = (it.tileY + 0.5) * TILE_SIZE;
    const sprite = this.add
      .image(x, y, itemIconTextureKey(it.itemId))
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
    this.groundItems.set(it.id, {
      uid: it.id,
      itemId: it.itemId,
      quantity: it.quantity,
      x,
      y,
      sprite,
    });
  }

  // ── EditHost impl ─────────────────────────────────────────────────
  readonly supportedKinds: readonly EditEntityKind[] = [
    "npc",
    "enemy",
    "node",
    "station",
    "item",
  ];

  get mapId(): EditMapId {
    return `interior:${this.launchData.interiorKey}`;
  }

  get editScene(): Phaser.Scene {
    return this;
  }

  *entities(): Iterable<EditEntityRef> {
    const mid: MapId = { kind: "interior", key: this.launchData.interiorKey };
    for (const m of entityRegistry.getByMap(mid)) {
      if (m.kind === "npc") {
        const n = m as NpcModel;
        yield { kind: "npc", id: n.def.id, x: n.x, y: n.y };
      }
    }
    for (const e of this.enemies) yield { kind: "enemy", id: e.id, x: e.x, y: e.y };
    for (const n of this.nodes) yield { kind: "node", id: n.id, x: n.x, y: n.y };
    for (const s of this.craftingStationsList) {
      yield { kind: "station", id: s.id, x: s.x, y: s.y };
    }
    for (const gi of this.groundItems.values()) {
      yield { kind: "item", id: gi.uid, x: gi.x, y: gi.y };
    }
  }

  getDefs(): EditSnapshot["defs"] {
    return {
      npcs: this.npcData.npcs.map((n) => ({ id: n.id, name: n.name })),
      enemies: Array.from(this.enemyDefs.values()).map((d) => ({ id: d.id, name: d.name })),
      nodes: Array.from(this.nodeDefs.values()).map((d) => ({ id: d.id, name: d.name })),
      stations: craftingStations.all().map((d) => ({ id: d.id, name: d.name })),
      items: ALL_ITEM_IDS.map((id) => ({ id, name: ITEMS[id]?.name ?? id })),
      ships: [],
    };
  }

  buildSnapshot(): Omit<EditSnapshot, "defs" | "supportedKinds"> {
    const map = this.mapId;
    const mid: MapId = { kind: "interior", key: this.launchData.interiorKey };
    const npcs: EditSnapshot["npcs"] = [];
    for (const m of entityRegistry.getByMap(mid)) {
      if (m.kind !== "npc") continue;
      const n = m as NpcModel;
      npcs.push({
        id: n.def.id,
        name: n.def.name,
        tileX: Math.floor(n.x / TILE_SIZE),
        tileY: Math.floor(n.y / TILE_SIZE),
        shopId: n.def.shopId,
        map,
      });
    }
    const enemies = this.enemies.map((e) => ({
      id: e.id,
      defId: e.def.id,
      defName: e.def.name,
      tileX: Math.floor(e.x / TILE_SIZE),
      tileY: Math.floor(e.y / TILE_SIZE),
      map,
    }));
    const nodes = this.nodes.map((n) => ({
      id: n.id,
      defId: n.def.id,
      defName: n.def.name,
      tileX: Math.floor(n.x / TILE_SIZE),
      tileY: Math.floor(n.y / TILE_SIZE),
      map,
    }));
    const stations = this.craftingStationsList.map((s) => ({
      id: s.id,
      defId: s.def.id,
      defName: s.def.name,
      tileX: Math.floor(s.x / TILE_SIZE),
      tileY: Math.floor(s.y / TILE_SIZE),
      map,
    }));
    const items = Array.from(this.groundItems.values()).map((gi) => ({
      id: gi.uid,
      itemId: gi.itemId,
      itemName: ITEMS[gi.itemId as keyof typeof ITEMS]?.name ?? gi.itemId,
      quantity: gi.quantity,
      tileX: Math.floor(gi.x / TILE_SIZE),
      tileY: Math.floor(gi.y / TILE_SIZE),
      source: "editor" as const,
      map,
    }));
    return { map, npcs, enemies, nodes, stations, items, ships: [], shops: [] };
  }

  dragTo(kind: EditEntityKind, id: string, px: number, py: number): void {
    if (kind === "npc") {
      const model = entityRegistry.get(`npc:${id}`) as NpcModel | undefined;
      if (!model) return;
      model.setPositionPx(px, py);
      this.npcReconciler.spriteFor(model.id)?.syncFromModel();
    } else if (kind === "enemy") {
      const e = this.enemies.find((x) => x.id === id);
      if (!e) return;
      e.setPositionPx(px, py);
    } else if (kind === "node") {
      const n = this.nodes.find((x) => x.id === id);
      if (!n) return;
      n.setPositionPx(px, py);
    } else if (kind === "item") {
      const gi = this.groundItems.get(id);
      if (!gi) return;
      gi.x = px;
      gi.y = py;
      gi.sprite.setPosition(px, py);
      gi.sprite.setDepth(py);
    }
  }

  onEntityTap(_kind: EditEntityKind, _id: string): boolean {
    return false;
  }

  move(req: EditMoveRequest): boolean {
    const px = (req.tileX + 0.5) * TILE_SIZE;
    const py = (req.tileY + 0.5) * TILE_SIZE;
    if (req.kind === "npc") {
      const model = entityRegistry.get(`npc:${req.id}`) as NpcModel | undefined;
      if (!model) return false;
      model.def.spawn = { tileX: req.tileX, tileY: req.tileY };
      model.setPositionPx(px, py);
      this.npcReconciler.spriteFor(model.id)?.syncFromModel();
      return true;
    }
    if (req.kind === "enemy") {
      const e = this.enemies.find((x) => x.id === req.id);
      if (!e) return false;
      e.setPositionPx(px, py);
      return true;
    }
    if (req.kind === "node") {
      const idx = this.nodes.findIndex((n) => n.id === req.id);
      if (idx === -1) return false;
      const old = this.nodes[idx];
      old.destroy();
      this.nodes[idx] = new GatheringNode(this, old.def, {
        id: old.id,
        defId: old.def.id,
        tileX: req.tileX,
        tileY: req.tileY,
      });
      return true;
    }
    if (req.kind === "station") {
      const idx = this.craftingStationsList.findIndex((s) => s.id === req.id);
      if (idx === -1) return false;
      const old = this.craftingStationsList[idx];
      old.destroy();
      const inst: CraftingStationInstanceData = {
        id: old.id,
        defId: old.def.id,
        tileX: req.tileX,
        tileY: req.tileY,
      };
      this.craftingStationsList[idx] = new CraftingStation(this, old.def, inst);
      const stored = this.stationInstanceData.find((s) => s.id === req.id);
      if (stored) {
        stored.tileX = req.tileX;
        stored.tileY = req.tileY;
      }
      return true;
    }
    if (req.kind === "item") {
      const gi = this.groundItems.get(req.id);
      if (!gi) return false;
      gi.x = px;
      gi.y = py;
      gi.sprite.setPosition(px, py);
      gi.sprite.setDepth(py);
      const stored = this.editorItems.get(req.id);
      if (stored) {
        stored.tileX = req.tileX;
        stored.tileY = req.tileY;
      }
      return true;
    }
    return false;
  }

  place(req: EditPlaceRequest): boolean {
    const mid: MapId = { kind: "interior", key: this.launchData.interiorKey };
    if (req.kind === "npc") {
      const template = this.npcData.npcs.find((n) => n.id === req.defId);
      if (!template) return false;
      const newId = this.nextEditId(`${template.id}-copy`);
      const clone = JSON.parse(JSON.stringify(template)) as typeof template;
      clone.id = newId;
      clone.spawn = { tileX: req.tileX, tileY: req.tileY };
      clone.map = { interior: this.launchData.interiorKey };
      this.npcData.npcs.push(clone);
      registerNpcAnimations(this, clone);
      addNpc(clone, mid);
      return true;
    }
    if (req.kind === "enemy") {
      const def = this.enemyDefs.get(req.defId);
      if (!def) return false;
      const inst: EnemyInstanceData = {
        id: this.nextEditId(`${def.id}`),
        defId: def.id,
        tileX: req.tileX,
        tileY: req.tileY,
      };
      const enemy = new Enemy(this, def, inst);
      this.enemies.push(enemy);
      entityRegistry.add(enemy);
      return true;
    }
    if (req.kind === "node") {
      const def = this.nodeDefs.get(req.defId);
      if (!def) return false;
      const inst: NodeInstanceData = {
        id: this.nextEditId(`${def.id}`),
        defId: def.id,
        tileX: req.tileX,
        tileY: req.tileY,
      };
      this.nodes.push(new GatheringNode(this, def, inst));
      return true;
    }
    if (req.kind === "station") {
      const def = craftingStations.tryGet(req.defId);
      if (!def) return false;
      const inst: CraftingStationInstanceData = {
        id: this.nextEditId(`${def.id}`),
        defId: def.id,
        tileX: req.tileX,
        tileY: req.tileY,
      };
      this.stationInstanceData.push(inst);
      this.craftingStationsList.push(new CraftingStation(this, def, inst));
      return true;
    }
    if (req.kind === "item") {
      const id = this.nextEditId("ed");
      const item: InteriorEditorItem = {
        id,
        itemId: req.defId as InteriorEditorItem["itemId"],
        quantity: req.quantity ?? 1,
        tileX: req.tileX,
        tileY: req.tileY,
      };
      this.editorItems.set(id, item);
      this.addGroundItemSprite(item);
      return true;
    }
    return false;
  }

  delete(req: EditDeleteRequest): boolean {
    if (req.kind === "npc") {
      if (!entityRegistry.get(`npc:${req.id}`)) return false;
      removeNpcById(req.id);
      this.npcData.npcs = this.npcData.npcs.filter((n) => n.id !== req.id);
      return true;
    }
    if (req.kind === "enemy") {
      const idx = this.enemies.findIndex((e) => e.id === req.id);
      if (idx === -1) return false;
      const e = this.enemies[idx];
      entityRegistry.remove(e.id);
      e.destroy();
      this.enemies.splice(idx, 1);
      return true;
    }
    if (req.kind === "node") {
      const idx = this.nodes.findIndex((n) => n.id === req.id);
      if (idx === -1) return false;
      this.nodes[idx].destroy();
      this.nodes.splice(idx, 1);
      return true;
    }
    if (req.kind === "station") {
      const idx = this.craftingStationsList.findIndex((s) => s.id === req.id);
      if (idx === -1) return false;
      this.craftingStationsList[idx].destroy();
      this.craftingStationsList.splice(idx, 1);
      this.stationInstanceData = this.stationInstanceData.filter((s) => s.id !== req.id);
      return true;
    }
    if (req.kind === "item") {
      const gi = this.groundItems.get(req.id);
      if (!gi) return false;
      gi.sprite.destroy();
      this.groundItems.delete(req.id);
      this.editorItems.delete(req.id);
      return true;
    }
    return false;
  }

  updateShop(_req: EditShopUpdate): boolean {
    return false;
  }

  exportFiles(): Array<{ name: string; content: string }> {
    const enemies: EnemyInstanceData[] = this.enemies.map((e) => ({
      id: e.id,
      defId: e.def.id,
      tileX: Math.floor(e.x / TILE_SIZE),
      tileY: Math.floor(e.y / TILE_SIZE),
    }));
    const nodes: NodeInstanceData[] = this.nodes.map((n) => ({
      id: n.id,
      defId: n.def.id,
      tileX: Math.floor(n.x / TILE_SIZE),
      tileY: Math.floor(n.y / TILE_SIZE),
    }));
    const stations: CraftingStationInstanceData[] = this.craftingStationsList.map((s) => ({
      id: s.id,
      defId: s.def.id,
      tileX: Math.floor(s.x / TILE_SIZE),
      tileY: Math.floor(s.y / TILE_SIZE),
    }));
    const items: InteriorEditorItem[] = Array.from(this.editorItems.values());
    const content = mergeInteriorInstances(this.launchData.interiorKey, {
      enemies,
      nodes,
      stations,
      items,
    });
    const stringify = (obj: unknown) => JSON.stringify(obj, null, 2) + "\n";
    return [
      { name: "interiorInstances.json", content },
      { name: "npcs.json", content: stringify(this.npcData) },
    ];
  }
}
