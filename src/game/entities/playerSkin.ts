// Skin recolor for the Cute_Fantasy base sheet. The body fill (`#f6ca9f`)
// and shadow (`#d29f70`) are swapped for the chosen palette; the dark
// outline stays.
//
// Mid-game baking: at boot we replace the cf-base spritesheet's source with
// a canvas painted from the original PNG. Subsequent bakes redraw that same
// canvas (from the cached original) and call `texture.refresh()`, which
// keeps Phaser Frame references valid — animations and live sprites pick
// up the new pixels on the next render without any reset.

import type * as Phaser from "phaser";
import { CF_FRAME_SIZE, cfTextureKey } from "./playerAnims";

export type RGB = [number, number, number];

export interface SkinPalette {
  /** Replaces the body fill color in the source. */
  base: RGB;
  /** Replaces the body shadow color in the source. */
  shadow: RGB;
}

// Cute_Fantasy base sheet uses a warm peach-tone skin out of the box.
// Sampled directly from `public/sprites/character/cf/base.png` head pixels.
const CF_SKIN_BASE_SRC: RGB = [246, 202, 159];
const CF_SKIN_SHADOW_SRC: RGB = [210, 159, 112];

export const SKIN_PALETTES = {
  default: { base: CF_SKIN_BASE_SRC, shadow: CF_SKIN_SHADOW_SRC } satisfies SkinPalette,
  fair:    { base: [248, 222, 196], shadow: [220, 188, 158] } satisfies SkinPalette,
  tan:     { base: [220, 178, 138], shadow: [184, 142, 102] } satisfies SkinPalette,
  brown:   { base: [160, 110, 78],  shadow: [120, 78, 52]   } satisfies SkinPalette,
  dark:    { base: [98, 64, 46],    shadow: [62, 38, 26]    } satisfies SkinPalette,
} as const;

export type SkinPaletteId = keyof typeof SKIN_PALETTES;

export const SKIN_PALETTE_IDS = Object.keys(SKIN_PALETTES) as SkinPaletteId[];

/** In-place recolor of an RGBA pixel buffer. */
export function recolorPixels(px: Uint8ClampedArray, palette: SkinPalette): void {
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (r === CF_SKIN_BASE_SRC[0] && g === CF_SKIN_BASE_SRC[1] && b === CF_SKIN_BASE_SRC[2]) {
      px[i] = palette.base[0]; px[i + 1] = palette.base[1]; px[i + 2] = palette.base[2];
    } else if (r === CF_SKIN_SHADOW_SRC[0] && g === CF_SKIN_SHADOW_SRC[1] && b === CF_SKIN_SHADOW_SRC[2]) {
      px[i] = palette.shadow[0]; px[i + 1] = palette.shadow[1]; px[i + 2] = palette.shadow[2];
    }
  }
}

interface CanvasBacking {
  original: HTMLImageElement | HTMLCanvasElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

const backings = new Map<string, CanvasBacking>();

/**
 * Replace the cf-base spritesheet's source image with a canvas (painted from
 * the original loaded PNG). After this runs, `bakePlayerSkin` can mutate the
 * canvas and call `texture.refresh()` to update sprites in place — no Frame
 * invalidation, no animation restarts. Idempotent.
 */
export function installPlayerSkinCanvases(textures: Phaser.Textures.TextureManager): void {
  const key = cfTextureKey("base", "default");
  if (backings.has(key)) return;
  const tex = textures.get(key);
  const original = tex.source[0].image as HTMLImageElement | HTMLCanvasElement;
  const w = original.width;
  const h = original.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(original as CanvasImageSource, 0, 0);
  textures.remove(key);
  textures.addSpriteSheet(key, canvas as unknown as HTMLImageElement, {
    frameWidth: CF_FRAME_SIZE,
    frameHeight: CF_FRAME_SIZE,
  });
  backings.set(key, { original, canvas, ctx });
}

/** Repaint the cf-base canvas with the chosen palette. */
export function bakePlayerSkin(
  textures: Phaser.Textures.TextureManager,
  palette: SkinPalette,
): void {
  const key = cfTextureKey("base", "default");
  const backing = backings.get(key);
  if (!backing) return;
  const { original, canvas, ctx } = backing;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(original as CanvasImageSource, 0, 0);
  if (palette !== SKIN_PALETTES.default) {
    const img = ctx.getImageData(0, 0, w, h);
    recolorPixels(img.data, palette);
    ctx.putImageData(img, 0, 0);
  }
  const tex = textures.get(key);
  tex.source[0].update();
}
