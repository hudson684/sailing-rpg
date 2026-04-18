/**
 * Tracks which authored ground-item spawns the player has picked up. Keyed by
 * the spawn's uid (stamped by the map pipeline). A spawn absent from this set
 * is still on the ground; presence means the player has claimed it.
 *
 * Phase 1: binary (picked / not picked). Partial pickups (inventory overflow)
 * round down — i.e. any leftover keeps the full authored quantity on ground.
 */
export class GroundItemsState {
  private pickedUp = new Set<string>();

  isPickedUp(uid: string): boolean {
    return this.pickedUp.has(uid);
  }

  markPickedUp(uid: string): void {
    this.pickedUp.add(uid);
  }

  reset(): void {
    this.pickedUp.clear();
  }

  serialize(): string[] {
    return [...this.pickedUp].sort();
  }

  hydrate(uids: readonly string[]): void {
    this.pickedUp = new Set(uids);
  }
}
