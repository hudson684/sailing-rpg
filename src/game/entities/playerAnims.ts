// Cute_Fantasy layered player animation config.
// Single 9-col × 56-row grid of 64×64 frames. Every layer (base, hair,
// chest, …) shares this grid so they can be played in sync as a paper-doll.
// Source rows ship 3 facings only — left is rendered by playing the `right`
// row with each child sprite flipped horizontally (Containers don't have
// setFlipX, so the flip is applied per child).

export const CF_FRAME_SIZE = 64;
export const CF_SHEET_COLS = 9;
export const CF_SHEET_ROWS = 56;

export const CF_DIRS = ["forward", "right", "back"] as const;
export type CfDir = (typeof CF_DIRS)[number];

/** 8-way in-world facing for the player. CF sheets only ship 3 directions —
 *  `facingToCfDir` (in PlayerSprite) maps these down to CfDir + flipX. */
export type Facing =
  | "up"
  | "up-right"
  | "right"
  | "down-right"
  | "down"
  | "down-left"
  | "left"
  | "up-left";

export const FACING_VALUES: readonly Facing[] = [
  "up",
  "up-right",
  "right",
  "down-right",
  "down",
  "down-left",
  "left",
  "up-left",
];

export const CF_STATES = ["idle", "walk", "attack", "mine", "chop", "fish"] as const;
export type CfState = (typeof CF_STATES)[number];

export const CF_LAYERS = [
  "base",
  "feet",
  "legs",
  "chest",
  "hands",
  "hair",
  "accessory",
  "tool",
] as const;
export type CfLayer = (typeof CF_LAYERS)[number];

interface CfFrameRange { row: number; cols: number }
interface CfStateConfig {
  fps: number;
  repeat: number;
  dirs: Record<CfDir, CfFrameRange>;
}

// Row mapping per the README in
// assets-source/character/16x16/Cute_Fantasy/Player/README.md.
export const CF_ANIMS: Record<CfState, CfStateConfig> = {
  idle: {
    fps: 6, repeat: -1,
    dirs: {
      forward: { row: 0, cols: 6 },
      right:   { row: 1, cols: 6 },
      back:    { row: 2, cols: 6 },
    },
  },
  walk: {
    fps: 10, repeat: -1,
    dirs: {
      forward: { row: 3, cols: 6 },
      right:   { row: 4, cols: 6 },
      back:    { row: 5, cols: 6 },
    },
  },
  // Attack: slash, right hand (rows 6/9/12).
  attack: {
    fps: 14, repeat: 0,
    dirs: {
      forward: { row: 6,  cols: 4 },
      right:   { row: 9,  cols: 4 },
      back:    { row: 12, cols: 4 },
    },
  },
  // Mine: pickaxe (rows 35/36/37).
  mine: {
    fps: 12, repeat: 0,
    dirs: {
      forward: { row: 35, cols: 6 },
      right:   { row: 36, cols: 6 },
      back:    { row: 37, cols: 6 },
    },
  },
  // Chop: axe (rows 32/33/34).
  chop: {
    fps: 12, repeat: 0,
    dirs: {
      forward: { row: 32, cols: 6 },
      right:   { row: 33, cols: 6 },
      back:    { row: 34, cols: 6 },
    },
  },
  // Fish: cast fishing rod (rows 44/45/46).
  fish: {
    fps: 12, repeat: 0,
    dirs: {
      forward: { row: 44, cols: 9 },
      right:   { row: 45, cols: 9 },
      back:    { row: 46, cols: 9 },
    },
  },
};

export function cfTextureKey(layer: CfLayer, variant: string = "default"): string {
  return `cf-${layer}-${variant}`;
}

export function cfAnimKey(textureKey: string, state: CfState, dir: CfDir): string {
  return `${textureKey}-${state}-${dir}`;
}
