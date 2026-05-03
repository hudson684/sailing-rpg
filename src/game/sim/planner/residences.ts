import type { WorldLocation } from "../location";

/** Residence registry — one home tile per hireable id, populated from
 *  authored `npcResidence` Tiled objects on world load. Phase 8's hire
 *  pipeline reads this to build the staffer's daily Sleep/GoTo/WorkAt plan;
 *  no residence registered → no registry-driven agent for that hire (the
 *  legacy synthetic-spawn path runs unchanged).
 *
 *  Like `worldAnchors` and `browseWaypoints`, this is rebuilt from world
 *  data on every load — there is no save state. WorldScene clears on
 *  initialization and reseeds as chunks become ready. */
export class ResidenceRegistry {
  private readonly byHireableId = new Map<string, WorldLocation>();

  set(hireableId: string, loc: WorldLocation): void {
    this.byHireableId.set(hireableId, { ...loc });
  }

  get(hireableId: string): WorldLocation | null {
    const v = this.byHireableId.get(hireableId);
    return v ? { ...v } : null;
  }

  has(hireableId: string): boolean {
    return this.byHireableId.has(hireableId);
  }

  clear(): void {
    this.byHireableId.clear();
  }

  /** Snapshot for the dev console. */
  list(): ReadonlyArray<{ hireableId: string; loc: WorldLocation }> {
    return [...this.byHireableId.entries()].map(([hireableId, loc]) => ({
      hireableId,
      loc: { ...loc },
    }));
  }
}

export const residences = new ResidenceRegistry();
