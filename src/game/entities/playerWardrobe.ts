import type * as Phaser from "phaser";
import {
  CF_FRAME_SIZE,
  cfTextureKey,
  createCfAnimsForTexture,
  type CfLayer,
} from "./playerAnims";

/**
 * Customizer-facing variant catalog. Lists the variants the user can pick
 * for each baseline (non-equipment) layer. Each variant key MUST match a
 * file at `public/sprites/character/cf/<layer>-<variant>.png` (or
 * `cf/base.png` for the bare base) and MUST be eagerly loaded in BootScene
 * (otherwise the customizer would need to handle a missing texture).
 *
 * Equipment-driven layers (`tool`) are intentionally absent — those are
 * controlled by what the player has equipped, not the customizer.
 */
export const CF_WARDROBE_OPTIONS: Partial<Record<CfLayer, readonly string[]>> = {
  hair: [
    "1-black", "1-blonde", "1-brown", "1-ginger", "1-grey",
    "2-black", "2-blonde", "2-brown", "2-ginger", "2-grey",
    "3-black", "3-blonde", "3-brown", "3-ginger", "3-grey",
    "4-black", "4-blonde", "4-brown", "4-ginger", "4-grey",
    "5-black", "5-blonde", "5-brown", "5-ginger", "5-grey",
    "6-black", "6-blonde", "6-brown", "6-ginger", "6-grey",
  ],
  chest: ["og-blue", "royal-blue", "plate-iron"],
  legs: ["og-brown"],
  feet: ["brown", "black"],
  accessory: ["farmer-hat"],
};

export const CF_WARDROBE_LAYERS: readonly CfLayer[] = [
  "hair",
  "chest",
  "legs",
  "feet",
  "accessory",
];

export type CfWardrobe = Partial<Record<CfLayer, string | null>>;

export const DEFAULT_WARDROBE: CfWardrobe = {
  hair: "1-brown",
  chest: "og-blue",
  legs: "og-brown",
  feet: "brown",
  accessory: null,
};

/**
 * Source path for a CF layer/variant spritesheet. Mirrors the filenames
 * under `public/sprites/character/cf/`. `base` is special-cased as
 * `cf/base.png` (no variant suffix) to match the default skin sheet.
 */
function cfVariantAssetPath(layer: CfLayer, variant: string): string {
  if (layer === "base") return "sprites/character/cf/base.png";
  return `sprites/character/cf/${layer}-${variant}.png`;
}

// In-flight dedupe for lazy wardrobe loads. Keyed by Phaser texture key so
// multiple callers that race on the same variant share one loader request
// and all fire once the texture is ready.
const pendingCfLoads = new Map<string, Array<() => void>>();

/**
 * Idempotently ensure a CF layer variant's spritesheet is loaded into
 * `scene.textures`, registering its full anim set once complete. `onReady`
 * fires synchronously if the texture already exists, otherwise after the
 * loader finishes. Safe to call from `create()` or later; the loader is
 * kicked if it isn't already running.
 */
export function ensureCfVariantLoaded(
  scene: Phaser.Scene,
  layer: CfLayer,
  variant: string,
  onReady: () => void,
): void {
  const key = cfTextureKey(layer, variant);
  if (scene.textures.exists(key)) {
    createCfAnimsForTexture(scene, key);
    onReady();
    return;
  }
  const waiters = pendingCfLoads.get(key);
  if (waiters) {
    waiters.push(onReady);
    return;
  }
  pendingCfLoads.set(key, [onReady]);
  scene.load.spritesheet(key, cfVariantAssetPath(layer, variant), {
    frameWidth: CF_FRAME_SIZE,
    frameHeight: CF_FRAME_SIZE,
  });
  const finish = (ok: boolean) => {
    const list = pendingCfLoads.get(key);
    pendingCfLoads.delete(key);
    if (ok) createCfAnimsForTexture(scene, key);
    if (list) for (const fn of list) { try { fn(); } catch { /* non-fatal */ } }
  };
  scene.load.once(`filecomplete-spritesheet-${key}`, () => finish(true));
  scene.load.once("loaderror", (file: Phaser.Loader.File) => {
    if (file.key === key) finish(false);
  });
  if (!scene.load.isLoading()) scene.load.start();
}
