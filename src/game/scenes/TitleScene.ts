import * as Phaser from "phaser";
import { onVirtualKey } from "../input/virtualInput";

/**
 * One-shot splash between asset preload and gameplay. Gives the player a
 * frame to read the title and confirm they're ready before the world
 * starts ticking; also a future home for a settings/credits/save-slot UI.
 *
 * Once dismissed (click, tap, any key, or any on-screen touch button),
 * launches the always-on `Systems` scene and starts `World`, then exits.
 * World ↔ Interior swaps don't return here.
 */
export class TitleScene extends Phaser.Scene {
  constructor() {
    super("Title");
  }

  create() {
    const cam = this.cameras.main;
    const cx = cam.width / 2;
    const cy = cam.height / 2;

    this.add
      .text(cx, cy - 24, "SAILING RPG", {
        fontFamily: "monospace",
        fontSize: "32px",
        color: "#ffffff",
        stroke: "#0a1a2f",
        strokeThickness: 4,
      })
      .setOrigin(0.5);

    const prompt = this.add
      .text(cx, cy + 24, "Click or press any key to begin", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#cfe2ff",
      })
      .setOrigin(0.5);

    this.tweens.add({
      targets: prompt,
      alpha: { from: 1, to: 0.4 },
      duration: 900,
      yoyo: true,
      repeat: -1,
    });

    let started = false;
    let offVirtualKey: (() => void) | undefined;
    const start = () => {
      if (started) return;
      started = true;
      offVirtualKey?.();
      this.scene.launch("Systems");
      this.scene.start("World");
    };

    this.input.once("pointerdown", start);
    this.input.keyboard?.once("keydown", start);
    offVirtualKey = onVirtualKey((_key, pressed) => {
      if (pressed) start();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      offVirtualKey?.();
    });
  }
}
