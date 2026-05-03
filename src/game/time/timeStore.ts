import { create } from "zustand";
import { bus } from "../bus";
import { calendarContextFor } from "../sim/calendar/calendar";
import {
  HOURS_PER_PHASE,
  TICKS_PER_HOUR,
  hourDurationMs,
  phaseDurationMs,
  tickDurationMs,
  type Phase,
} from "./constants";

const TICKS_PER_PHASE = HOURS_PER_PHASE * TICKS_PER_HOUR;


export interface TimeState {
  dayCount: number;
  phase: Phase;
  /** Real ms elapsed in the current phase. Persisted (not wallclock) so
   *  save/load resumes mid-phase without skipping ahead. */
  elapsedInPhaseMs: number;
  /** Sub-hour ticks already emitted this phase, 0..(HOURS_PER_PHASE*TICKS_PER_HOUR).
   *  Tracked to guarantee exactly that many `time:simTick` events per phase
   *  regardless of frame jitter. */
  ticksEmittedThisPhase: number;

  tick: (deltaMs: number) => void;
  /** Dev-only: skip forward (positive) or back (negative) by N in-game hours
   *  of the current phase. Forward goes through tick() so listeners fire;
   *  backward silently rewinds state without re-emitting past hour ticks. */
  devShiftHours: (hours: number) => void;
  setPaused: (paused: boolean) => void;
  reset: () => void;
  hydrate: (data: TimeSnapshot) => void;
  serialize: () => TimeSnapshot;
}

export interface TimeSnapshot {
  dayCount: number;
  phase: Phase;
  elapsedInPhaseMs: number;
  /** Optional: older saves predate this; `hydrate` recomputes from elapsed. */
  ticksEmittedThisPhase?: number;
  /** Legacy: older saves tracked hour-granularity emission. Ignored on load. */
  hoursEmittedThisPhase?: number;
  /** Legacy: replaced by `ticksEmittedThisPhase` (now 6/hour, was 4/hour). */
  quartersEmittedThisPhase?: number;
}

const INITIAL: Required<Pick<TimeSnapshot, "dayCount" | "phase" | "elapsedInPhaseMs" | "ticksEmittedThisPhase">> = {
  dayCount: 1,
  phase: "day",
  elapsedInPhaseMs: 0,
  ticksEmittedThisPhase: 0,
};

export const useTimeStore = create<TimeState & { paused: boolean }>(
  (set, get) => ({
    ...INITIAL,
    paused: false,

    tick: (deltaMs) => {
      if (deltaMs <= 0) return;
      if (get().paused) return;

      let { dayCount, phase, elapsedInPhaseMs, ticksEmittedThisPhase } = get();
      let remaining = deltaMs;

      while (remaining > 0) {
        const phaseLen = phaseDurationMs(phase);
        const tickLen = tickDurationMs(phase);
        const room = phaseLen - elapsedInPhaseMs;

        if (remaining < room) {
          elapsedInPhaseMs += remaining;
          remaining = 0;
        } else {
          elapsedInPhaseMs = phaseLen;
          remaining -= room;
        }

        // Emit any sub-hour tick boundaries we've crossed within this phase.
        const ticksDue = Math.min(
          TICKS_PER_PHASE,
          Math.floor(elapsedInPhaseMs / tickLen),
        );
        while (ticksEmittedThisPhase < ticksDue) {
          const tickIndex = ticksEmittedThisPhase;
          ticksEmittedThisPhase += 1;
          // Persist progress before emit so listeners see consistent state.
          set({ dayCount, phase, elapsedInPhaseMs, ticksEmittedThisPhase });
          bus.emitTyped("time:simTick", { dayCount, phase, tickIndex });
        }

        // Phase rollover.
        if (elapsedInPhaseMs >= phaseLen) {
          const nextPhase: Phase = phase === "day" ? "night" : "day";
          const crossedDayBoundary = phase === "night";
          if (crossedDayBoundary) dayCount += 1;
          phase = nextPhase;
          elapsedInPhaseMs = 0;
          ticksEmittedThisPhase = 0;
          set({ dayCount, phase, elapsedInPhaseMs, ticksEmittedThisPhase });
          if (crossedDayBoundary) {
            // Fires once per day boundary, before phaseChange so listeners
            // that reset daily counters do so before "new phase" handlers run.
            bus.emitTyped("time:midnight", {
              dayCount,
              calendar: calendarContextFor(dayCount),
            });
          }
          bus.emitTyped("time:phaseChange", { phase, dayCount });
        }
      }

      set({ dayCount, phase, elapsedInPhaseMs, ticksEmittedThisPhase });
    },

    devShiftHours: (hours) => {
      if (hours === 0) return;
      if (hours > 0) {
        get().tick(hourDurationMs(get().phase) * hours);
        return;
      }
      let { dayCount, phase, elapsedInPhaseMs } = get();
      let remainingMs = -hours * hourDurationMs(phase);
      while (remainingMs > 0) {
        if (elapsedInPhaseMs >= remainingMs) {
          elapsedInPhaseMs -= remainingMs;
          remainingMs = 0;
        } else {
          remainingMs -= elapsedInPhaseMs;
          const prevPhase: Phase = phase === "day" ? "night" : "day";
          if (phase === "day") dayCount = Math.max(1, dayCount - 1);
          phase = prevPhase;
          elapsedInPhaseMs = phaseDurationMs(phase);
        }
      }
      const ticksEmittedThisPhase = Math.min(
        TICKS_PER_PHASE,
        Math.floor(elapsedInPhaseMs / tickDurationMs(phase)),
      );
      set({ dayCount, phase, elapsedInPhaseMs, ticksEmittedThisPhase });
    },

    setPaused: (paused) => set({ paused }),

    reset: () => set({ ...INITIAL }),

    hydrate: (data) =>
      // The saved tick count is recomputed from `elapsedInPhaseMs` so the
      // 4-ticks/hour → 6-ticks/hour cadence change rehydrates cleanly. Older
      // `hoursEmittedThisPhase` / `quartersEmittedThisPhase` fields are
      // accepted in the snapshot type but ignored here.
      set({
        dayCount: data.dayCount,
        phase: data.phase,
        elapsedInPhaseMs: data.elapsedInPhaseMs,
        ticksEmittedThisPhase: Math.min(
          TICKS_PER_PHASE,
          Math.floor(data.elapsedInPhaseMs / tickDurationMs(data.phase)),
        ),
      }),

    serialize: () => {
      const { dayCount, phase, elapsedInPhaseMs, ticksEmittedThisPhase } = get();
      return { dayCount, phase, elapsedInPhaseMs, ticksEmittedThisPhase };
    },
  }),
);
