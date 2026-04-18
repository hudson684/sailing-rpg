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
}

export type DialogueAction =
  | { type: "advance" }
  | { type: "close" };

import type { SkinPaletteId } from "./entities/playerSkin";
import type { CfLayer } from "./entities/playerAnims";

export interface ShopOpenRequest {
  shopId: string;
}

export interface WardrobeApply {
  layer: CfLayer;
  variant: string | null;
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
