import type { ItemId } from "../inventory/items";
import type { JobId } from "../jobs/jobs";

/**
 * Crafting is deliberately skill-agnostic — the same station kinds, recipes
 * loader, minigame scene, and modal serve blacksmithing today and any future
 * crafting skill (cooking, tailoring, carpentry…). A recipe is bound to a
 * `skill` (which job it trains) and a `station` (which station kind runs it).
 */

export type StationKind =
  /** Instant-craft station, no minigame (e.g. smelter, cooking pot, spinning wheel). */
  | "smelter"
  /** Minigame-driven station (e.g. anvil, oven, loom, workbench). */
  | "anvil";

/** Minigame action kinds. Strike = press-timing on a sweeping bar.
 *  Heat = hold SPACE, release when a shrinking ring hits a target band.
 *  Quench = tap SPACE rapidly inside a short window. */
export type MinigameActionKind = "strike" | "heat" | "quench";

export interface MinigameConfig {
  /** Total strikes the player gets. Running out before filling the bar = fail. */
  moveBudget: number;
  /** 0..1 — width of the "hit" window on the timing bar. Smaller = harder. */
  windowSize: number;
  /** Indicator speed, in screen-widths per second. Higher = harder. */
  sweepSpeed: number;
  /** Action sequence. MVP uses "strike" throughout; future stations can mix kinds. */
  actions: MinigameActionKind[];
}

export interface RecipeInput {
  itemId: ItemId;
  qty: number;
}

export interface RecipeOutput {
  itemId: ItemId;
  qty: number;
}

export interface RecipeDef {
  id: string;
  name: string;
  /** Which job this recipe trains — awards XP to this track on craft. */
  skill: JobId;
  /** Which station kind can craft this. Filters recipes shown in the modal. */
  station: StationKind;
  inputs: RecipeInput[];
  output: RecipeOutput;
  /** Player must be at least this level in `skill` to see/craft this recipe. */
  levelReq: number;
  xpReward: number;
  /** Present iff the craft runs the minigame. Omit for instant crafts. */
  minigame?: MinigameConfig;
}

/** Craft outcome tier. "fail" = minigame ran out of moves before completion. */
export type CraftOutcomeTier = "fail" | "normal" | "good" | "great" | "perfect";

export interface CraftingStationDef {
  id: string;
  name: string;
  kind: StationKind;
  skill: JobId;
  /** Theming used by both the React modal header and the Phaser minigame HUD. */
  bgColor: string;
  accentColor: string;
  /** World-object footprint (pixels). */
  width: number;
  height: number;
  /** Label shown above the station in-world. */
  labelColor: string;
  /** If true, the station's footprint blocks player movement. */
  blocks: boolean;
  collisionOffsetX?: number;
  collisionOffsetY?: number;
}

export interface CraftingStationInstanceData {
  id: string;
  defId: string;
  tileX: number;
  tileY: number;
}

export interface CraftingStationsFile {
  defs: CraftingStationDef[];
  instances: CraftingStationInstanceData[];
}

export interface RecipesFile {
  recipes: RecipeDef[];
}
