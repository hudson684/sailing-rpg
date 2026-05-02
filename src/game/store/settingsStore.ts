import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SkinPaletteId } from "../entities/playerSkin";
import type { CfLayer } from "../entities/playerAnims";
import { DEFAULT_WARDROBE, type CfWardrobe } from "../entities/playerWardrobe";

/**
 * User preferences — persisted to localStorage, independent of save slots.
 * Save slots capture game state ("what the player is doing"); this captures
 * settings ("how the player wants the game to behave"). Keep these separate
 * so copying a save between machines doesn't carry someone else's preferences.
 */

export const ZOOM_STEPS = [3, 4, 6, 8] as const;
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const ZOOM_SNAP_EPSILON = 0.001;

/** Coarse-pointer devices (touch screens) get a closer default zoom because
 *  the fixed 960×640 viewport renders very small on phone screens. */
const DEFAULT_ZOOM_DESKTOP = 3;
const DEFAULT_ZOOM_MOBILE = 3;

function isCoarsePointer(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

function defaultZoom(): number {
  return isCoarsePointer() ? DEFAULT_ZOOM_MOBILE : DEFAULT_ZOOM_DESKTOP;
}

export type MobileMode = "auto" | "on" | "off";

export interface SettingsState {
  zoom: number;
  masterVolume: number;
  skinTone: SkinPaletteId;
  wardrobe: CfWardrobe;
  characterCreated: boolean;
  mobileMode: MobileMode;

  setZoom: (z: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setMasterVolume: (v: number) => void;
  setSkinTone: (id: SkinPaletteId) => void;
  setWardrobeLayer: (layer: CfLayer, variant: string | null) => void;
  setWardrobe: (wardrobe: CfWardrobe) => void;
  setCharacterCreated: (v: boolean) => void;
  setMobileMode: (m: MobileMode) => void;
}

function snapStep(cur: number, dir: 1 | -1): number {
  if (dir > 0) {
    const next = ZOOM_STEPS.find((s) => s > cur + ZOOM_SNAP_EPSILON);
    return next ?? MAX_ZOOM;
  }
  let prev: number = MIN_ZOOM;
  for (const s of ZOOM_STEPS) {
    if (s < cur - ZOOM_SNAP_EPSILON) prev = s;
    else break;
  }
  return prev;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      zoom: defaultZoom(),
      masterVolume: 1,
      skinTone: "default" as SkinPaletteId,
      wardrobe: { ...DEFAULT_WARDROBE },
      characterCreated: false,
      mobileMode: "auto" as MobileMode,

      setZoom: (z) =>
        set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) }),
      zoomIn: () => set({ zoom: snapStep(get().zoom, 1) }),
      zoomOut: () => set({ zoom: snapStep(get().zoom, -1) }),
      setMasterVolume: (v) =>
        set({ masterVolume: Math.min(1, Math.max(0, v)) }),
      setSkinTone: (id) => set({ skinTone: id }),
      setWardrobeLayer: (layer, variant) =>
        set((s) => ({ wardrobe: { ...s.wardrobe, [layer]: variant } })),
      setWardrobe: (wardrobe) => set({ wardrobe: { ...wardrobe } }),
      setCharacterCreated: (v) => set({ characterCreated: v }),
      setMobileMode: (m) => set({ mobileMode: m }),
    }),
    {
      name: "sailing-rpg:settings",
      version: 8,
      storage: createJSONStorage(() => localStorage),
      // Old saves without `wardrobe` get the default outfit. No data loss.
      migrate: (persisted: unknown, version: number) => {
        const state = (persisted ?? {}) as Partial<SettingsState>;
        if (version < 4 || !state.wardrobe) {
          state.wardrobe = { ...DEFAULT_WARDROBE };
        }
        if (version < 5 || !state.mobileMode) {
          state.mobileMode = "auto";
        }
        // v6: bump existing mobile users still sitting on the legacy default
        // zoom (1) up to the new mobile default. Anyone who picked a custom
        // zoom keeps it.
        if (version < 6 && state.zoom === 1 && isCoarsePointer()) {
          state.zoom = DEFAULT_ZOOM_MOBILE;
        }
        // v7: dropped the 0.5 and 1 zoom steps — they let players see too much
        // of the world. Anyone parked below the new minimum gets pulled in.
        // v8: dropped the 1.5 and 2 zoom steps for the same reason.
        if (version < 8 && typeof state.zoom === "number" && state.zoom < MIN_ZOOM) {
          state.zoom = defaultZoom();
        }
        return state as SettingsState;
      },
    },
  ),
);
