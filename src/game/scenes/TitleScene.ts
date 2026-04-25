import * as Phaser from "phaser";
import { onVirtualKey } from "../input/virtualInput";
import { useUIStore } from "../../ui/store/uiStore";
import { bootSaveController } from "../save/bootSave";

/**
 * One-shot splash between asset preload and gameplay. While the title is
 * showing, the game-scoped SaveController is booted (store-only hydration
 * from the prefetched envelope), then the World and Systems scenes are
 * launched paused + invisible so their heavy `create()` (chunks, ships,
 * NPCs, enemies, decorations, crafting stations, quests) finishes behind
 * the title. The dismiss prompt stays disabled behind a "Loading…" label
 * until both steps complete, so the instant the player presses a key we
 * just resume the already-built world — no post-click stall.
 *
 * Once dismissed (click, tap, any key, or any on-screen touch button),
 * resumes + reveals World and Systems, then stops. World ↔ Interior swaps
 * don't return here.
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
      .text(cx, cy + 24, "Loading…", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#7fa8d6",
      })
      .setOrigin(0.5);

    const pulse = this.tweens.add({
      targets: prompt,
      alpha: { from: 1, to: 0.4 },
      duration: 900,
      yoyo: true,
      repeat: -1,
    });

    let ready = false;
    let started = false;
    let cancelled = false;
    let offVirtualKey: (() => void) | undefined;

    const onDomGesture = () => {
      if (ready) start();
    };
    const start = () => {
      if (started) return;
      started = true;
      offVirtualKey?.();
      window.removeEventListener("pointerdown", onDomGesture, true);
      window.removeEventListener("keydown", onDomGesture, true);
      useUIStore.getState().setTitleDismissed(true);
      // World + Systems were launched paused/invisible during boot. Reveal
      // and resume them, then stop ourselves. The player is already built
      // at their saved location in their saved outfit, so the very first
      // visible frame of World is playable.
      this.scene.setVisible(true, "World");
      this.scene.resume("World");
      this.scene.resume("Systems");
      this.scene.stop();
    };

    // Listen at the window level (capture phase) rather than on the Phaser
    // scene input: clicks that land on React HUD overlays (e.g. the hotbar)
    // never reach the canvas, so a scene-level `pointerdown` listener alone
    // leaves the player stuck on the title with no way to dismiss it.
    window.addEventListener("pointerdown", onDomGesture, true);
    window.addEventListener("keydown", onDomGesture, true);
    offVirtualKey = onVirtualKey((_key, pressed) => {
      if (pressed && ready) start();
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      cancelled = true;
      offVirtualKey?.();
      window.removeEventListener("pointerdown", onDomGesture, true);
      window.removeEventListener("keydown", onDomGesture, true);
      pulse.remove();
    });

    void bootSaveController(this.game).then(() => {
      if (cancelled) return;
      this.bootWorldBehindTitle(() => {
        if (cancelled) return;
        ready = true;
        prompt.setText("Click or press any key to begin");
        prompt.setColor("#cfe2ff");
      });
    });
  }

  /** Launch World + Systems paused + hidden so their create() runs behind
   *  the title. `onReady` fires after World's CREATE event — i.e. the whole
   *  scene graph is built and the next time the scene ticks it's already
   *  playable. */
  private bootWorldBehindTitle(onReady: () => void): void {
    const world = this.scene.get("World");
    // Subscribe *before* launch — World's CREATE event fires synchronously
    // at the end of its create() and a late listener would miss it.
    world.events.once(Phaser.Scenes.Events.CREATE, () => {
      // Hide and pause so the built world doesn't render over the title
      // and doesn't tick input/physics until the user dismisses.
      this.scene.setVisible(false, "World");
      this.scene.pause("World");
      this.scene.pause("Systems");
      onReady();
    });
    this.scene.launch("Systems");
    this.scene.launch("World");
  }
}
