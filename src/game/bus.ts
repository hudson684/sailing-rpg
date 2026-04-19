import * as Phaser from "phaser";
import type { SaveEnvelope, SlotId } from "./save";

export type PlayerMode = "OnFoot" | "Boarding" | "OnDeck" | "AtHelm" | "Anchoring";

export interface HudState {
  mode: PlayerMode;
  prompt: string | null;
  speed: number;
  heading: number;
  message: string | null;
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
  | { type: "close" }
  | { type: "openShop" };

import type { SkinPaletteId } from "./entities/playerSkin";
import type { CfLayer } from "./entities/playerAnims";

export interface ShopOpenRequest {
  shopId: string;
}

export interface WardrobeApply {
  layer: CfLayer;
  variant: string | null;
}

// ─── Edit mode ───────────────────────────────────────────────────
//
// Edit mode is a developer-only overlay that lets you visually move,
// place, and delete world entities, then export the resulting JSON.

export type EditEntityKind = "npc" | "enemy" | "node" | "item";

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
  defs: {
    npcs: EditDefEntry[];
    enemies: EditDefEntry[];
    nodes: EditDefEntry[];
    items: EditDefEntry[];
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
};

class TypedEmitter extends Phaser.Events.EventEmitter {
  emitTyped<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): boolean {
    return this.emit(event, ...args);
  }
  onTyped<K extends keyof Events>(event: K, fn: Events[K]): this {
    return this.on(event, fn as (...args: unknown[]) => void);
  }
  offTyped<K extends keyof Events>(event: K, fn: Events[K]): this {
    return this.off(event, fn as (...args: unknown[]) => void);
  }
}

export const bus = new TypedEmitter();
