import type { CfDir, CfState } from "./playerAnims";
import { CF_FRAME_SIZE } from "./playerAnims";
// Tool sheets are imported via Vite so the bundler content-hashes them
// (`iron-sword.<hash>.png`) and they can be served with immutable cache
// headers. JSON-driven sprite paths still live under `public/`.
import ironSwordSheet from "../../assets/sprites/character/cf/tools/iron-sword.png";
import ironToolsSheet from "../../assets/sprites/character/cf/tools/iron-tools.png";
import woodenFishingRodSheet from "../../assets/sprites/character/cf/tools/wooden-fishing-rod.png";

/**
 * Cute_Fantasy tool overlays.
 *
 * Tool sheets do NOT share the 9×56 base grid — each ships its own smaller
 * sheet sized to that tool's animation. We load each sheet once as a texture
 * (`textureKey`) and define one or more `CfToolDef`s that pick out a row
 * range from it. Multiple tools can share a sheet (pickaxe and axe both live
 * on `iron-tools.png`).
 *
 * The tool sprite lives on the player's `tool` layer and is hidden during
 * idle/walk; it's shown + played only while the matching action state is
 * animating, and hidden again when the action completes.
 *
 * Row mappings within each sheet are best-effort guesses (sheets ship without
 * a key). If a tool plays the wrong pose in-game, swap the rows here.
 */

export interface CfToolDef {
  /** Stable id for this tool variant — used as the anim key prefix. */
  id: string;
  /** Texture key — multiple tools can share one (sub-rows of one sheet). */
  textureKey: string;
  /** Action state this tool's anim accompanies. */
  actionState: CfState;
  /** Frames per direction row. */
  cols: number;
  /** Row index within this sheet for each direction. */
  rows: Record<CfDir, number>;
  /** FPS — should match the matching CF_ANIMS state so base + tool stay aligned. */
  fps: number;
}

export interface CfToolSheet {
  textureKey: string;
  file: string;
  frameWidth: number;
  frameHeight: number;
}

export const CF_TOOL_SHEETS: Record<string, CfToolSheet> = {
  ironSword: {
    textureKey: "cf-tool-iron-sword",
    file: ironSwordSheet,
    frameWidth: CF_FRAME_SIZE,
    frameHeight: CF_FRAME_SIZE,
  },
  // 384×768 → 6 cols × 12 rows. Holds pickaxe + axe + (likely) hoe + watering can.
  ironTools: {
    textureKey: "cf-tool-iron-tools",
    file: ironToolsSheet,
    frameWidth: CF_FRAME_SIZE,
    frameHeight: CF_FRAME_SIZE,
  },
  woodenFishingRod: {
    textureKey: "cf-tool-wooden-fishing-rod",
    file: woodenFishingRodSheet,
    frameWidth: CF_FRAME_SIZE,
    frameHeight: CF_FRAME_SIZE,
  },
};

export const CF_TOOLS: Record<string, CfToolDef> = {
  // 256×576 → 4 cols × 9 rows. Sheet mirrors the base's 3-variants-per-facing
  // layout: rows 0-2 forward (slash-RH, slash-LH, thrust-RH), 3-5 right, 6-8
  // back. We want slash-right-hand, matching CF_ANIMS.attack (base rows 6/9/12).
  "iron-sword": {
    id: "iron-sword",
    textureKey: CF_TOOL_SHEETS.ironSword.textureKey,
    actionState: "attack",
    cols: 4,
    rows: { forward: 0, right: 3, back: 6 },
    fps: 14,
  },
  // Iron_Tools: 12 rows × 6 cols. Verified in-game: axe lives in rows 0-2,
  // pickaxe in rows 3-5. (Hoe / watering can presumably fill 6-11.)
  "iron-axe": {
    id: "iron-axe",
    textureKey: CF_TOOL_SHEETS.ironTools.textureKey,
    actionState: "chop",
    cols: 6,
    rows: { forward: 0, right: 1, back: 2 },
    fps: 12,
  },
  "iron-pickaxe": {
    id: "iron-pickaxe",
    textureKey: CF_TOOL_SHEETS.ironTools.textureKey,
    actionState: "mine",
    cols: 6,
    rows: { forward: 3, right: 4, back: 5 },
    fps: 12,
  },
  // 576×384 → 9 cols × 6 rows. Rows 0-2 = cast (matches CF_ANIMS.fish).
  "wooden-fishing-rod": {
    id: "wooden-fishing-rod",
    textureKey: CF_TOOL_SHEETS.woodenFishingRod.textureKey,
    actionState: "fish",
    cols: 9,
    rows: { forward: 0, right: 1, back: 2 },
    fps: 12,
  },
};

export function cfToolAnimKey(toolId: string, dir: CfDir): string {
  return `cf-tool-${toolId}-${dir}`;
}
