export const DAY_MS = 22.5 * 60 * 1000;
export const NIGHT_MS = 7.5 * 60 * 1000;

export const HOURS_PER_PHASE = 6;

export const HOUR_MS_DAY = DAY_MS / HOURS_PER_PHASE;
export const HOUR_MS_NIGHT = NIGHT_MS / HOURS_PER_PHASE;

export type Phase = "day" | "night";

export function phaseDurationMs(phase: Phase): number {
  return phase === "day" ? DAY_MS : NIGHT_MS;
}

export function hourDurationMs(phase: Phase): number {
  return phase === "day" ? HOUR_MS_DAY : HOUR_MS_NIGHT;
}
