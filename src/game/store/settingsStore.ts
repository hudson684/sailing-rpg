import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SkinPaletteId } from "../entities/playerSkin";

/**
 * User preferences — persisted to localStorage, independent of save slots.
 * Save slots capture game state ("what the player is doing"); this captures
 * settings ("how the player wants the game to behave"). Keep these separate
 * so copying a save between machines doesn't carry someone else's preferences.
 */

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

export interface SettingsState {
  zoom: number;
  masterVolume: number;
  skinTone: SkinPaletteId;
  characterCreated: boolean;

  setZoom: (z: number) => void;
  setMasterVolume: (v: number) => void;
  setSkinTone: (id: SkinPaletteId) => void;
  setCharacterCreated: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      zoom: 1,
      masterVolume: 1,
      skinTone: "default" as SkinPaletteId,
      characterCreated: false,

      setZoom: (z) =>
        set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) }),
      setMasterVolume: (v) =>
        set({ masterVolume: Math.min(1, Math.max(0, v)) }),
      setSkinTone: (id) => set({ skinTone: id }),
      setCharacterCreated: (v) => set({ characterCreated: v }),
    }),
    {
      name: "sailing-rpg:settings",
      version: 3,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
