import type { SaveEnvelope, SlotId } from "./save";
import type { CraftOutcomeTier } from "./crafting/types";
import type { JobId } from "./jobs/jobs";

export type PlayerMode = "OnFoot" | "Boarding" | "OnDeck" | "AtHelm" | "Anchoring";

export interface HudState {
  mode: PlayerMode;
  prompt: string | null;
  speed: number;
  heading: number;
  message: string | null;
  stamina: number;
  staminaMax: number;
  /** Ship top speed (px/s) used as the denominator for the speed HUD. Set
   *  while AtHelm; null otherwise so the HUD can decide when to render. */
  shipMaxSpeed: number | null;
  /** Current sail state. Null when not sailing. */
  sail: { state: "furled" | "reefed" | "trim" | "full" } | null;
}

export type InventoryAction =
  | { type: "move"; from: number; to: number }
  | { type: "drop"; slot: number };

export type SaveRequest =
  | { type: "save"; slot: SlotId }
  | { type: "load"; slot: SlotId }
  | { type: "delete"; slot: SlotId }
  | { type: "newGame" }
  | { type: "refresh" };

export interface PauseMenuSlot {
  slot: SlotId;
  envelope: SaveEnvelope | null;
}

export interface PauseMenuState {
  visible: boolean;
  slots: PauseMenuSlot[];
}

export interface DialogueChoiceOption {
  label: string;
  /** Cutscene step-group label to jump to. Opaque to the dialogue UI. */
  goto: string;
}

export interface DialogueState {
  visible: boolean;
  speaker: string;
  pages: string[];
  page: number;
  shopId?: string;
  /** When set, the dialogue UI renders selectable buttons instead of the
   *  default "advance to close" footer. Emitted by the cutscene director on
   *  the final page of a `say` step. */
  choices?: DialogueChoiceOption[];
}

export type DialogueAction =
  | { type: "advance" }
  | { type: "close" }
  /** Picked one of the options from `DialogueState.choices`. */
  | { type: "select"; index: number };

import type { SkinPaletteId } from "./entities/playerSkin";
import type { CfLayer } from "./entities/playerAnims";

export interface ShopOpenRequest {
  shopId: string;
}

export interface ChestOpenRequest {
  chestId: string;
  chestName: string;
  loot: Array<{ itemId: string; qty: number }>;
}
export interface ChestTakeRequest {
  chestId: string;
  /** Loot list index to take. */
  index: number;
}
export interface ChestTakeAllRequest {
  chestId: string;
}

/** Generic crafting flow. Emitted by React modal → consumed by WorldScene,
 *  then WorldScene → CraftingScene (minigame) → WorldScene (apply result).
 *  Payloads are skill-agnostic so every crafting skill reuses the same path. */
export interface CraftingOpenRequest {
  stationDefId: string;
}
export interface CraftingBeginRequest {
  stationDefId: string;
  recipeId: string;
}
export type CraftingOutcomeTier = CraftOutcomeTier;
export interface CraftingCompleteResult {
  stationDefId: string;
  recipeId: string;
  tier: CraftOutcomeTier;
  /** Strikes used out of budget. Informational; tier captures the actual grade. */
  movesUsed: number;
}

export interface WardrobeApply {
  layer: CfLayer;
  variant: string | null;
}

// ─── Edit mode ───────────────────────────────────────────────────
//
// Edit mode is a developer-only overlay that lets you visually move,
// place, and delete world entities, then export the resulting JSON.

export type EditEntityKind = "npc" | "enemy" | "node" | "item" | "ship" | "station" | "chest";

/** Which map an edit operation / snapshot entry refers to. `"world"` is the
 *  outer world map; any other string is an interior key. */
export type EditMapId = string;

export interface EditNpcEntry {
  id: string;
  name: string;
  tileX: number;
  tileY: number;
  shopId?: string;
  /** "world" or interior key. */
  map: EditMapId;
}

