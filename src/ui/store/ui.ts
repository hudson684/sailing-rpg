import { useUIStore, type ToastKind } from "./uiStore";
import type { HudState } from "../../game/bus";

/** Convenience wrappers so game code doesn't have to reach into the store. */

export function showToast(
  text: string,
  ttlMs?: number,
  kind: ToastKind = "info",
): number {
  return useUIStore.getState().addToast(text, { ttlMs, kind });
}

export function setHud(patch: Partial<HudState>): void {
  useUIStore.getState().setHud(patch);
}
