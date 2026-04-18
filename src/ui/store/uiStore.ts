import { create } from "zustand";
import type { HudState } from "../../game/bus";

/**
 * UI-only state. Separate from useGameStore on purpose: nothing here is
 * part of a save (toasts, panel visibility, transient prompts). Saves
 * should never carry UI state.
 */

export type ToastKind = "info" | "success" | "warn" | "error";

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
  expiresAt: number;
}

export interface UIState {
  hud: HudState;
  toasts: Toast[];

  setHud: (patch: Partial<HudState>) => void;
  addToast: (text: string, opts?: { ttlMs?: number; kind?: ToastKind }) => number;
  dismissToast: (id: number) => void;
  pruneExpiredToasts: (now?: number) => void;
}

const INITIAL_HUD: HudState = {
  mode: "OnFoot",
  prompt: null,
  speed: 0,
  heading: 0,
  message: null,
};

let nextToastId = 1;

export const useUIStore = create<UIState>()((set, get) => ({
  hud: INITIAL_HUD,
  toasts: [],

  setHud: (patch) => set((s) => ({ hud: { ...s.hud, ...patch } })),

  addToast: (text, opts) => {
    const id = nextToastId++;
    const ttl = opts?.ttlMs ?? 2500;
    const toast: Toast = {
      id,
      text,
      kind: opts?.kind ?? "info",
      expiresAt: Date.now() + ttl,
    };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    window.setTimeout(() => get().dismissToast(id), ttl);
    return id;
  },

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  pruneExpiredToasts: (now = Date.now()) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.expiresAt > now) })),
}));

export const selectHud = (s: UIState) => s.hud;
export const selectToasts = (s: UIState) => s.toasts;
