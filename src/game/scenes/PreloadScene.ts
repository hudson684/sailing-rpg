import * as Phaser from "phaser";
import { queueAllAssets, runPostLoadSetup } from "../assets/manifest";
import { IDBSaveStore, pickLatestEnvelope } from "../save";

/** Registry key for the envelope prefetched by PreloadScene and consumed
 *  by WorldScene's save init. See `PreloadScene` / `WorldScene.initSave`. */
export const PREFETCHED_SAVE_REGISTRY_KEY = "prefetchedSave";

/** Safety net: if the IDB read deadlocks (e.g. a devtools-issued
 *  `indexedDB.deleteDatabase` blocked by a still-open connection), give up
 *  and continue with no save rather than wedging the loading screen. */
const SAVE_PREFETCH_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Loads every asset the game needs to start: world manifest + chunk TMJs +
 * starting-chunk tilesets, player default outfit + tool sheets, item icons,
 * enemy/node/NPC sprite sheets. Renders a Phaser-native progress bar via
 * `this.load` events while loading. In parallel, prefetches the latest save
 * envelope from IDB so the world can hydrate synchronously when the player
 * dismisses the title (no mid-gameplay "default world then rebuild" hitch).
 * After both complete, runs all post-load texture baking + animation
 * registration, then transitions to `Title`.
 *
 * Asset paths and per-category load logic live in `assets/manifest.ts`;
 * this scene is just the lifecycle host.
 */
export class PreloadScene extends Phaser.Scene {
  private savePrefetch: Promise<void> | null = null;
  private setStatus: ((text: string) => void) | null = null;

  constructor() {
    super("Preload");
  }

  preload() {
    this.drawProgressBar();
    queueAllAssets(this);
    this.savePrefetch = this.prefetchSave();
  }

  create() {
    runPostLoadSetup(this);
    this.setStatus?.("Loading save…");
    void (this.savePrefetch ?? Promise.resolve()).then(() => {
      this.scene.start("Title");
    });
  }

  private async prefetchSave(): Promise<void> {
    try {
      const env = await withTimeout(
        pickLatestEnvelope(new IDBSaveStore()),
        SAVE_PREFETCH_TIMEOUT_MS,
        "save prefetch timed out",
      );
      this.game.registry.set(PREFETCHED_SAVE_REGISTRY_KEY, env);
    } catch (err) {
      // Same fallback as a cold start: no save, fresh world.
      console.warn("[preload] save prefetch failed, continuing without:", err);
      this.game.registry.set(PREFETCHED_SAVE_REGISTRY_KEY, null);
    }
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

    this.setStatus = (text: string) => fileText.setText(text);

    this.load.on("progress", (value: number) => {
      fill.clear();
      fill.fillStyle(0x9ec5ff, 1);
      fill.fillRect(barX, barY, Math.floor(barW * value), barH);
    });

    this.load.on("fileprogress", (file: Phaser.Loader.File) => {
      fileText.setText(file.key);
    });

    this.load.once("complete", () => {
      // Top off the bar so a slow save prefetch doesn't look stuck at <100%.
      fill.clear();
      fill.fillStyle(0x9ec5ff, 1);
      fill.fillRect(barX, barY, barW, barH);
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      frame.destroy();
      fill.destroy();
      titleText.destroy();
      fileText.destroy();
      this.setStatus = null;
    });
  }
}
