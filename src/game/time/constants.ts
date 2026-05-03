export const DAY_MS = 22.5 * 60 * 1000;
export const NIGHT_MS = 7.5 * 60 * 1000;

export const HOURS_PER_PHASE = 6;

/** Sub-hour cadence for the canonical sim tick. 6 ticks/hour = 10 in-game
 *  minutes per tick. The NPC registry, business idle sim, and spawn
 *  dispatcher all run on this. */
export const TICKS_PER_HOUR = 6;
export const TICK_SIM_MINUTES = 60 / TICKS_PER_HOUR;

export const HOUR_MS_DAY = DAY_MS / HOURS_PER_PHASE;
export const HOUR_MS_NIGHT = NIGHT_MS / HOURS_PER_PHASE;

export type Phase = "day" | "night";

export function phaseDurationMs(phase: Phase): number {
  return phase === "day" ? DAY_MS : NIGHT_MS;
}

export function hourDurationMs(phase: Phase): number {
  return phase === "day" ? HOUR_MS_DAY : HOUR_MS_NIGHT;
}

export function tickDurationMs(phase: Phase): number {
  return hourDurationMs(phase) / TICKS_PER_HOUR;
}

/** Minutes per in-game day (used for schedule math). */
export const MINUTES_PER_DAY = 24 * 60;

/** In-game minute-of-day in [0, 1440). Day phase covers 06:00→18:00; night
 *  covers 18:00→06:00. Mirrors the Clock UI's mapping so schedule windows
 *  read the same as the tooltip the player sees. */
export function minuteOfDay(phase: Phase, elapsedInPhaseMs: number): number {
  const total = phase === "day" ? DAY_MS : NIGHT_MS;
  const progress = total > 0 ? Math.max(0, Math.min(1, elapsedInPhaseMs / total)) : 0;
  const base = phase === "day" ? 6 * 60 : 18 * 60;
  return (base + progress * 12 * 60) % MINUTES_PER_DAY;
}

/** Real-ms duration of N in-game minutes during `phase`. */
export function inGameMinutesToMs(minutes: number, phase: Phase): number {
  return (minutes / 60) * hourDurationMs(phase);
}
