import type { ItemId } from "../inventory/items";

export type EnemyAnimState = "idle" | "move" | "attack" | "death";

export interface EnemyAnimSheet {
  /** 0-based row index in the spritesheet for this animation. */
  row: number;
  /** Number of frames in the row. */
  frames: number;
  frameRate: number;
  /** Repeat: -1 = loop, 0 = play once. Defaults loop for idle/move, once otherwise. */
  repeat?: number;
}

export interface EnemySprite {
  /** Path under public/, e.g. "sprites/enemies/slime-small-green.png". */
  sheet: string;
  frameWidth: number;
  frameHeight: number;
  /** Number of columns in the spritesheet (used to map row→flat frame index). */
  sheetCols: number;
  anims: Record<EnemyAnimState, EnemyAnimSheet>;
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
  sprite: EnemySprite;
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

export function enemyAnimKey(defId: string, state: EnemyAnimState): string {
  return `enemy-${defId}-${state}`;
}
