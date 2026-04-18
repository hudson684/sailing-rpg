import type { CfLayer } from "./playerAnims";

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
  hair: ["1-brown", "1-blonde"],
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
