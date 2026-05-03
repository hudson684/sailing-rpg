import type { WorldLocation } from "../location";

/** Standing spots — exclusive "stand here" tiles inside a shop. Unlike
 *  `browseWaypoints`, each spot can only be claimed by one NPC at a time;
 *  `StandAroundActivity` calls `tryClaim` *before* it starts walking, so the
 *  spot stays locked while the NPC is in transit. This prevents two patrons
 *  from converging on the same tile.
 *
 *  Keys are namespaced strings of the form `<interiorOrBusinessId>:<groupId>`
 *  so a single shop can hold multiple zones (e.g. counter vs. display) and
 *  schedule templates can target a specific zone. The default group id is
 *  `"all"`.
 *
 *  Like `worldAnchors` and `browseWaypoints`, the spot list itself is rebuilt
 *  from world data on every load — there is no save state. `claimedBy`
 *  reservations are runtime-only too: on scene shutdown / player-leave the
 *  activity's `dematerialize` releases its claim so reservations don't leak
 *  into a save. */
export interface StandingSpot {
  readonly uid: string;
  readonly location: WorldLocation;
  /** NPC id currently holding this spot, or null if free. Set atomically by
   *  `tryClaim`; cleared by `release` / `releaseAllFor`. */
  claimedBy: string | null;
}

export class StandingSpotRegistry {
  private readonly byKey = new Map<string, StandingSpot[]>();
  /** Reverse index: spot uid → key. Lets `release(uid)` find the entry
   *  without scanning every key. Rebuilt by `set`. */
  private readonly keyByUid = new Map<string, string>();

  set(key: string, spots: readonly Omit<StandingSpot, "claimedBy">[]): void {
    // Drop any prior entries' reverse-index references for this key.
    const prior = this.byKey.get(key);
    if (prior) for (const p of prior) this.keyByUid.delete(p.uid);

    if (spots.length === 0) {
      this.byKey.delete(key);
      return;
    }
    const next: StandingSpot[] = spots.map((s) => ({
      uid: s.uid,
      location: { ...s.location },
      claimedBy: null,
    }));
    this.byKey.set(key, next);
    for (const s of next) this.keyByUid.set(s.uid, key);
  }

  /** Read-only snapshot of every spot under `key`, including current
   *  `claimedBy` state. Returned spots are copies — mutating them does not
   *  affect the registry (use `tryClaim` / `release` for that). */
  list(key: string): readonly StandingSpot[] {
    const v = this.byKey.get(key);
    if (!v) return [];
    return v.map((s) => ({ ...s, location: { ...s.location } }));
  }

  has(key: string): boolean {
    return (this.byKey.get(key)?.length ?? 0) > 0;
  }

  /** Atomically reserve a free spot for `npcId`. Returns the claimed spot, or
   *  null when every spot is already claimed (or filtered out by `exceptUid`).
   *
   *  `exceptUid` lets the caller skip the spot it just vacated so a patron
   *  doesn't ping-pong on the same tile when only two are free. */
  tryClaim(
    key: string,
    npcId: string,
    exceptUid?: string,
  ): StandingSpot | null {
    const spots = this.byKey.get(key);
    if (!spots) return null;
    for (const spot of spots) {
      if (spot.claimedBy !== null) continue;
      if (exceptUid && spot.uid === exceptUid) continue;
      spot.claimedBy = npcId;
      return { ...spot, location: { ...spot.location } };
    }
    return null;
  }

  release(uid: string): void {
    const key = this.keyByUid.get(uid);
    if (!key) return;
    const spots = this.byKey.get(key);
    if (!spots) return;
    for (const spot of spots) {
      if (spot.uid === uid) {
        spot.claimedBy = null;
        return;
      }
    }
  }

  /** Defensive cleanup — release every spot currently held by `npcId`. Called
   *  from `StandAroundActivity.exit` / `dematerialize` and any path that may
   *  drop the activity without a clean release. */
  releaseAllFor(npcId: string): void {
    for (const spots of this.byKey.values()) {
      for (const spot of spots) {
        if (spot.claimedBy === npcId) spot.claimedBy = null;
      }
    }
  }

  clearKey(key: string): void {
    const prior = this.byKey.get(key);
    if (prior) for (const p of prior) this.keyByUid.delete(p.uid);
    this.byKey.delete(key);
  }

  clear(): void {
    this.byKey.clear();
    this.keyByUid.clear();
  }

  /** Snapshot for the dev console. */
  listKeys(): ReadonlyArray<{ key: string; total: number; claimed: number }> {
    return [...this.byKey.entries()].map(([key, spots]) => ({
      key,
      total: spots.length,
      claimed: spots.reduce((n, s) => n + (s.claimedBy !== null ? 1 : 0), 0),
    }));
  }
}

export const standingSpots = new StandingSpotRegistry();

export const DEFAULT_STANDING_GROUP_ID = "all";

export function standingSpotKey(
  interiorOrBusinessId: string,
  standingGroupId: string = DEFAULT_STANDING_GROUP_ID,
): string {
  return `${interiorOrBusinessId}:${standingGroupId}`;
}
