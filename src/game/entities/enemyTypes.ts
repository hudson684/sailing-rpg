import type { ItemId } from "../inventory/items";
import type { NpcLayeredSprite } from "./npcTypes";

export type EnemyAnimState = "idle" | "move" | "attack" | "death" | "hurt";

export interface EnemyAnimSheet {
  /** 0-based row index in the spritesheet. When `col` is omitted, the anim
   *  runs across this row from column 0. When `col` is set, this is the
   *  starting row and the anim runs DOWN that column. */
  row: number;
  /** Optional: 0-based column index. When set, the animation runs vertically
   *  down this column instead of horizontally across `row`. Use for
   *  column-major sheets where columns represent facings (e.g. Hana Caraka
   *  pirate: col 0 = sideways, col 1 = front, col 2 = back). */
  col?: number;
  /** Number of frames. */
  frames: number;
  frameRate: number;
  /** Repeat: -1 = loop, 0 = play once. Defaults loop for idle/move, once otherwise. */
  repeat?: number;
  /** Optional per-anim sheet override. Used when an anim (e.g. an attack with
   *  a long slash arc) ships in frames larger than the base sheet's grid.
   *  When `sheet` is set, all four of `sheet`/`frameWidth`/`frameHeight`/
   *  `sheetCols` must be present and the anim is loaded as its own texture. */
  sheet?: string;
  frameWidth?: number;
  frameHeight?: number;
  sheetCols?: number;
  /** Optional origin override for this anim only. Used when an override
   *  sheet has different whitespace padding and the default `display.originY`
   *  would shift the sprite's feet off the ground. Fraction of frame height. */
  originY?: number;
}

export interface EnemySprite {
  /** Path under public/, e.g. "sprites/enemies/slime-small-green.png". */
  sheet: string;
  frameWidth: number;
  frameHeight: number;
  /** Number of columns in the spritesheet (used to map row→flat frame index). */
  sheetCols: number;
  /** `idle`, `move`, `attack`, `death` are required. `hurt` is optional —
   *  defs without it fall back to the idle anim + red tint when struck. */
  anims: Record<Exclude<EnemyAnimState, "hurt">, EnemyAnimSheet> & {
    hurt?: EnemyAnimSheet;
  };
}

export interface EnemyDisplay {
  scale: number;
  /** Sprite origin Y as a fraction of frame height (1.0 = bottom = feet). */
  originY: number;
}

export type EnemyMovement =
  | { type: "static" }
  | {
      type: "wander";
      /** Tiles from spawn (home) the enemy may roam. */
      radiusTiles: number;
      /** Pixels per second when moving. */
      moveSpeed: number;
      /** Pause between moves, ms. */
      pauseMs: number;
      /** Max ms a single leg may take before bailing. */
      stepMs: number;
    };

export interface EnemyDef {
  id: string;
  name: string;
  /** Legacy single-sheet sprite. Mutually exclusive with `layered`. Required
   *  unless `layered` is set. */
  sprite?: EnemySprite;
  /** Layered slot-based look (stacked per-slot sheets from a character model,
   *  same format as NPC layered characters). Preferred for humanoid enemies
   *  (pirates, bandits, etc.) so helmets / outfits / weapons can be mixed in
   *  without re-baking full character sheets. */
  layered?: NpcLayeredSprite;
  display: EnemyDisplay;
  /** Max HP. Each player hit deals 1. */
  hp: number;
  /** Seconds until the enemy respawns at its spawn tile after dying. */
  respawnSec: number;
  /** Pixel radius — player attack within this distance damages the enemy. */
  hurtRadiusPx: number;
  /** Drop table id (see dropTables.json). */
  dropTable: string;
  /** XP per kill toward this skill. */
  xpSkill: import("../jobs/jobs").JobId;
  xpPerKill: number;
  movement: EnemyMovement;
  /** Combat behavior. Omit for non-aggressive enemies. */
  combat?: EnemyCombat;
}

export interface EnemyCombat {
  /** Pixel radius within which the enemy can land an attack. */
  attackRangePx: number;
  /** Pixel distance from enemy at which idle→chase triggers. */
  aggroRadiusPx: number;
  /** Pixel distance from spawn beyond which chase→returning. Prevents infinite chases. */
  leashRadiusPx: number;
  /** Pixels per second while chasing or returning. */
  chaseSpeedPx: number;
  /** HP regenerated per second while idle (fractional ok). */
  regenPerSec: number;
  /** Min damage rolled per landed hit (inclusive). */
  damageMin: number;
  /** Max damage rolled per landed hit (inclusive). */
  damageMax: number;
  /** Cooldown between attack starts, ms. */
  cooldownMs: number;
}

export interface EnemyInstanceData {
  id: string;
  defId: string;
  tileX: number;
  tileY: number;
}

export interface EnemiesFile {
  defs: EnemyDef[];
  instances: EnemyInstanceData[];
}

export interface DropEntry {
  itemId: ItemId;
  /** Inclusive min/max quantity rolled if this entry hits. */
  min: number;
  max: number;
  /** Independent probability 0..1 that this entry drops. */
  chance: number;
}

export interface DropTable {
  id: string;
  /** Each entry is rolled independently. */
  rolls: DropEntry[];
}

export interface DropTablesFile {
  tables: DropTable[];
}

export function enemyTextureKey(defId: string): string {
  return `enemy-${defId}`;
}

/** Texture key for an anim that has its own sheet override. Each per-anim
 *  override is loaded under this key so Phaser can swap the sprite's
 *  texture when the override anim plays. */
export function enemyAnimTextureKey(defId: string, state: EnemyAnimState): string {
  return `enemy-${defId}-${state}-tex`;
}

export function enemyAnimKey(defId: string, state: EnemyAnimState): string {
  return `enemy-${defId}-${state}`;
}
