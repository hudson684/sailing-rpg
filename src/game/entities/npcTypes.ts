export interface NpcAnimSheet {
  sheet: string;
  frameWidth: number;
  frameHeight: number;
  start: number;
  end: number;
  frameRate: number;
}

export type NpcFacing = "left" | "right";

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
  scale: number;
  originY: number;
}

/** Which map this NPC lives on. Omitted/"world" = the outdoor world (spawn
 *  coords are global tiles). `{ interior: <key> }` = inside the named building
 *  (spawn coords are local to that interior tilemap). */
export type NpcMap = "world" | { interior: string };

export interface NpcDef {
  id: string;
  name: string;
  sprite: { idle: NpcAnimSheet; walk?: NpcAnimSheet };
  display: NpcDisplay;
  /** Defaults to "world" when absent, for backward compat with existing data. */
  map?: NpcMap;
  spawn: NpcSpawnTile;
  facing: NpcFacing;
  movement: NpcMovement;
  dialogue: string;
  /** If set, right-clicking this NPC opens the referenced shop. */
  shopId?: string;
  /** Per-NPC override of the dialogue interact radius, in tiles. Defaults
   *  to the global NPC_INTERACT_RADIUS when omitted. */
  interactRadiusTiles?: number;
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

export function npcTextureKey(npcId: string, state: "idle" | "walk"): string {
  return `npc-${npcId}-${state}`;
}

export function npcAnimKey(npcId: string, state: "idle" | "walk"): string {
  return `npc-${npcId}-${state}`;
}
