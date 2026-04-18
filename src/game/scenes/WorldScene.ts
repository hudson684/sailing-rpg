import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { bus, type InventoryAction } from "../bus";
import { Inventory } from "../inventory/Inventory";
import { ALL_ITEM_IDS, ITEMS } from "../inventory/items";
import { Player, PLAYER_SPEED, PLAYER_RADIUS } from "../entities/Player";
import {
  Ship,
  normalizeAngle,
  type DockedPose,
} from "../entities/Ship";
import { VESSEL_TEMPLATES } from "../entities/vessels";
import { loadWorld, type WorldMap } from "../world/worldMap";
import type { ItemSpawn } from "../world/spawns";
import type { WorldManifest } from "../world/chunkManager";
import { findAnchorPose } from "../util/anchor";
import { CHUNK_KEY_PREFIX, WORLD_MANIFEST_KEY } from "./BootScene";
import { DebugOverlays, type OverlayName } from "../debug/DebugOverlays";
import { GroundItemsState } from "../world/groundItemsState";
import {
  SaveController,
  SceneState,
  systems as saveSystems,
  type SaveEnvelope,
} from "../save";

const HELM_INTERACT_RADIUS = TILE_SIZE * 0.7;
const PICKUP_RADIUS = TILE_SIZE * 0.8;

const ZOOM_STEPS = [0.5, 1, 1.5, 2, 3] as const;
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const DEFAULT_ZOOM = 1;
const ZOOM_STORAGE_KEY = "sailing-rpg:zoom";

function loadZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (raw == null) return DEFAULT_ZOOM;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_ZOOM;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));
  } catch {
    return DEFAULT_ZOOM;
  }
}

function saveZoom(z: number): void {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(z));
  } catch {
    // localStorage unavailable (private mode, quota); silently ignore.
  }
}
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
  sprite: Phaser.GameObjects.Text;
}

export class WorldScene extends Phaser.Scene {
  private world!: WorldMap;
  private player!: Player;
  private ship!: Ship;
  private decorativeVessels: Ship[] = [];
  private inventory = new Inventory();
  private readonly groundItemsState = new GroundItemsState();
  private readonly sceneState = new SceneState();
  private readonly saveController = new SaveController({
    getSceneKey: () => "World",
    onApplied: (env) => this.applyAfterLoad(env),
    canAutosave: () => this.sceneState.mode !== "Anchoring",
  });
  private groundItems = new Map<string, GroundItem>();

