/**
 * Scene-level state that isn't owned by a single entity — currently just the
 * high-level gameplay mode. Mode transitions (OnFoot → AtHelm → Anchoring)
 * re-enter from here on load so the camera, helm-parking, and input state all
 * end up consistent.
 */
export type SceneMode = "OnFoot" | "AtHelm" | "Anchoring";

export class SceneState {
  mode: SceneMode = "OnFoot";

  serialize(): { mode: SceneMode } {
    return { mode: this.mode };
  }

  hydrate(data: { mode: SceneMode }): void {
    this.mode = data.mode;
  }
}
