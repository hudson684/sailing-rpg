import * as Phaser from "phaser";
import { TILE_SIZE } from "../config";
import { bus } from "../bus";
import { Player, PLAYER_SPEED, PLAYER_RADIUS } from "../entities/Player";
import {
  Ship,
  headingToRotation,
  normalizeAngle,
  type DockedPose,
} from "../entities/Ship";
import {
  generateWorld,
  type WorldMap,
  MAP_W,
  MAP_H,
} from "../world/worldMap";
import { TILE_COLORS, Tile, isWalkable as baseIsWalkable, type TileId } from "../world/tiles";
import { findAnchorPose } from "../util/anchor";

type Mode = "OnFoot" | "AtHelm" | "Anchoring";

const HELM_INTERACT_RADIUS = TILE_SIZE * 0.7;

export class WorldScene extends Phaser.Scene {
  private world!: WorldMap;
  private tileGfx!: Phaser.GameObjects.Graphics;
  private player!: Player;
  private ship!: Ship;

  private mode: Mode = "OnFoot";

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
  };

  constructor() {
    super("World");
  }

  create() {
    this.world = generateWorld();
    this.drawTiles();

    // Spawn player on the dock
    const spawnPx = {
      x: (this.world.dockTile.x + 0.5) * TILE_SIZE,
      y: (this.world.dockTile.y + 0.5) * TILE_SIZE,
    };
    this.player = new Player(this, spawnPx.x, spawnPx.y);
    this.ship = new Ship(this, this.world.shipSpawn as DockedPose);

    this.cameras.main.setBounds(0, 0, MAP_W * TILE_SIZE, MAP_H * TILE_SIZE);
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
    };

    this.keys.interact.on("down", () => this.onInteract());

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
    if (this.mode === "OnFoot") this.updateOnFoot(dt);
    else if (this.mode === "AtHelm") this.updateAtHelm(dt);
    else if (this.mode === "Anchoring") {
      // Tween drives the ship; nothing to do here.
    }
    this.emitHud();
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
      if (this.isNearHelm()) this.takeHelm();
    } else if (this.mode === "AtHelm") {
      this.beginAnchoring();
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
    this.mode = "AtHelm";
    this.cameras.main.startFollow(this.ship.container, true, 0.1, 0.1);
    bus.emitTyped("hud:message", "W/S throttle, A/D rudder, E to drop anchor.", 4500);
  }

  // ─── Mode: AtHelm ─────────────────────────────────────────────────

  private updateAtHelm(dt: number) {
    // Throttle: W = more, S = less
    if (this.keys.w.isDown || this.keys.up.isDown) {
      this.ship.targetThrottle = Math.min(1, this.ship.targetThrottle + 0.6 * dt);
    } else if (this.keys.s.isDown || this.keys.down.isDown) {
      this.ship.targetThrottle = Math.max(0, this.ship.targetThrottle - 0.6 * dt);
    }
    // Rudder: A/D; returns to zero when neither held
    if (this.keys.a.isDown || this.keys.left.isDown) this.ship.rudder = -1;
    else if (this.keys.d.isDown || this.keys.right.isDown) this.ship.rudder = 1;
    else this.ship.rudder = 0;

    this.ship.updateSailing(dt);

    // Keep the player parked at the helm
    const helm = this.ship.helmWorldPx();
    this.player.setPosition(helm.x, helm.y);
    this.player.sprite.setRotation(this.ship.rotation);
  }

  // ─── Transition: AtHelm → Anchoring → OnFoot ──────────────────────

  private beginAnchoring() {
    const target = findAnchorPose(
      this.world.tiles,
      this.world.width,
      this.world.height,
      this.ship.x,
      this.ship.y,
      this.ship.rotation,
      TILE_SIZE,
    );
    if (!target) {
      bus.emitTyped("hud:message", "No clear water to anchor. Steer away from land.", 2500);
      return;
    }

    this.mode = "Anchoring";
    this.ship.mode = "anchoring";
    this.ship.targetThrottle = 0;
    this.ship.rudder = 0;

    const targetCenter = Ship.bboxCenterPx(target);
    const targetRot = shortestRotTarget(this.ship.rotation, headingToRotation(target.heading));

    // Drift + pivot tween: position + rotation with smooth easing.
    this.tweens.add({
      targets: this.ship,
      x: targetCenter.x,
      y: targetCenter.y,
      rotation: targetRot,
      duration: 1400,
      ease: "Cubic.easeOut",
      onUpdate: () => {
        this.ship.container.setPosition(this.ship.x, this.ship.y);
        this.ship.container.setRotation(this.ship.rotation);
        // Keep player parked at helm during the drift
        const helm = this.ship.helmWorldPx();
        this.player.setPosition(helm.x, helm.y);
        this.player.sprite.setRotation(this.ship.rotation);
      },
      onComplete: () => this.finishAnchoring(target),
    });

    bus.emitTyped("hud:message", "Dropping anchor…", 1600);
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
    if (tx < 0 || ty < 0 || tx >= this.world.width || ty >= this.world.height) return false;
    const base: TileId = this.world.tiles[ty][tx];
    if (baseIsWalkable(base)) return true;
    // Deck tiles: ship footprint is walkable when docked.
    if (this.ship && this.ship.mode === "docked") {
      const onDeck = Ship.footprint(this.ship.docked).some((t) => t.x === tx && t.y === ty);
      if (onDeck) return true;
    }
    return false;
  }

  // ─── HUD + tile rendering ────────────────────────────────────────

  private drawTiles() {
    this.tileGfx = this.add.graphics();
    this.tileGfx.setDepth(0);
    for (let y = 0; y < this.world.height; y++) {
      for (let x = 0; x < this.world.width; x++) {
        const id = this.world.tiles[y][x];
        this.tileGfx.fillStyle(TILE_COLORS[id], 1);
        this.tileGfx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        if (id === Tile.Water) {
          // Light highlight rows for sea texture
          if ((x + y) % 7 === 0) {
            this.tileGfx.fillStyle(0x2d5a8a, 0.5);
            this.tileGfx.fillRect(
              x * TILE_SIZE + 4,
              y * TILE_SIZE + TILE_SIZE / 2 - 1,
              TILE_SIZE - 8,
              2,
            );
          }
        }
      }
    }
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
    if (this.mode === "OnFoot" && this.isNearHelm()) prompt = "Press E to take the helm";
    else if (this.mode === "AtHelm") prompt = "Press E to drop anchor";

    bus.emitTyped("hud:update", {
      mode: hudMode,
      prompt,
      speed: this.ship ? Math.round(this.ship.speed) : 0,
      heading: this.ship ? normalizeAngle(this.ship.rotation) : 0,
    });
  }
}

function shortestRotTarget(current: number, target: number): number {
  const delta = normalizeAngle(target - current);
  return current + delta;
}
