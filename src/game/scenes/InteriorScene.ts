import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { bus, type DialogueAction } from "../bus";
import { setHud, showToast } from "../../ui/store/ui";
import { Player, PLAYER_SPEED, type Facing } from "../entities/Player";
import { getOrCreatePlayerModel } from "../entities/Player";
import { syncPlayerVisualsFromEquipment } from "../entities/playerEquipmentVisuals";
import { CF_WARDROBE_LAYERS } from "../entities/playerWardrobe";
import { useGameStore } from "../store/gameStore";
import { useSettingsStore } from "../store/settingsStore";
import { stamina, STAMINA_MAX } from "../player/stamina";
import { NpcSprite, NPC_INTERACT_RADIUS } from "../entities/NpcSprite";
import { NpcModel } from "../entities/NpcModel";
import { SpriteReconciler } from "../entities/SpriteReconciler";
import { entityRegistry } from "../entities/registry";
import type { MapId } from "../entities/mapId";
import { worldTicker } from "../entities/WorldTicker";
import type { DialogueDef, NpcData } from "../entities/npcTypes";
import npcDataRaw from "../data/npcs.json";
import {
  buildInteriorTilemap,
  destroyInteriorTilemap,
  interiorPixelSize,
  type InteriorTilemap,
} from "../world/interiorTilemap";
import type { InteriorExitSpawn } from "../world/spawns";
import { getActiveSaveController } from "../save/activeController";

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

export class InteriorScene extends Phaser.Scene {
  private launchData!: InteriorLaunchData;
  private interior!: InteriorTilemap;
  private player!: Player;
  private npcReconciler!: SpriteReconciler<NpcSprite>;
  private lastExitTile: { x: number; y: number } | null = null;
  private dialogues: Record<string, DialogueDef> = {};
  private activeDialogue: { speaker: string; pages: string[]; page: number; shopId?: string } | null = null;

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
    this.npcReconciler = new SpriteReconciler<NpcSprite>(
      this,
      mapId,
      (scene, m) => (m.kind === "npc" ? new NpcSprite(scene, m as NpcModel) : null),
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

    showToast("Inside. Walk back through the door to leave.", 2500);
    void getActiveSaveController()?.autosave();
  }

  update(_time: number, dtMs: number) {
    const dt = dtMs / 1000;
    if (!this.activeDialogue) this.updateOnFoot(dt);
    this.checkAutoExit();
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
    const npc = this.nearestNpc();
    if (npc) {
      this.openDialogueWith(npc);
      return;
    }
    const exit = this.nearestExit();
    if (exit) this.exitBack();
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
    bus.offTyped("dialogue:action", this.onDialogueAction);
    this.unsubEquipment?.();
    this.unsubWardrobe?.();
    this.unsubEquipment = null;
    this.unsubWardrobe = null;
    const mapId: MapId = { kind: "interior", key: this.launchData.interiorKey };
    worldTicker.unregisterWalkable(mapId);
    this.npcReconciler?.shutdown();
    // Destroy the scene's Player view; the model lives on in the registry.
    this.player?.destroy();
    if (this.interior) destroyInteriorTilemap(this.interior);
    // Close any open dialogue so it doesn't bleed into World.
    if (this.activeDialogue) this.closeDialogue();
  }
}