export interface EditEnemyEntry {
  id: string;
  defId: string;
  defName: string;
  tileX: number;
  tileY: number;
  map: EditMapId;
}

export interface EditNodeEntry {
  id: string;
  defId: string;
  defName: string;
  tileX: number;
  tileY: number;
  map: EditMapId;
}

export interface EditStationEntry {
  id: string;
  defId: string;
  defName: string;
  tileX: number;
  tileY: number;
  map: EditMapId;
}

export interface EditChestEntry {
  id: string;
  defId: string;
  defName: string;
  tileX: number;
  tileY: number;
  map: EditMapId;
}

export interface EditItemEntry {
  id: string;
  itemId: string;
  itemName: string;
  quantity: number;
  tileX: number;
  tileY: number;
  /** Authored items come from .tmj files and cannot be moved/deleted in edit mode. */
  source: "authored" | "editor";
  map: EditMapId;
}

export interface EditShipEntry {
  id: string;
  defId: string;
  defName: string;
  tileX: number;
  tileY: number;
  heading: "N" | "E" | "S" | "W";
  map: EditMapId;
}

export interface EditDefEntry {
  id: string;
  name: string;
}

export interface EditShopEntry {
  id: string;
  name: string;
  greeting?: string;
  stock: Array<{ itemId: string; restockQuantity: number }>;
}

export interface EditSnapshot {
  /** The map currently being edited (the active scene's map). */
  map: EditMapId;
  npcs: EditNpcEntry[];
  enemies: EditEnemyEntry[];
  nodes: EditNodeEntry[];
  stations: EditStationEntry[];
  chests: EditChestEntry[];
  items: EditItemEntry[];
  ships: EditShipEntry[];
  defs: {
    npcs: EditDefEntry[];
    enemies: EditDefEntry[];
    nodes: EditDefEntry[];
    stations: EditDefEntry[];
    chests: EditDefEntry[];
    items: EditDefEntry[];
    ships: EditDefEntry[];
  };
  shops: EditShopEntry[];
  /** Which entity kinds the active scene supports placing.
   *  (e.g. interiors omit "ship".) */
  supportedKinds: EditEntityKind[];
}

export interface EditState {
  active: boolean;
  snapshot: EditSnapshot | null;
}

export interface EditClick {
  worldX: number;
  worldY: number;
  tileX: number;
  tileY: number;
  hit: { kind: EditEntityKind; id: string } | null;
}

export interface EditMoveRequest {
  kind: EditEntityKind;
  id: string;
  tileX: number;
  tileY: number;
}

export interface EditPlaceRequest {
  kind: EditEntityKind;
  defId: string;
  tileX: number;
  tileY: number;
  /** For item placements; defaults to 1. */
  quantity?: number;
}

export interface EditDeleteRequest {
  kind: EditEntityKind;
  id: string;
}

export interface EditShopUpdate {
  shopId: string;
  stock: Array<{ itemId: string; restockQuantity: number }>;
}

