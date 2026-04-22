import type { CfDir, CfState } from "./playerAnims";
import { CF_FRAME_SIZE } from "./playerAnims";
// Tool sheets are imported via Vite so the bundler content-hashes them
// (`iron-sword.<hash>.png`) and they can be served with immutable cache
// headers. JSON-driven sprite paths still live under `public/`.
import ironSwordSheet from "../../assets/sprites/character/cf/tools/iron-sword.png";
import ironToolsSheet from "../../assets/sprites/character/cf/tools/iron-tools.png";
import woodenFishingRodSheet from "../../assets/sprites/character/cf/tools/wooden-fishing-rod.png";
import woodenBowSheet from "../../assets/sprites/character/cf/tools/wooden-bow.png";

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

export interface CfToolAction {
  /** CF state this overlay plays on. The tool sprite is shown only while the
   *  player's `animState` equals this state. */
  state: CfState;
  /** Frames per direction row. */
  cols: number;
  /** Row index within this sheet for each direction. */
  rows: Record<CfDir, number>;
  /** FPS — should match the matching CF_ANIMS state so base + tool stay aligned. */
  fps: number;
}

export interface CfToolDef {
  /** Stable id for this tool variant — used as the anim key prefix. */
  id: string;
  /** Texture key — multiple tools can share one (sub-rows of one sheet). */
  textureKey: string;
  /** Total frames per row on the sheet. Used as the row stride when turning
   *  (row, col) into Phaser's flat frame index, so an action with fewer
   *  frames than the sheet is wide still lands on the right row. Defaults
   *  to the first action's `cols` (legacy behavior) when omitted. */
  sheetCols?: number;
  /** One or more action states this tool overlay participates in. A single
   *  sheet can cover several states (e.g. the fishing rod has both a cast
   *  animation and a reel-in animation). */
  actions: CfToolAction[];
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
  // 384×192 → 6 cols × 3 rows. Rows 0-2 = draw + release (forward/right/back).
  woodenBow: {
    textureKey: "cf-tool-wooden-bow",
    file: woodenBowSheet,
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
    actions: [
      { state: "attack", cols: 4, rows: { forward: 0, right: 3, back: 6 }, fps: 14 },
    ],
  },
  // Iron_Tools: 12 rows × 6 cols. Verified in-game: axe lives in rows 0-2,
  // pickaxe in rows 3-5. (Hoe / watering can presumably fill 6-11.)
  "iron-axe": {
    id: "iron-axe",
    textureKey: CF_TOOL_SHEETS.ironTools.textureKey,
    actions: [
      { state: "chop", cols: 6, rows: { forward: 0, right: 1, back: 2 }, fps: 12 },
    ],
  },
  "iron-pickaxe": {
    id: "iron-pickaxe",
    textureKey: CF_TOOL_SHEETS.ironTools.textureKey,
    actions: [
      { state: "mine", cols: 6, rows: { forward: 3, right: 4, back: 5 }, fps: 12 },
    ],
  },
  // 576×384 → 9 cols × 6 rows. Rows 0-2 = cast (matches CF_ANIMS.fish),
  // rows 3-5 = reel-in (matches CF_ANIMS["fish-reel"]; 8 cols).
  "wooden-fishing-rod": {
    id: "wooden-fishing-rod",
    textureKey: CF_TOOL_SHEETS.woodenFishingRod.textureKey,
    sheetCols: 9,
    actions: [
      { state: "fish",      cols: 9, rows: { forward: 0, right: 1, back: 2 }, fps: 12 },
      { state: "fish-reel", cols: 8, rows: { forward: 3, right: 4, back: 5 }, fps: 12 },
    ],
  },
  // 384×192 → 6 cols × 3 rows. Rows 0-2 = bow draw + release (matches CF_ANIMS.shoot).
  "wooden-bow": {
    id: "wooden-bow",
    textureKey: CF_TOOL_SHEETS.woodenBow.textureKey,
    actions: [
      { state: "shoot", cols: 6, rows: { forward: 0, right: 1, back: 2 }, fps: 12 },
    ],
  },
};

export function cfToolAnimKey(toolId: string, state: CfState, dir: CfDir): string {
  return `cf-tool-${toolId}-${state}-${dir}`;
}
