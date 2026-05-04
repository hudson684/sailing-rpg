import type { Predicate } from "../quests/types";

export interface NpcAnimSheet {
  sheet: string;
  frameWidth: number;
  frameHeight: number;
  start: number;
  end: number;
  frameRate: number;
}

/** A 4-direction anim. `side` is the right-facing source; `setFlipX` is
 *  applied at runtime when the NPC faces left. `up` and `down` get their
 *  own sheets and are never flipped. */
export interface NpcDirectionalAnimSheet {
  down: NpcAnimSheet;
  up: NpcAnimSheet;
  side: NpcAnimSheet;
}

export type NpcAnimSheetEntry = NpcAnimSheet | NpcDirectionalAnimSheet;

export function isDirectionalAnimSheet(
  s: NpcAnimSheetEntry,
): s is NpcDirectionalAnimSheet {
  return (s as NpcDirectionalAnimSheet).down !== undefined;
}

export type NpcFacing = "left" | "right" | "up" | "down";

/** The three render directions an NPC can be in. Left/right both render
 *  the `side` sheet; left flips it. */
export type NpcRenderDir = "up" | "down" | "side";

export function facingToRenderDir(f: NpcFacing): NpcRenderDir {
  if (f === "up") return "up";
  if (f === "down") return "down";
  return "side";
}

export interface NpcSpawnTile {
  tileX: number;
  tileY: number;
}

export type NpcMovement =
  | { type: "static" }
  | {
      type: "wander";
      radiusTiles: number;
      moveSpeed: number;
      pauseMs: number;
      stepMs: number;
    }
  | {
      type: "patrol";
      waypoints: NpcSpawnTile[];
      moveSpeed: number;
      pauseMs: number;
    };

export interface NpcDisplay {
  originY: number;
}

/** Which map this NPC lives on. Omitted/"world" = the outdoor world (spawn
 *  coords are global tiles). `{ interior: <key> }` = inside the named building
 *  (spawn coords are local to that interior tilemap). */
export type NpcMap = "world" | { interior: string };

/** Layered sprite look for an NPC — each slot (body, head, hair, helmet, ...)
 *  is rendered as its own sprite stacked in the model's `slotOrder`. Sheets
 *  live under `public/sprites/characters/<model>/<slot>/<variant>/<tag>.png`
 *  and frame dims / per-tag rates come from the model's `model.json`. */
export interface NpcLayeredSprite {
  model: string;
  slots: Record<string, string>;
}

export interface NpcDef {
  id: string;
  name: string;
  /** Phase 7: optional spawn gate. If present and evaluates false, the
   *  NPC is not added to the entity registry on boot and is despawned
   *  if a later flag change flips it false. */
  when?: Predicate;
  /** Legacy single-sheet look. Mutually exclusive with `layered`.
   *  Each entry can be a single side-view sheet (mirrored for left) or
   *  a directional triple ({down,up,side}) for true 4-way facing. */
  sprite?: { idle: NpcAnimSheetEntry; walk?: NpcAnimSheetEntry };
  /** Layered slot-based look. Preferred for new NPCs. */
  layered?: NpcLayeredSprite;
  /** When set, NpcSprite resolves its texture/anim keys against this id
   *  instead of `def.id`. Used by runtime-spawned NPCs (e.g. hired staff)
   *  that share their look with a pre-loaded NPC and don't have their own
   *  preload entry. */
  spritePackId?: string;
  display: NpcDisplay;
  /** Defaults to "world" when absent, for backward compat with existing data. */
  map?: NpcMap;
  spawn: NpcSpawnTile;
  facing: NpcFacing;
  movement: NpcMovement;
  dialogue: string;
  /** If set, right-clicking this NPC opens the referenced shop. */
  shopId?: string;
  /** When set, the NPC's `shopId` is only available while the agent's
   *  current activity is parked at this tile (in the NPC's home scene).
   *  Used for shopkeepers whose schedule has them away from the counter
   *  for parts of the day. Omit for always-open shops. */
  shopCounter?: { tileX: number; tileY: number };
  /** Per-NPC override of the dialogue interact radius, in tiles. Defaults
   *  to the global NPC_INTERACT_RADIUS when omitted. */
  interactRadiusTiles?: number;
  /** When set, agentBinding routes this NPC through the data-driven schedule
   *  planner using the named archetype (looked up in `npcArchetypes.json`)
   *  instead of the legacy `movement.type` wander/patrol path. The NPC's
   *  `spawn` tile is used as the planner's `spawnPoint` anchor. */
  scheduleArchetype?: string;
}

/** True if `def` belongs to the currently active map (either "world" or the
 *  given interior key). NPCs without a `map` field are treated as world NPCs. */
export function npcIsOnWorld(def: NpcDef): boolean {
  return !def.map || def.map === "world";
}

export function npcIsOnInterior(def: NpcDef, interiorKey: string): boolean {
  return typeof def.map === "object" && def.map.interior === interiorKey;
}

export interface DialogueDef {
  speaker: string;
  pages: string[];
}

export interface NpcData {
  npcs: NpcDef[];
  dialogues: Record<string, DialogueDef>;
}

export function npcTextureKey(
  npcId: string,
  state: "idle" | "walk",
  dir?: NpcRenderDir,
): string {
  return dir ? `npc-${npcId}-${state}-${dir}` : `npc-${npcId}-${state}`;
}

export function npcAnimKey(
  npcId: string,
  state: "idle" | "walk",
  dir?: NpcRenderDir,
): string {
  return dir ? `npc-${npcId}-${state}-${dir}` : `npc-${npcId}-${state}`;
}

export function charTextureKey(model: string, slot: string, variant: string, state: string): string {
  return `char-${model}-${slot}-${variant}-${state}`;
}

export function charAnimKey(model: string, slot: string, variant: string, state: string): string {
  return `char-${model}-${slot}-${variant}-${state}`;
}

export function charModelManifestUrl(model: string): string {
  return `sprites/characters/${model}/model.json`;
}

export function charModelManifestKey(model: string): string {
  return `char-model-${model}`;
}

export function charSlotSheetUrl(model: string, slot: string, variant: string, state: string): string {
  return `sprites/characters/${model}/${slot}/${variant}/${state}.png`;
}

/** Shape of the `model.json` that tools/build-character-slots.mjs writes.
 *  Every slot variant for the model shares frameWidth/frameHeight, which is
 *  what makes runtime layering composite cleanly. */
export interface CharacterModelManifest {
  model: string;
  frameWidth: number;
  frameHeight: number;
  slotOrder: string[];
  tags: Record<string, { frames: number; frameRate: number }>;
  slots: Record<string, string[]>;
}