type Events = {
  "inventory:action": (action: InventoryAction) => void;
  "save:request": (request: SaveRequest) => void;
  "pause:update": (state: PauseMenuState) => void;
  "pause:toggle": () => void;
  "dialogue:update": (state: DialogueState) => void;
  "dialogue:action": (action: DialogueAction) => void;
  "skin:apply": (paletteId: SkinPaletteId) => void;
  "wardrobe:apply": (change: WardrobeApply) => void;
  "shop:open": (request: ShopOpenRequest) => void;
  "shop:close": () => void;
  "chest:open": (request: ChestOpenRequest) => void;
  "chest:close": () => void;
  "chest:take": (request: ChestTakeRequest) => void;
  "chest:takeAll": (request: ChestTakeAllRequest) => void;
  "crafting:open": (request: CraftingOpenRequest) => void;
  "crafting:close": () => void;
  "crafting:begin": (request: CraftingBeginRequest) => void;
  "crafting:complete": (result: CraftingCompleteResult) => void;
  "crafting:cancel": () => void;
  "edit:toggle": () => void;
  "edit:state": (state: EditState) => void;
  "edit:click": (click: EditClick) => void;
  "edit:move": (req: EditMoveRequest) => void;
  "edit:place": (req: EditPlaceRequest) => void;
  "edit:delete": (req: EditDeleteRequest) => void;
  "edit:shopUpdate": (req: EditShopUpdate) => void;
  "edit:requestSnapshot": () => void;
  "edit:requestExport": () => void;
  "edit:export": (payload: { files: Array<{ name: string; content: string }> }) => void;
  "player:resetSpawn": () => void;
  "ships:resetAll": () => void;
  "jobs:xpGained": (payload: { jobId: JobId; amount: number }) => void;
  /** Request the active scene play a cutscene by id. Picked up by whichever
   *  scene currently owns the cutscene director. */
  "cutscene:play": (payload: { id: string }) => void;

  // ── Quest / dialogue / world-state events ────────────────────────
  //
  // These are gameplay observations — emitted by the systems that
  // already own the data, consumed by QuestManager. Nothing in
  // src/game/quests imports from these systems directly; coupling
  // goes through this bus.
  "combat:enemyKilled": (payload: {
    defId: string;
    instanceId: string;
    mapId: string;
    x: number;
    y: number;
  }) => void;
  "gathering:nodeHit": (payload: {
    defId: string;
    mapId: string;
  }) => void;
  "gathering:nodeHarvested": (payload: {
    defId: string;
    mapId: string;
    yieldedItemId: string;
    yieldedQuantity: number;
  }) => void;
  "fishing:caught": (payload: {
    itemId: string;
    mapId: string;
    quantity: number;
  }) => void;
  "shop:purchased": (payload: {
    shopId: string;
    itemId: string;
    quantity: number;
  }) => void;
  "world:mapEntered": (payload: {
    mapId: string;
    fromMapId: string | null;
    reason: "load" | "transition" | "cutscene";
  }) => void;
  "player:tileEntered": (payload: {
    mapId: string;
    tileX: number;
    tileY: number;
  }) => void;
  "npc:interacted": (payload: {
    npcId: string;
    mapId: string;
  }) => void;
  "dialogue:ended": (payload: {
    treeId: string;
    endNodeId: string | null;
  }) => void;
  "flags:changed": (payload: {
    key: string;
    value: boolean | number | string | undefined;
    prev: boolean | number | string | undefined;
  }) => void;

  // ── Quest lifecycle ──────────────────────────────────────────────
  "quest:started": (payload: { questId: string }) => void;
  "quest:stepEntered": (payload: { questId: string; stepId: string }) => void;
  "quest:stepCompleted": (payload: { questId: string; stepId: string }) => void;
  "quest:completed": (payload: { questId: string }) => void;
  "quest:unlocked": (payload: { questId: string }) => void;

  // ── Cutscene → scene: forced map change ──────────────────────────
  "cutscene:changeMapRequest": (payload: {
    mapId: string;
    tileX: number;
    tileY: number;
    facing?: "left" | "right" | "up" | "down";
  }) => void;
};

// Tiny hand-rolled typed event emitter. Kept Phaser-free so importing `bus`
// from UI code doesn't pull the Phaser runtime into the initial bundle.
class TypedEmitter {
  private readonly listeners = new Map<keyof Events, Set<(...args: unknown[]) => void>>();

  emitTyped<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const fn of [...set]) fn(...(args as unknown[]));
    return true;
  }
  onTyped<K extends keyof Events>(event: K, fn: Events[K]): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as (...args: unknown[]) => void);
    return this;
  }
  offTyped<K extends keyof Events>(event: K, fn: Events[K]): this {
    this.listeners.get(event)?.delete(fn as (...args: unknown[]) => void);
    return this;
  }
}

export const bus = new TypedEmitter();
