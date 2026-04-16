import * as Phaser from "phaser";

/**
 * BootScene is intentionally tiny — everything we need is drawn with
 * Graphics/Rectangle primitives, so no asset loading is required yet.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  create() {
    this.scene.start("World");
  }
}
