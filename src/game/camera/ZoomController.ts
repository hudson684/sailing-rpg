import * as Phaser from "phaser";
import { useSettingsStore, ZOOM_STEPS } from "../store/settingsStore";

const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const ZOOM_SMOOTH_RATE = 12;
const ZOOM_SNAP_EPSILON = 0.001;
const WHEEL_SETTLE_MS = 140;

export interface ZoomControllerOptions {
  /** Called every frame after the camera's zoom is updated (lerping or snap).
   *  Interior scenes use this to re-center their camera bounds since the
   *  visible viewport size changes with zoom. */
  onZoomApplied?: () => void;
}

/** Owns mouse-wheel + keyboard zoom input, syncs the scene's main camera with
 *  the persisted zoom in `settingsStore`, and lerps the camera each frame.
 *
 *  Both WorldScene and InteriorScene used to inline this same ~80 lines of
 *  logic. The duplication caused a subtle bug: each scene held a class-field
 *  `zoomTarget = useSettingsStore.getState().zoom` initialized at scene
 *  construction (game boot). InteriorScene's first launch therefore reset
 *  the camera to the boot-time zoom even if the player had since zoomed in
 *  WorldScene. Constructing this controller in `create()` reads the store
 *  fresh each time the scene starts. */
export class ZoomController {
  private readonly scene: Phaser.Scene;
  private readonly opts: ZoomControllerOptions;
  private zoomTarget: number;
  private wheelZoomDir: 1 | -1 | 0 = 0;
  private lastWheelAt = 0;
  private unsub: (() => void) | null = null;
  private wheelHandler: (p: unknown, o: unknown, dx: number, dy: number) => void;
  private readonly keys: Phaser.Input.Keyboard.Key[] = [];

  constructor(scene: Phaser.Scene, opts: ZoomControllerOptions = {}) {
    this.scene = scene;
    this.opts = opts;
    this.zoomTarget = useSettingsStore.getState().zoom;
    scene.cameras.main.setZoom(this.zoomTarget);

    const kb = scene.input.keyboard!;
    const zoomInPlus = kb.addKey(Phaser.Input.Keyboard.KeyCodes.PLUS);
    const zoomInEq = kb.addKey("=");
    const zoomOut = kb.addKey(Phaser.Input.Keyboard.KeyCodes.MINUS);
    zoomInPlus.on("down", () => this.stepZoomKeyboard(+1));
    zoomInEq.on("down", () => this.stepZoomKeyboard(+1));
    zoomOut.on("down", () => this.stepZoomKeyboard(-1));
    this.keys.push(zoomInPlus, zoomInEq, zoomOut);

    this.wheelHandler = (_p, _o, _dx, dy) => {
      if (dy === 0) return;
      const factor = Math.exp(-dy * WHEEL_ZOOM_SENSITIVITY);
      this.zoomTarget = Phaser.Math.Clamp(this.zoomTarget * factor, MIN_ZOOM, MAX_ZOOM);
      useSettingsStore.getState().setZoom(this.zoomTarget);
      this.wheelZoomDir = dy < 0 ? 1 : -1;
      this.lastWheelAt = scene.time.now;
    };
    scene.input.on("wheel", this.wheelHandler);

    // External writers (pause-menu zoom buttons, the other scene) push through
    // the store; mirror those into our local target. Wheel/keyboard handlers
    // also write to the store but mutate `zoomTarget` first, so the equality
    // check below makes the round-trip a no-op.
    this.unsub = useSettingsStore.subscribe((state, prev) => {
      if (state.zoom === prev.zoom) return;
      if (Math.abs(state.zoom - this.zoomTarget) <= ZOOM_SNAP_EPSILON) return;
      this.zoomTarget = state.zoom;
      this.wheelZoomDir = 0;
    });

    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
  }

  update(dtMs: number): void {
    if (this.wheelZoomDir !== 0 && this.scene.time.now - this.lastWheelAt >= WHEEL_SETTLE_MS) {
      const cur = this.zoomTarget;
      let snapped: number;
      if (this.wheelZoomDir > 0) {
        const next = ZOOM_STEPS.find((s) => s >= cur - ZOOM_SNAP_EPSILON);
        snapped = next ?? MAX_ZOOM;
      } else {
        let prev: number = MIN_ZOOM;
        for (const s of ZOOM_STEPS) {
          if (s <= cur + ZOOM_SNAP_EPSILON) prev = s;
          else break;
        }
        snapped = prev;
      }
      this.zoomTarget = Phaser.Math.Clamp(snapped, MIN_ZOOM, MAX_ZOOM);
      useSettingsStore.getState().setZoom(this.zoomTarget);
      this.wheelZoomDir = 0;
    }
    const cam = this.scene.cameras.main;
    const diff = this.zoomTarget - cam.zoom;
    if (Math.abs(diff) < ZOOM_SNAP_EPSILON) {
      if (cam.zoom !== this.zoomTarget) {
        cam.setZoom(this.zoomTarget);
        this.opts.onZoomApplied?.();
      }
      return;
    }
    const t = 1 - Math.exp(-ZOOM_SMOOTH_RATE * (dtMs / 1000));
    cam.setZoom(cam.zoom + diff * t);
    this.opts.onZoomApplied?.();
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
    this.scene.input.off("wheel", this.wheelHandler);
    for (const key of this.keys) key.removeAllListeners();
    this.keys.length = 0;
  }

  private stepZoomKeyboard(dir: 1 | -1): void {
    const cur = this.zoomTarget;
    let target: number;
    if (dir > 0) {
      const next = ZOOM_STEPS.find((s) => s > cur + ZOOM_SNAP_EPSILON);
      target = next ?? MAX_ZOOM;
    } else {
      let prev: number = MIN_ZOOM;
      for (const s of ZOOM_STEPS) {
        if (s < cur - ZOOM_SNAP_EPSILON) prev = s;
        else break;
      }
      target = prev;
    }
    this.zoomTarget = Phaser.Math.Clamp(target, MIN_ZOOM, MAX_ZOOM);
    useSettingsStore.getState().setZoom(this.zoomTarget);
  }
}
