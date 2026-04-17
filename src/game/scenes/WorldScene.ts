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

type Mode = "OnFoot" | "AtHelm" | "Anchoring";

const HELM_INTERACT_RADIUS = TILE_SIZE * 0.7;
const PICKUP_RADIUS = TILE_SIZE * 0.8;

interface GroundItem {
  id: string;
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
  private groundItems = new Map<string, GroundItem>();

  private mode: Mode = "OnFoot";
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
    // Global-tile coords (chunk 1_0 starts at tile x=32).
    this.decorativeVessels.push(
      new Ship(this, { tx: 73, ty: 20, heading: 1 }, VESSEL_TEMPLATES.galleon),
    );

    this.spawnGroundItems(items);

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
    this.cameras.main.setZoom(1);

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
    };

    this.keys.interact.on("down", () => this.onInteract());
    this.keys.debugGrant.on("down", () => this.grantRandomItem());

    // Cardinal-only helm input: tap A/D (or ←/→) to turn 90° port/starboard.
    const turnPort = () => {
      if (this.mode === "AtHelm") this.ship.turn(-1);
    };
    const turnStarboard = () => {
      if (this.mode === "AtHelm") this.ship.turn(1);
    };
    this.keys.a.on("down", turnPort);
    this.keys.left.on("down", turnPort);
    this.keys.d.on("down", turnStarboard);
    this.keys.right.on("down", turnStarboard);

    this.debug = new DebugOverlays(this, this.world, {
      getShipPose: () =>
        this.ship ? { x: this.ship.x, y: this.ship.y, rotation: this.ship.rotation } : null,
      isAtHelm: () => this.mode === "AtHelm",
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
    });
    this.emitInventory();

    // Initial HUD state
    bus.emitTyped("hud:update", {
      mode: "OnFoot",
      prompt: null,
      speed: 0,
      heading: 0,
      message: null,
    });
    bus.emitTyped("hud:message", "WASD/Arrows to move. E to interact.", 4000);
  }

  update(_time: number, dtMs: number) {
    const dt = dtMs / 1000;
    this.world.manager.tick(dtMs);
    if (this.mode === "OnFoot") this.updateOnFoot(dt);
    else if (this.mode === "AtHelm") this.updateAtHelm(dt);
    else if (this.mode === "Anchoring") {
      // Tween drives the ship; nothing to do here.
    }
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
    if (this.mode === "OnFoot") {
      const pickup = this.nearestGroundItem();
      if (pickup) {
        this.pickUp(pickup);
        return;
      }
      if (this.isNearHelm()) this.takeHelm();
    } else if (this.mode === "AtHelm") {
      this.beginAnchoring();
    }
  }

  private spawnGroundItems(spawns: ItemSpawn[]) {
    for (const s of spawns) {
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
      this.groundItems.set(s.id, {
        id: s.id,
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
      this.groundItems.delete(gi.id);
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
    this.mode = "AtHelm";
    this.cameras.main.startFollow(this.ship.container, true, 0.1, 0.1);
    bus.emitTyped("hud:message", "W/S throttle, A/D turn 90°, E to drop anchor.", 4500);
  }

  // ─── Mode: AtHelm ─────────────────────────────────────────────────

  private updateAtHelm(dt: number) {
    // Throttle: W = more, S = less. Turning is a discrete 90° snap handled via
    // keydown handlers (see create()), so there's no continuous rudder axis.
    if (this.keys.w.isDown || this.keys.up.isDown) {
      this.ship.targetThrottle = Math.min(1, this.ship.targetThrottle + 0.6 * dt);
    } else if (this.keys.s.isDown || this.keys.down.isDown) {
      this.ship.targetThrottle = Math.max(0, this.ship.targetThrottle - 0.6 * dt);
    }

    this.ship.updateSailing(dt);

    // Keep the player parked at the helm
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

    this.mode = "Anchoring";
    this.ship.mode = "anchoring";
    this.ship.targetThrottle = 0;

    const targetCenter = Ship.bboxCenterPx(target);

    // Snap heading immediately (cardinal — no rotation tween needed), then
    // drift the ship into place.
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
    // Player stands on the helm tile, unfrozen.
    const helmTile = Ship.helmTile(pose);
    this.player.setPosition(
      (helmTile.x + 0.5) * TILE_SIZE,
      (helmTile.y + 0.5) * TILE_SIZE,
    );
    this.player.sprite.setRotation(0);
    this.player.frozen = false;
    this.mode = "OnFoot";
    this.cameras.main.startFollow(this.player.sprite, true, 0.15, 0.15);
    bus.emitTyped("hud:message", "Anchored. Walk around or step off the ship.", 3000);
  }

  // ─── Walkability ─────────────────────────────────────────────────

  private isWalkablePx(px: number, py: number): boolean {
    // Sample the player's body at a handful of points so small rocks don't
    // let the player slip through. We test the 4 cardinal edges + center.
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
    // Deck tiles: ship footprint is walkable when docked.
    if (this.ship && this.ship.mode === "docked") {
      const onDeck = Ship.footprint(this.ship.docked).some((t) => t.x === tx && t.y === ty);
      if (onDeck) return true;
    }
    return false;
  }

  private emitHud() {
    const hudMode =
      this.mode === "AtHelm"
        ? "AtHelm"
        : this.mode === "Anchoring"
          ? "Anchoring"
          : this.ship && this.ship.isOnDeck(this.player.x, this.player.y)
            ? "OnDeck"
            : "OnFoot";

    let prompt: string | null = null;
    if (this.mode === "OnFoot") {
      const pickup = this.nearestGroundItem();
      if (pickup) {
        const def = ITEMS[pickup.itemId];
        const qty = pickup.quantity > 1 ? ` ×${pickup.quantity}` : "";
        prompt = `Press E to pick up ${def.name}${qty}`;
      } else if (this.isNearHelm()) {
        prompt = "Press E to take the helm";
      }
    } else if (this.mode === "AtHelm") {
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

