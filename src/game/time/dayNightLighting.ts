import * as Phaser from "phaser";
import { useTimeStore } from "./timeStore";
import { hourDurationMs, type Phase } from "./constants";

// Sky tint keyframes spanning the full day/night cycle. Position is on a
// 0..12 scale: 0..6 covers the day phase by hour-fraction, 6..12 covers the
// night phase. The overlay is drawn with MULTIPLY blend, so warm colors
// (orange/red) darken the world's blue channel and read as golden-hour /
// sunset, while cool colors (blue/purple) read as twilight / pre-dawn.
// Alpha controls overall strength; alpha 0 means the overlay is invisible.
interface SkyKeyframe {
  pos: number;
  color: number;
  alpha: number;
}
const SKY_KEYFRAMES: ReadonlyArray<SkyKeyframe> = [
  { pos: 0.0,   color: 0xffb088, alpha: 0.55 }, // sunrise peak (start of day)
  { pos: 0.5,   color: 0xfff2c8, alpha: 0.22 }, // early morning warm yellow
  { pos: 1.0,   color: 0xeaf2ff, alpha: 0.06 }, // morning, faint cool wash
  { pos: 2.0,   color: 0xffffff, alpha: 0.00 }, // full day plateau begins
  { pos: 3.5,   color: 0xffffff, alpha: 0.00 }, // full day plateau ends
  { pos: 4.5,   color: 0xfff0d4, alpha: 0.12 }, // golden hour begins
  { pos: 5.0,   color: 0xffc890, alpha: 0.28 }, // late afternoon gold
  { pos: 5.5,   color: 0xff7a48, alpha: 0.55 }, // sunset orange
  { pos: 5.85,  color: 0xa84a78, alpha: 0.78 }, // dusk red-magenta
  { pos: 6.0,   color: 0x6a4a90, alpha: 0.92 }, // twilight (= night start)
  { pos: 6.5,   color: 0x4a64a4, alpha: 1.00 }, // night plateau begins
  { pos: 10.5,  color: 0x4a64a4, alpha: 1.00 }, // night plateau ends
  { pos: 11.15, color: 0x5a4880, alpha: 0.95 }, // pre-dawn purple bleed
  { pos: 11.5,  color: 0xc06090, alpha: 0.70 }, // dawn pink/magenta
  { pos: 11.85, color: 0xff9070, alpha: 0.55 }, // first light, warming
  { pos: 12.0,  color: 0xffb088, alpha: 0.55 }, // wraps to start of day
];
// Above OVERHEAD_DEPTH_BASE (1_000_000) in chunkManager so roofs/canopies
// get darkened too. Speech bubbles / floating text sit lower and will be
// tinted by night — fine, they're high-contrast on their own.
const LIGHTING_DEPTH = 2_000_000;
const BRUSH_KEY = "__lighting_soft_circle";
const BRUSH_RADIUS = 128;
// Fractional slack on each axis around the camera viewport. Hides one-frame
// zoom-transition gaps where the world has zoomed out further than the RT.
const EDGE_PAD = 0.1;
// Subtle candle-flicker. Two desynced sines per light produce a low-amplitude
// wobble on the carve alpha and radius. Amplitudes intentionally tiny — the
// goal is "is it flickering?" ambiguity, not a strobing torch.
const FLICKER_INTENSITY_AMP = 0.03;
const FLICKER_RADIUS_AMP = 0.015;
const FLICKER_HZ_A = 3.7;
const FLICKER_HZ_B = 6.1;

function hashPhase(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 0xffffffff) * Math.PI * 2;
}

export interface LightSource {
  id: string;
  /** World-space position. Polled each frame so torches can follow entities. */
  position: () => { x: number; y: number };
  /** World-space radius in pixels at full intensity. */
  radius: number;
  /** 0–1; how strongly this light cuts through the darkness. Default 1. */
  intensity?: number;
  /** Warm/cool tint laid over the lit area on top of the carve. Defaults to
   *  a warm fire-orange so torches read as flame, not daylight. */
  color?: number;
  /** 0–1 strength of the color tint. Default 0.35. */
  tintStrength?: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(lerp(ar, br, t)) & 0xff;
  const g = Math.round(lerp(ag, bg, t)) & 0xff;
  const bl = Math.round(lerp(ab, bb, t)) & 0xff;
  return (r << 16) | (g << 8) | bl;
}

function sampleSky(phase: Phase, elapsedInPhaseMs: number): { color: number; alpha: number } {
  const hourFrac = elapsedInPhaseMs / hourDurationMs(phase);
  const pos = phase === "day" ? hourFrac : 6 + hourFrac;
  // Linear scan — the keyframe table is small and sorted.
  for (let i = 0; i < SKY_KEYFRAMES.length - 1; i++) {
    const a = SKY_KEYFRAMES[i];
    const b = SKY_KEYFRAMES[i + 1];
    if (pos >= a.pos && pos <= b.pos) {
      const t = b.pos === a.pos ? 0 : (pos - a.pos) / (b.pos - a.pos);
      return { color: lerpColor(a.color, b.color, t), alpha: lerp(a.alpha, b.alpha, t) };
    }
  }
  // pos out of range (shouldn't happen for valid phase/elapsed) — clamp.
  const last = SKY_KEYFRAMES[SKY_KEYFRAMES.length - 1];
  return { color: last.color, alpha: last.alpha };
}

function ensureBrushTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(BRUSH_KEY)) return;
  const size = BRUSH_RADIUS * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const grad = ctx.createRadialGradient(
    BRUSH_RADIUS, BRUSH_RADIUS, 0,
    BRUSH_RADIUS, BRUSH_RADIUS, BRUSH_RADIUS,
  );
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.75)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  scene.textures.addCanvas(BRUSH_KEY, canvas);
}

