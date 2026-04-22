import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import type { Player } from "../entities/Player";
import { useGameStore } from "../store/gameStore";
import { ITEMS } from "../inventory/items";
import { showToast } from "../../ui/store/ui";
import { spawnFloatingNumber } from "../fx/floatingText";
import { rollCatch } from "./catchTables";
import type { FishingSurface } from "./fishingSurface";

type Phase = "waiting" | "biting" | "resolved";

const CAST_ANIM_MS = 750;
const MIN_BITE_DELAY_MS = 2000;
const MAX_BITE_DELAY_MS = 6000;
const BITE_WINDOW_MS = 800;
const CATCH_XP = 12;
const ESCAPE_XP = 2;

interface SessionOpts {
  scene: Phaser.Scene;
  player: Player;
  /** Pixel position of the bobber in the target water tile. */
  bobberX: number;
  bobberY: number;
  surface: FishingSurface;
  /** Interior key when fishing inside an interior; null in the overworld. */
  contextKey: string | null;
  /** Spawns an item drop at the given world-pixel coords. Reuses the scene's
   *  existing dropped-item plumbing (see WorldScene.spawnDroppedSprite). */
  onCatch: (itemId: string, quantity: number) => void;
}

/**
 * A single fishing cast. Owns the bobber FX, the bite timer, the reel
 * window, and the resolve/cancel lifecycle. Scenes construct one on
 * interact with a water tile and tear it down when the player moves,
 * presses interact, or the session ends naturally.
 */
export class FishingSession {
  private readonly opts: SessionOpts;
  private phase: Phase = "waiting";
  private bobber: Phaser.GameObjects.Container | null = null;
  private indicator: Phaser.GameObjects.Text | null = null;
  private biteTimer: Phaser.Time.TimerEvent | null = null;
  private windowTimer: Phaser.Time.TimerEvent | null = null;

  constructor(opts: SessionOpts) {
    this.opts = opts;
  }

  start(): void {
    const { scene, bobberX, bobberY } = this.opts;
    this.bobber = this.makeBobber(scene, bobberX, bobberY);
    const biteDelay = Phaser.Math.Between(
      MIN_BITE_DELAY_MS - CAST_ANIM_MS,
      MAX_BITE_DELAY_MS - CAST_ANIM_MS,
    );
    this.biteTimer = scene.time.delayedCall(
      Math.max(500, CAST_ANIM_MS + biteDelay),
      () => this.onBite(),
    );
  }

  /** Called when the player presses interact while a session is active. */
  pressReel(): void {
    if (this.phase === "biting") {
      this.resolveCatch();
      return;
    }
    // Pressing reel before the bite = fish spooked, cancel cleanly.
    this.cancel("spooked");
  }

  /** External cancel (movement, damage, scene shutdown). */
  cancel(reason: "moved" | "damaged" | "spooked" | "scene" = "moved"): void {
    if (this.phase === "resolved") return;
    this.phase = "resolved";
    this.clearTimers();
    this.destroyBobber();
    this.opts.player.exitFishingPose();
    if (reason === "moved" || reason === "spooked") {
      showToast("Line reeled in.", 900);
    }
  }

  isActive(): boolean {
    return this.phase !== "resolved";
  }

  private onBite(): void {
    if (this.phase !== "waiting") return;
    this.phase = "biting";
    this.showBiteIndicator();
    this.windowTimer = this.opts.scene.time.delayedCall(BITE_WINDOW_MS, () => {
      if (this.phase === "biting") this.resolveEscape();
    });
  }

  private resolveCatch(): void {
    if (this.phase === "resolved") return;
    this.phase = "resolved";
    this.clearTimers();
    this.destroyBobber();
    const { player, scene, surface, contextKey, onCatch } = this.opts;
    const catchResult = rollCatch(surface, contextKey);
    // Play the reel-in animation first; award loot once the fish sprite has
    // cleared the water in the animation's last frame.
    player.playFishReel(() => {
      player.exitFishingPose();
      if (!catchResult) {
        showToast("Nothing biting here.", 1200);
        return;
      }
      onCatch(catchResult.itemId, catchResult.quantity);
      useGameStore.getState().jobsAddXp("fishing", CATCH_XP);
      const itemName = ITEMS[catchResult.itemId]?.name ?? catchResult.itemId;
      showToast(`+${catchResult.quantity} ${itemName}`, 1500);
      spawnFloatingNumber(scene, player.x, player.y - 36, CATCH_XP, { kind: "xp" });
    });
  }

  private resolveEscape(): void {
    if (this.phase === "resolved") return;
    this.phase = "resolved";
    this.clearTimers();
    this.destroyBobber();
    const { player, scene } = this.opts;
    player.exitFishingPose();
    useGameStore.getState().jobsAddXp("fishing", ESCAPE_XP);
    this.spawnEscapeText(scene, player.x, player.y - 36);
  }

  private showBiteIndicator(): void {
    const { scene, bobberX, bobberY } = this.opts;
    const text = scene.add
      .text(bobberX, bobberY - 24, "!", {
        fontFamily: "Impact, 'Arial Black', sans-serif",
        fontSize: "28px",
        color: "#ffe66a",
        stroke: "#2a1a08",
        strokeThickness: 5,
      })
      .setOrigin(0.5, 1)
      .setDepth(100000)
      .setScrollFactor(1);
    this.indicator = text;
    scene.tweens.add({
      targets: text,
      y: bobberY - 36,
      duration: 180,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    if (this.bobber) {
      scene.tweens.add({
        targets: this.bobber,
        y: bobberY + 2,
        duration: 120,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
  }

  private makeBobber(
    scene: Phaser.Scene,
    x: number,
    y: number,
  ): Phaser.GameObjects.Container {
    const c = scene.add.container(x, y);
    const ring = scene.add.circle(0, 0, 4, 0xffffff, 0.0).setStrokeStyle(2, 0xffffff, 0.9);
    const dot = scene.add.circle(0, 0, 2.5, 0xd94c4c, 1);
    const shadow = scene.add.ellipse(0, 3, 8, 3, 0x000000, 0.35);
    c.add([shadow, ring, dot]);
    c.setDepth(y + TILE_SIZE * 0.5);
    // Gentle bob while waiting.
    scene.tweens.add({
      targets: c,
      y: y + 1.5,
      duration: 700,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    return c;
  }

  private spawnEscapeText(scene: Phaser.Scene, x: number, y: number): void {
    const text = scene.add
      .text(x, y, "Got away!", {
        fontFamily: "Impact, 'Arial Black', sans-serif",
        fontSize: "18px",
        color: "#cfd8dc",
        stroke: "#1a1a2a",
        strokeThickness: 4,
      })
      .setOrigin(0.5, 1)
      .setDepth(100000)
      .setScrollFactor(1);
    scene.tweens.add({
      targets: text,
      y: y - 24,
      alpha: 0,
      duration: 900,
      ease: "Sine.easeOut",
      onComplete: () => text.destroy(),
    });
  }

  private clearTimers(): void {
    this.biteTimer?.remove(false);
    this.biteTimer = null;
    this.windowTimer?.remove(false);
    this.windowTimer = null;
  }

  private destroyBobber(): void {
    if (this.indicator) {
      this.opts.scene.tweens.killTweensOf(this.indicator);
      this.indicator.destroy();
      this.indicator = null;
    }
    if (this.bobber) {
      this.opts.scene.tweens.killTweensOf(this.bobber);
      this.bobber.destroy();
      this.bobber = null;
    }
  }
}
