import * as Phaser from "phaser";
import { queueAllAssets, runPostLoadSetup } from "../assets/manifest";

/**
 * Loads every asset the game needs to start: world manifest + chunk TMJs +
 * starting-chunk tilesets, player default outfit + tool sheets, item icons,
 * enemy/node/NPC sprite sheets. Renders a Phaser-native progress bar via
 * `this.load` events while loading. After `complete`, runs all post-load
 * texture baking + animation registration, then transitions to `Title`.
 *
 * Asset paths and per-category load logic live in `assets/manifest.ts`;
 * this scene is just the lifecycle host.
 */
export class PreloadScene extends Phaser.Scene {
  constructor() {
    super("Preload");
  }

  preload() {
    this.drawProgressBar();
    queueAllAssets(this);
  }

  create() {
    runPostLoadSetup(this);
    this.scene.start("Title");
  }

  private drawProgressBar(): void {
    const cam = this.cameras.main;
    const cx = cam.width / 2;
    const cy = cam.height / 2;
    const barW = Math.min(360, Math.floor(cam.width * 0.6));
    const barH = 16;
    const barX = cx - barW / 2;
    const barY = cy - barH / 2;

    const frame = this.add.graphics();
    frame.lineStyle(2, 0x9ec5ff, 1);
    frame.strokeRect(barX - 2, barY - 2, barW + 4, barH + 4);

    const fill = this.add.graphics();

    const titleText = this.add
      .text(cx, barY - 28, "Loading…", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#cfe2ff",
      })
      .setOrigin(0.5, 1);

    const fileText = this.add
      .text(cx, barY + barH + 12, "", {
        fontFamily: "monospace",
        fontSize: "11px",
        color: "#7fa8d6",
      })
      .setOrigin(0.5, 0);

    this.load.on("progress", (value: number) => {
      fill.clear();
      fill.fillStyle(0x9ec5ff, 1);
      fill.fillRect(barX, barY, Math.floor(barW * value), barH);
    });

    this.load.on("fileprogress", (file: Phaser.Loader.File) => {
      fileText.setText(file.key);
    });

    this.load.once("complete", () => {
      frame.destroy();
      fill.destroy();
      titleText.destroy();
      fileText.destroy();
    });
  }
}
