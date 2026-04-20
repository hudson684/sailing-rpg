import * as Phaser from "phaser";

/**
 * Tiny entry scene. Loads only what the loading screen itself needs (today
 * that's nothing — the progress bar is drawn with `Graphics`), runs any
 * one-time global setup that doesn't require assets, and hands off to
 * `Preload` which does the bulk asset load.
 *
 * Keeping this small and asset-free means the player sees a rendered frame
 * (ocean-blue clear colour from the game config) almost instantly, before
 * the heavier load begins.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  create() {
    this.scene.start("Preload");
  }
}
