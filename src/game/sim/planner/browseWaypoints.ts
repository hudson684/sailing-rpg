import type { WorldLocation } from "../location";

/** Browse waypoints — clusters of "stand here for a bit" tiles inside a shop
 *  interior. `BrowseActivity` samples one at a time to give the NPC something
 *  to drift between while the duration timer counts down.
 *
 *  Keys are namespaced strings of the form `<interiorOrBusinessId>:<groupId>`
 *  so a single shop can hold multiple zones (e.g. dry goods vs. armory) and
 *  schedule templates can target a specific zone. The default group id is
 *  `"all"` and is what the scheduler emits when a template doesn't specify
 *  one.
 *
 *  Like `worldAnchors`, this is rebuilt from world data on every load — there
 *  is no save state. InteriorScene clears its own waypoints on shutdown and
 *  reseeds them on create. */
export class BrowseWaypointRegistry {
  private readonly byKey = new Map<string, WorldLocation[]>();

  set(key: string, waypoints: readonly WorldLocation[]): void {
    if (waypoints.length === 0) {
      this.byKey.delete(key);
      return;
    }
    this.byKey.set(
      key,
      waypoints.map((w) => ({ ...w })),
    );
  }

  get(key: string): readonly WorldLocation[] {
    const v = this.byKey.get(key);
    return v ? v.map((w) => ({ ...w })) : [];
  }

  has(key: string): boolean {
    return (this.byKey.get(key)?.length ?? 0) > 0;
  }

  clearKey(key: string): void {
    this.byKey.delete(key);
  }

  clear(): void {
    this.byKey.clear();
  }

  /** Snapshot for the dev console. */
  list(): ReadonlyArray<{ key: string; count: number }> {
    return [...this.byKey.entries()].map(([key, ws]) => ({ key, count: ws.length }));
  }
}

export const browseWaypoints = new BrowseWaypointRegistry();

export const DEFAULT_BROWSE_GROUP_ID = "all";

export function browseWaypointKey(
  interiorOrBusinessId: string,
  browseGroupId: string = DEFAULT_BROWSE_GROUP_ID,
): string {
  return `${interiorOrBusinessId}:${browseGroupId}`;
}