  private zoomTarget = loadZoom();
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
    debugGrant: Phaser.Input.Keyboard.Key;
    quicksave: Phaser.Input.Keyboard.Key;
    quickload: Phaser.Input.Keyboard.Key;
  };

  private onInventoryAction = (action: InventoryAction) => {
    if (action.type === "move") {
      if (this.inventory.move(action.from, action.to)) this.emitInventory();
    } else if (action.type === "drop") {
      const removed = this.inventory.removeAt(action.slot, Number.MAX_SAFE_INTEGER);
      if (removed > 0) {
        this.emitInventory();
        bus.emitTyped("hud:message", `Dropped ${removed}.`, 1500);
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
      debugGrant: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.G),
      quicksave: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F5),
      quickload: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F9),
    };

    this.keys.interact.on("down", () => this.onInteract());
    this.keys.debugGrant.on("down", () => this.grantRandomItem());
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
        saveZoom(this.zoomTarget);
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
    });
    const overlayKeys: Array<[Phaser.Input.Keyboard.Key, OverlayName]> = [
      [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F1), "walkability"],
      [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F2), "chunkGrid"],
      [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F3), "spawns"],
      [this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.F4), "anchorSearch"],
    ];
    for (const [key, name] of overlayKeys) key.on("down", () => this.debug.toggle(name));

    bus.onTyped("inventory:action", this.onInventoryAction);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      bus.offTyped("inventory:action", this.onInventoryAction);
      this.saveController.shutdown();
    });
    this.emitInventory();

    bus.emitTyped("hud:update", {
      mode: "OnFoot",
      prompt: null,
      speed: 0,
      heading: 0,
      message: null,
    });
    bus.emitTyped("hud:message", "WASD/Arrows to move. E interact. ESC menu.", 4000);

    void this.initSave();
  }

  private async initSave(): Promise<void> {
    await this.saveController.init();
    this.saveController.registerSystems([
      saveSystems.inventorySaveable(this.inventory),
      saveSystems.playerSaveable(this.player),
      saveSystems.shipSaveable(this.ship),
      saveSystems.groundItemsSaveable(this.groundItemsState),
      saveSystems.sceneSaveable(this.sceneState),
    ]);
    await this.saveController.refreshMenu();
    await this.saveController.loadLatest();
  }

  update(_time: number, dtMs: number) {
    const dt = dtMs / 1000;
    this.world.manager.tick(dtMs);
    this.saveController.playtime.tick();
    if (this.sceneState.mode === "OnFoot") this.updateOnFoot(dt);
    else if (this.sceneState.mode === "AtHelm") this.updateAtHelm(dt);
    else if (this.sceneState.mode === "Anchoring") {
      // Tween drives the ship; nothing to do here.
    }
    this.updateZoom(dtMs);
    this.emitHud();
    this.debug.update();
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

  private onInteract() {
    if (this.sceneState.mode === "OnFoot") {
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

  /** (Re)spawn ground items from authored data, filtered by the picked-up set. */
  private respawnGroundItems(spawns: ItemSpawn[]) {
    for (const gi of this.groundItems.values()) gi.sprite.destroy();
    this.groundItems.clear();

    for (const s of spawns) {
      if (this.groundItemsState.isPickedUp(s.uid)) continue;
      const def = ITEMS[s.itemId];
      const x = (s.tileX + 0.5) * TILE_SIZE;
      const y = (s.tileY + 0.5) * TILE_SIZE;
      const sprite = this.add
        .text(x, y, def.icon, { fontSize: "20px" })
        .setOrigin(0.5)
        .setDepth(1)
        .setShadow(0, 2, "rgba(0,0,0,0.5)", 3);
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
      });
    }
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
    const leftover = this.inventory.add(gi.itemId, gi.quantity);
    const taken = gi.quantity - leftover;
    if (taken <= 0) {
      bus.emitTyped("hud:message", "Inventory is full.", 1500);
      return;
    }
    const def = ITEMS[gi.itemId];
    if (leftover > 0) {
      gi.quantity = leftover;
      bus.emitTyped("hud:message", `Picked up ${taken} ${def.name} (full).`, 1800);
    } else {
      gi.sprite.destroy();
      this.groundItems.delete(gi.uid);
      this.groundItemsState.markPickedUp(gi.uid);
      bus.emitTyped("hud:message", `Picked up ${taken} ${def.name}.`, 1500);
    }
    this.emitInventory();
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
    bus.emitTyped("hud:message", "W/S throttle, A/D turn 90°, E to drop anchor.", 4500);
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

    const helm = this.ship.helmWorldPx();
    this.player.setPosition(helm.x, helm.y);
    this.player.sprite.setRotation(this.ship.rotation);
  }

  // ─── Transition: AtHelm → Anchoring → OnFoot ──────────────────────

  private beginAnchoring() {
    const target = findAnchorPose(
      (tx, ty) => this.world.manager.isWater(tx, ty),
      this.ship.x,
      this.ship.y,
      this.ship.heading,
      TILE_SIZE,
    );
    if (!target) {
      bus.emitTyped("hud:message", "No clear water to anchor. Steer away from land.", 2500);
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
        this.player.sprite.setRotation(this.ship.rotation);
      },
      onComplete: () => this.finishAnchoring(target),
    });

    bus.emitTyped("hud:message", "Dropping anchor…", 1200);
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
    bus.emitTyped("hud:message", "Anchored. Walk around or step off the ship.", 3000);
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
      this.inventory.hydrate([]);
      this.groundItemsState.reset();
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
    this.emitInventory();
    this.emitHud();
  }

  /** Re-enter the current scene mode to fix up camera, freeze, helm parking. */
  private applySceneMode() {
    if (this.sceneState.mode === "AtHelm") {
      this.player.frozen = true;
      this.ship.mode = "sailing";
      const helm = this.ship.helmWorldPx();
      this.player.setPosition(helm.x, helm.y);
      this.player.sprite.setRotation(this.ship.rotation);
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

  private isWalkablePx(px: number, py: number): boolean {
    const r = PLAYER_RADIUS - 2;
    const samples: [number, number][] = [
      [px, py],
      [px + r, py],
      [px - r, py],
      [px, py + r],
      [px, py - r],
    ];
    for (const [sx, sy] of samples) {
      if (!this.isPointWalkable(sx, sy)) return false;
    }
    return true;
  }

  private isPointWalkable(px: number, py: number): boolean {
    const tx = Math.floor(px / TILE_SIZE);
    const ty = Math.floor(py / TILE_SIZE);
    if (this.world.manager.isLandWalkable(tx, ty)) return true;
    if (this.ship && this.ship.mode === "docked") {
      const onDeck = Ship.footprint(this.ship.docked).some((t) => t.x === tx && t.y === ty);
      if (onDeck) return true;
    }
    return false;
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
    saveZoom(this.zoomTarget);
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
      saveZoom(this.zoomTarget);
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
    if (this.sceneState.mode === "OnFoot") {
      const pickup = this.nearestGroundItem();
      if (pickup) {
        const def = ITEMS[pickup.itemId];
        const qty = pickup.quantity > 1 ? ` ×${pickup.quantity}` : "";
        prompt = `Press E to pick up ${def.name}${qty}`;
      } else if (this.isNearHelm()) {
        prompt = "Press E to take the helm";
      }
    } else if (this.sceneState.mode === "AtHelm") {
      prompt = "Press E to drop anchor";
    }

    bus.emitTyped("hud:update", {
      mode: hudMode,
      prompt,
      speed: this.ship ? Math.round(this.ship.speed) : 0,
      heading: this.ship ? normalizeAngle(this.ship.rotation) : 0,
    });
  }

  private emitInventory() {
    bus.emitTyped("inventory:update", this.inventory.getSlots());
  }

  private grantRandomItem() {
    const id = ALL_ITEM_IDS[Math.floor(Math.random() * ALL_ITEM_IDS.length)];
    const qty = ITEMS[id].stackable ? 1 + Math.floor(Math.random() * 5) : 1;
    const leftover = this.inventory.add(id, qty);
    const added = qty - leftover;
    this.emitInventory();
    if (added > 0) {
      bus.emitTyped("hud:message", `+${added} ${ITEMS[id].name}`, 1500);
    } else {
      bus.emitTyped("hud:message", "Inventory is full.", 1500);
    }
  }
}
