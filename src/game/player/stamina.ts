/**
 * Global stamina pool. Used by sprinting (drain while sprint key held) and
 * regenerates after a short delay. Lives at module scope so it persists
 * across scene swaps — stamina you spent sprinting outdoors shouldn't
 * reset on the frame you step into a cabin.
 */

export const STAMINA_MAX = 100;
export const STAMINA_DRAIN_PER_SEC = 12;
export const STAMINA_REGEN_PER_SEC = 20;
export const STAMINA_REGEN_DELAY_MS = 5000;

class Stamina {
  current = STAMINA_MAX;
  /** performance.now() timestamp of the last frame stamina was drained. */
  lastDrainAtMs = -Infinity;

  /** Drain stamina for `dt` seconds of sprinting. Clamps at 0. */
  drain(dt: number): void {
    this.current = Math.max(0, this.current - STAMINA_DRAIN_PER_SEC * dt);
    this.lastDrainAtMs = performance.now();
  }

  /** Regen stamina for `dt` seconds, respecting the post-drain delay. */
  regen(dt: number): void {
    if (this.current >= STAMINA_MAX) return;
    if (performance.now() - this.lastDrainAtMs < STAMINA_REGEN_DELAY_MS) return;
    this.current = Math.min(STAMINA_MAX, this.current + STAMINA_REGEN_PER_SEC * dt);
  }

  /** Reset to full. Used on new-game. */
  reset(): void {
    this.current = STAMINA_MAX;
    this.lastDrainAtMs = -Infinity;
  }
}

export const stamina = new Stamina();
