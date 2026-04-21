import type { SaveEnvelope, SlotId } from "./save";
import type { CraftOutcomeTier } from "./crafting/types";

export type PlayerMode = "OnFoot" | "Boarding" | "OnDeck" | "AtHelm" | "Anchoring";

export interface HudState {
  mode: PlayerMode;
  prompt: string | null;
  speed: number;
  heading: number;
  message: string | null;
  stamina: number;
  staminaMax: number;
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

export interface DialogueState {
  visible: boolean;
  speaker: string;
  pages: string[];
  page: number;
  shopId?: string;
}

export type DialogueAction =
  | { type: "advance" }
  | { type: "close" };

import type { SkinPaletteId } from "./entities/playerSkin";
import type { CfLayer } from "./entities/playerAnims";

export interface ShopOpenRequest {
  shopId: string;
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

export type EditEntityKind = "npc" | "enemy" | "node" | "item" | "ship";

export interface EditNpcEntry {
  id: string;
  name: string;
  tileX: number;
  tileY: number;
  shopId?: string;
  /** "world" or interior key (for display only). */
  map: string;
}

export interface EditEnemyEntry {
  id: string;
  defId: string;
  defName: string;
  tileX: number;
  tileY: number;
}

export interface EditNodeEntry {
  id: string;
  defId: string;
  defName: string;
  tileX: number;
  tileY: number;
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
}

export interface EditShipEntry {
  id: string;
  defId: string;
  defName: string;
  tileX: number;
  tileY: number;
  heading: "N" | "E" | "S" | "W";
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
  npcs: EditNpcEntry[];
  enemies: EditEnemyEntry[];
  nodes: EditNodeEntry[];
  items: EditItemEntry[];
  ships: EditShipEntry[];
  defs: {
    npcs: EditDefEntry[];
    enemies: EditDefEntry[];
    nodes: EditDefEntry[];
    items: EditDefEntry[];
    ships: EditDefEntry[];
  };
  shops: EditShopEntry[];
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
