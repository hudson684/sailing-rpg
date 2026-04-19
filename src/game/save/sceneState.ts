/**
 * Scene-level state that isn't owned by a single entity — currently the
 * high-level gameplay mode plus, when inside a building, the door we entered
 * from. Mode transitions (OnFoot → AtHelm → Anchoring; OnFoot ↔ Interior)
 * re-enter from here on load so the camera, helm-parking, tilemap, and input
 * state all end up consistent.
 */
export type SceneMode = "OnFoot" | "AtHelm" | "Anchoring" | "Interior";

/** Which scene the player currently inhabits. Persisted so a reload after a
 *  quicksave while indoors wakes `Interior` instead of `World`. */
export type ActiveScene = "World" | "Interior";

export interface InteriorReturn {
  /** Key into WorldManifest.interiors for the currently loaded interior. */
  interiorKey: string;
  /** Where to drop the player back in the world on exit (global tile coords). */
  returnWorldTx: number;
  returnWorldTy: number;
  /** Facing to restore on exit. Free-form string to avoid a save-schema ←→
   *  Player.Facing import cycle; validated when applied. */
  returnFacing: string;
}

export class SceneState {
  mode: SceneMode = "OnFoot";
  interior: InteriorReturn | null = null;
  activeScene: ActiveScene = "World";

  serialize(): { mode: SceneMode; interior: InteriorReturn | null; activeScene: ActiveScene } {
    return { mode: this.mode, interior: this.interior, activeScene: this.activeScene };
  }

  hydrate(data: {
    mode: SceneMode;
    interior?: InteriorReturn | null;
    activeScene?: ActiveScene;
  }): void {
    this.mode = data.mode;
    this.interior = data.interior ?? null;
    this.activeScene = data.activeScene ?? (this.mode === "Interior" ? "Interior" : "World");
  }
}
