// Skin recolor for the player sheets. The Hana Caraka stripped sheets only
// use three opaque colors per frame: a body fill (`#ebf0ee`), a body shadow
// (`#d4d0cd`), and a dark outline (`#2f3b3d`). Recoloring "skin" therefore
// means swapping the body fill + shadow; the outline stays.
//
// Mid-game baking: at boot we replace each player spritesheet's source with
// a canvas painted from the original PNG. Subsequent bakes redraw that same
// canvas (from the cached original) and call `texture.refresh()`, which
// keeps Phaser Frame references valid — animations and live sprites pick
// up the new pixels on the next render without any reset.

import * as Phaser from "phaser";
import {
  PLAYER_ANIM_SHEETS,
  PLAYER_ANIM_STATES,
  playerTextureKey,
} from "./playerAnims";

export type RGB = [number, number, number];

export interface SkinPalette {
  /** Replaces the body fill color (`#ebf0ee` in the source). */
  base: RGB;
  /** Replaces the body shadow color (`#d4d0cd` in the source). */
  shadow: RGB;
}

const SKIN_BASE_SRC: RGB = [235, 240, 238];
const SKIN_SHADOW_SRC: RGB = [212, 208, 205];

export const SKIN_PALETTES = {
  default: { base: SKIN_BASE_SRC,   shadow: SKIN_SHADOW_SRC } satisfies SkinPalette,
  fair:    { base: [248, 222, 196], shadow: [220, 188, 158] } satisfies SkinPalette,
  tan:     { base: [220, 178, 138], shadow: [184, 142, 102] } satisfies SkinPalette,
  brown:   { base: [160, 110, 78],  shadow: [120, 78, 52]   } satisfies SkinPalette,
  dark:    { base: [98, 64, 46],    shadow: [62, 38, 26]    } satisfies SkinPalette,
} as const;

export type SkinPaletteId = keyof typeof SKIN_PALETTES;

export const SKIN_PALETTE_IDS = Object.keys(SKIN_PALETTES) as SkinPaletteId[];

/** In-place recolor of an RGBA pixel buffer (e.g. from `getImageData().data`). */
export function recolorPixels(px: Uint8ClampedArray, palette: SkinPalette): void {
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (r === SKIN_BASE_SRC[0] && g === SKIN_BASE_SRC[1] && b === SKIN_BASE_SRC[2]) {
      px[i] = palette.base[0]; px[i + 1] = palette.base[1]; px[i + 2] = palette.base[2];
    } else if (r === SKIN_SHADOW_SRC[0] && g === SKIN_SHADOW_SRC[1] && b === SKIN_SHADOW_SRC[2]) {
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
 * Replace each player spritesheet's source image with a canvas (painted from
 * the original loaded PNG). After this runs, `bakePlayerSkin` can mutate the
 * canvas and call `texture.refresh()` to update sprites in place — no Frame
 * invalidation, no animation restarts.
 *
 * Idempotent — safe to call multiple times.
 */
export function installPlayerSkinCanvases(textures: Phaser.Textures.TextureManager): void {
  for (const state of PLAYER_ANIM_STATES) {
    const key = playerTextureKey(state);
    if (backings.has(key)) continue;
    const cfg = PLAYER_ANIM_SHEETS[state];
    const tex = textures.get(key);
    const original = tex.getSourceImage(0) as HTMLImageElement | HTMLCanvasElement;
    const w = original.width;
    const h = original.height;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(original as CanvasImageSource, 0, 0);
    // Replace the spritesheet at the same key, now backed by our canvas.
    // Animations have not been created yet at install time, so it's safe to
    // remove + re-add. Subsequent bakes mutate the canvas in place.
    textures.remove(key);
    textures.addSpriteSheet(key, canvas as unknown as HTMLImageElement, {
      frameWidth: cfg.frameSize,
      frameHeight: cfg.frameSize,
    });
    backings.set(key, { original, canvas, ctx });
  }
}

/** Repaint each player texture's canvas with the chosen palette. */
export function bakePlayerSkin(
  textures: Phaser.Textures.TextureManager,
  palette: SkinPalette,
): void {
  for (const state of PLAYER_ANIM_STATES) {
    const key = playerTextureKey(state);
    const backing = backings.get(key);
    if (!backing) continue;
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
    // Re-upload the canvas pixels to the GPU so live sprites pick up the change.
    textures.get(key).source[0].update();
  }
}
