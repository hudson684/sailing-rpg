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

export interface NpcDef {
  id: string;
  name: string;
  sprite: { idle: NpcAnimSheet; walk?: NpcAnimSheet };
  display: NpcDisplay;
  spawn: NpcSpawnTile;
  facing: NpcFacing;
  movement: NpcMovement;
  dialogue: string;
  /** If set, right-clicking this NPC opens the referenced shop. */
  shopId?: string;
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
