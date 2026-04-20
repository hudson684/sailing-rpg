import * as Phaser from "phaser";
import { onVirtualKey } from "../input/virtualInput";
import { useUIStore } from "../../ui/store/uiStore";

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
    // In case we're re-entering Title (e.g. HMR in dev), make sure React
    // treats us as "not started yet" so the HUD/touch controls stay hidden.
    useUIStore.getState().setTitleDismissed(false);

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
    const onDomGesture = () => start();
    const start = () => {
      if (started) return;
      started = true;
      offVirtualKey?.();
      window.removeEventListener("pointerdown", onDomGesture, true);
      window.removeEventListener("keydown", onDomGesture, true);
      useUIStore.getState().setTitleDismissed(true);
      this.scene.launch("Systems");
      this.scene.start("World");
    };

    // Listen at the window level (capture phase) rather than on the Phaser
    // scene input: clicks that land on React HUD overlays (e.g. the hotbar)
    // never reach the canvas, so a scene-level `pointerdown` listener alone
    // leaves the player stuck on the title with no way to dismiss it.
    window.addEventListener("pointerdown", onDomGesture, true);
    window.addEventListener("keydown", onDomGesture, true);
    offVirtualKey = onVirtualKey((_key, pressed) => {
      if (pressed) start();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      offVirtualKey?.();
      window.removeEventListener("pointerdown", onDomGesture, true);
      window.removeEventListener("keydown", onDomGesture, true);
    });
  }
}
