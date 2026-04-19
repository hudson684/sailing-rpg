import type { SaveController } from "./SaveController";

/** Module-level handle to the currently-live SaveController. World owns the
 *  instance today; SystemsScene and InteriorScene reach through this so they
 *  don't need a scene-to-scene reference. */
let active: SaveController | null = null;

export function setActiveSaveController(c: SaveController | null): void {
  active = c;
}

export function getActiveSaveController(): SaveController | null {
  return active;
}
