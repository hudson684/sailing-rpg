import * as Phaser from "phaser";
import type { Slots } from "./inventory/Inventory";
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

type Events = {
  "hud:update": (state: Partial<HudState>) => void;
  "hud:message": (text: string, ttlMs?: number) => void;
  "inventory:update": (slots: Slots) => void;
  "inventory:action": (action: InventoryAction) => void;
  "save:request": (request: SaveRequest) => void;
  "pause:update": (state: PauseMenuState) => void;
  "pause:toggle": () => void;
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
