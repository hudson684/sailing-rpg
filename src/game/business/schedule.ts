/**
 * Business open/close schedule helpers.
 *
 * A schedule has an `openMinute` and `closeMinute` (minute-of-day in
 * [0, 1440)). When `closeMinute < openMinute` the window wraps past
 * midnight — e.g. tavern 600/120 means open 10:00 through 02:00 next day.
 *
 * Three derived predicates drive the sim:
 *   • `isOpen` — the business is in its open window. Used for sign / SFX /
 *      door-locked branches if those ever exist.
 *   • `isAcceptingCustomers` — open AND not within the last STAFF_BUFFER_MIN
 *      in-game minutes. CustomerSim spawn loop and idle-sim hourly revenue
 *      both gate on this so revenue trails off cleanly toward closing.
 *   • `isStaffPresent` — staff should be inside (or arriving). True from
 *      `openMinute - STAFF_BUFFER_MIN` through `closeMinute`. The interior
 *      scene seeds staff based on this; CustomerSim drives door transitions
 *      when this flips at runtime.
 */

import type { BusinessSchedule } from "./businessTypes";
import { minuteOfDay, MINUTES_PER_DAY, type Phase } from "../time/constants";

/** In-game minutes between staff arrival and customer arrival (and between
 *  the spawn cutoff and close). */
export const STAFF_BUFFER_MIN = 20;

export interface ScheduleStatus {
  /** Within the open window (regardless of staff arrival buffer). */
  open: boolean;
  /** Open AND not in the closing soft-cutoff buffer. */
  acceptingCustomers: boolean;
  /** Staff should be present — either arriving (pre-open buffer) or open. */
  staffPresent: boolean;
}

/** Return true iff `minute` is within the (possibly midnight-wrapping)
 *  inclusive-start, exclusive-end window from `start` to `end`. A zero-
 *  width window (start === end) is treated as always-open. */
export function inMinuteWindow(minute: number, start: number, end: number): boolean {
  const m = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const s = ((start % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const e = ((end % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (s === e) return true;
  if (s < e) return m >= s && m < e;
  return m >= s || m < e;
}

export function getScheduleStatus(
  schedule: BusinessSchedule | undefined,
  minute: number,
): ScheduleStatus {
  if (!schedule) {
    return { open: true, acceptingCustomers: true, staffPresent: true };
  }
  const { openMinute, closeMinute } = schedule;
  const open = inMinuteWindow(minute, openMinute, closeMinute);
  const acceptingCustomers = inMinuteWindow(
    minute,
    openMinute,
    closeMinute - STAFF_BUFFER_MIN,
  );
  const staffPresent = inMinuteWindow(
    minute,
    openMinute - STAFF_BUFFER_MIN,
    closeMinute,
  );
  return { open, acceptingCustomers, staffPresent };
}

/** Convenience: status from current time-store inputs. */
export function statusForPhase(
  schedule: BusinessSchedule | undefined,
  phase: Phase,
  elapsedInPhaseMs: number,
): ScheduleStatus {
  return getScheduleStatus(schedule, minuteOfDay(phase, elapsedInPhaseMs));
}

/** Fraction of an in-game window starting at `startMinute` and lasting
 *  `windowMinutes` during which the business is accepting customers. Used
 *  by the idle simulation to prorate revenue across partial open windows.
 *
 *  Sampled at the schedule's natural 10-min resolution (same as the
 *  spawn-cutoff buffer) so transitions land cleanly. For windows of 10 min
 *  or less, this is effectively a single midpoint check (binary). */
export function acceptanceFractionForWindow(
  schedule: BusinessSchedule | undefined,
  startMinute: number,
  windowMinutes: number,
): number {
  if (!schedule) return 1;
  if (windowMinutes <= 0) return 0;
  const samples = Math.max(1, Math.round(windowMinutes / 10));
  let inWindow = 0;
  for (let i = 0; i < samples; i++) {
    const m = startMinute + (i + 0.5) * (windowMinutes / samples);
    if (getScheduleStatus(schedule, m).acceptingCustomers) inWindow += 1;
  }
  return inWindow / samples;
}
