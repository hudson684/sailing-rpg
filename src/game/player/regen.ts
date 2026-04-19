import { useGameStore } from "../store/gameStore";

/** Time after last damage before player HP regen kicks in. */
export const PLAYER_OUT_OF_COMBAT_MS = 6000;
/** HP per second regenerated while out of combat (fractional ok). */
export const PLAYER_REGEN_PER_SEC = 1.0;

class HealthRegen {
  private lastDamagedAtMs = -Infinity;
  private accum = 0;

  /** Called on every hit to the player; resets the out-of-combat timer. */
  noteDamage(): void {
    this.lastDamagedAtMs = performance.now();
    this.accum = 0;
  }

  /** Advance the regen accumulator and apply whole-point heals. */
  tick(dtMs: number): void {
    if (performance.now() - this.lastDamagedAtMs < PLAYER_OUT_OF_COMBAT_MS) return;
    const store = useGameStore.getState();
    if (store.health.current <= 0) return;
    this.accum += PLAYER_REGEN_PER_SEC * (dtMs / 1000);
    if (this.accum < 1) return;
    const whole = Math.floor(this.accum);
    const healed = store.healthHeal(whole);
    this.accum -= whole;
    if (healed === 0) this.accum = 0; // already full; don't stockpile
  }

  reset(): void {
    this.lastDamagedAtMs = -Infinity;
    this.accum = 0;
  }
}

export const healthRegen = new HealthRegen();
