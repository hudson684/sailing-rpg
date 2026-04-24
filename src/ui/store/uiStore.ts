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
  // Whether the TitleScene has been dismissed and gameplay has begun.
  // Not persisted: every page load shows the title screen again, so the
  // React HUD / touch controls must start hidden each session.
  titleDismissed: boolean;
  // Touch inventory is a full-screen modal on mobile. Tracked here so
  // TouchControls can hide itself while the modal is up (the backdrop
  // would swallow its input anyway).
  inventoryOpen: boolean;

  setHud: (patch: Partial<HudState>) => void;
  setTitleDismissed: (v: boolean) => void;
  setInventoryOpen: (v: boolean) => void;
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
  stamina: 100,
  staminaMax: 100,
  wind: null,
  shipMaxSpeed: null,
  shipVel: null,
  sail: null,
};

let nextToastId = 1;

export const useUIStore = create<UIState>()((set, get) => ({
  hud: INITIAL_HUD,
  toasts: [],
  titleDismissed: false,
  inventoryOpen: false,

  setHud: (patch) => set((s) => ({ hud: { ...s.hud, ...patch } })),

  setTitleDismissed: (v) => set({ titleDismissed: v }),

  setInventoryOpen: (v) => set({ inventoryOpen: v }),

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
