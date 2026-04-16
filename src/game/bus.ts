import * as Phaser from "phaser";

export type PlayerMode = "OnFoot" | "Boarding" | "OnDeck" | "AtHelm" | "Anchoring";

export interface HudState {
  mode: PlayerMode;
  prompt: string | null;
  speed: number;
  heading: number;
  message: string | null;
}

type Events = {
  "hud:update": (state: Partial<HudState>) => void;
  "hud:message": (text: string, ttlMs?: number) => void;
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
