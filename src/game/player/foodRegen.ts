import { useGameStore } from "../store/gameStore";

/** HP per second drained from the food-regen pool into player health. */
export const FOOD_REGEN_PER_SEC = 2.0;

class FoodRegen {
  private pool = 0;
  private accum = 0;

  /** Add HP to the regen pool. Called when eating regen food. */
  add(hp: number): void {
    if (hp <= 0) return;
    this.pool += hp;
  }

  /** True when no regen food is currently ticking. */
  isIdle(): boolean {
    return this.pool <= 0;
  }

  /** Advance the pool and apply whole-point heals. Ticks regardless of
   *  combat state — food heals you even while being hit. */
  tick(dtMs: number): void {
    if (this.pool <= 0) return;
    const store = useGameStore.getState();
    if (store.health.current <= 0) {
      this.reset();
      return;
    }
    this.accum += FOOD_REGEN_PER_SEC * (dtMs / 1000);
    if (this.accum < 1) return;
    const wanted = Math.min(Math.floor(this.accum), this.pool);
    if (wanted <= 0) return;
    const healed = store.healthHeal(wanted);
    this.pool -= healed;
    this.accum -= wanted;
    if (healed === 0) this.accum = 0; // already full; don't stockpile
  }

  reset(): void {
    this.pool = 0;
    this.accum = 0;
  }
}

export const foodRegen = new FoodRegen();