/**
 * Day/night darkness overlay with carve-out point lights.
 *
 * Renders a screen-space RenderTexture above the world: filled with a dark
 * blue at an alpha that ramps with the time-of-day, then ERASE-stamps a soft
 * radial gradient at each registered light's screen position so the lit area
 * shows the world beneath at full brightness.
 */
export class DayNightLighting {
  private rt: Phaser.GameObjects.RenderTexture | null = null;
  private camera: Phaser.Cameras.Scene2D.Camera | null = null;
  private readonly lights = new Map<string, LightSource>();

  attach(scene: Phaser.Scene, camera: Phaser.Cameras.Scene2D.Camera): void {
    ensureBrushTexture(scene);
    this.camera = camera;
    // RT lives in WORLD space (default scrollFactor 1). Each frame we re-anchor
    // it to the camera's worldView and counter-scale by 1/zoom so its on-screen
    // footprint always equals the viewport, while the texture itself is sized
    // in screen pixels (so stamps in screen-pixel offsets map 1:1 onto pixels).
    this.rt = scene.add
      .renderTexture(0, 0, camera.width, camera.height)
      .setOrigin(0, 0)
      .setDepth(LIGHTING_DEPTH)
      // Multiply blend so the overlay tints the world (world * tint) rather
      // than painting over it. ERASE-cleared pixels (torch holes) compose
      // as identity (world * 1), so they stay fully bright.
      .setBlendMode(Phaser.BlendModes.MULTIPLY);

    const onUpdate = () => this.update();
    const onResize = () => this.handleResize();
    scene.events.on(Phaser.Scenes.Events.POST_UPDATE, onUpdate);
    scene.scale.on("resize", onResize);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      scene.events.off(Phaser.Scenes.Events.POST_UPDATE, onUpdate);
      scene.scale.off("resize", onResize);
      this.rt?.destroy();
      this.rt = null;
      this.camera = null;
      this.lights.clear();
    });
  }

  addLight(light: LightSource): void {
    this.lights.set(light.id, light);
  }

  removeLight(id: string): void {
    this.lights.delete(id);
  }

  private handleResize(): void {
    if (!this.rt || !this.camera) return;
    this.rt.resize(this.camera.width, this.camera.height);
  }

  private update(): void {
    if (!this.rt || !this.camera) return;
    const { phase, elapsedInPhaseMs } = useTimeStore.getState();
    const { color: skyColor, alpha } = sampleSky(phase, elapsedInPhaseMs);

    if (alpha <= 0.001 && this.lights.size === 0) {
      this.rt.setVisible(false);
      return;
    }
    this.rt.setVisible(true);
    const cam = this.camera;
    // Anchor the RT to the camera's world view top-left, counter-scale by
    // 1/zoom so it covers the viewport in world units, plus a small slack on
    // every edge. The slack hides one-frame lag during zoom transitions
    // (when next-frame zoom shrinks worldView before we re-render the RT,
    // the slack still covers the new edges). Overflow is clipped invisibly.
    const padW = (cam.width * EDGE_PAD) / cam.zoom;
    const padH = (cam.height * EDGE_PAD) / cam.zoom;
    this.rt.x = cam.worldView.x - padW * 0.5;
    this.rt.y = cam.worldView.y - padH * 0.5;
    this.rt.setScale((1 + EDGE_PAD) / cam.zoom);

    this.rt.clear();
    if (alpha > 0.001) this.rt.fill(skyColor, alpha);

    // World→RT-pixel: one RT pixel covers (1+EDGE_PAD)/zoom world units.
    // Take the offset from the (padded) RT origin and divide by that ratio.
    const worldPerRtPixel = (1 + EDGE_PAD) / cam.zoom;
    const t = (this.rt.scene.time.now ?? 0) / 1000;
    for (const light of this.lights.values()) {
      const pos = light.position();
      const sx = (pos.x - this.rt.x) / worldPerRtPixel;
      const sy = (pos.y - this.rt.y) / worldPerRtPixel;
      const phase = hashPhase(light.id);
      const flick =
        (Math.sin(t * FLICKER_HZ_A * Math.PI * 2 + phase) +
          Math.sin(t * FLICKER_HZ_B * Math.PI * 2 + phase * 1.7)) *
        0.5;
      const intensityMul = 1 + flick * FLICKER_INTENSITY_AMP;
      const radiusMul = 1 + flick * FLICKER_RADIUS_AMP;
      const scale = (light.radius * radiusMul) / worldPerRtPixel / BRUSH_RADIUS;
      // Pass 1: punch a soft hole through the darkness.
      this.rt.stamp(BRUSH_KEY, undefined, sx, sy, {
        scale,
        alpha: (light.intensity ?? 1) * intensityMul,
        blendMode: Phaser.BlendModes.ERASE,
      });
      // Pass 2: lay down a warm tint in the carved area so the lit world
      // reads as firelight instead of unmodified daylight. The brush is
      // white; tint colorises it. Slightly smaller scale concentrates the
      // glow toward the flame's center.
      this.rt.stamp(BRUSH_KEY, undefined, sx, sy, {
        scale: scale * 0.85,
        alpha: (light.tintStrength ?? 0.35) * intensityMul,
        tint: light.color ?? 0xff8a3a,
      });
    }
    // Phaser 4 batches RenderTexture draw ops; without render() the fill
    // and stamps stay queued and nothing shows up.
    this.rt.render();
  }
}
