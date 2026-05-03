import { create } from "zustand";
import { bus } from "../bus";
import { calendarContextFor } from "../sim/calendar/calendar";
import {
  HOURS_PER_PHASE,
  hourDurationMs,
  phaseDurationMs,
  type Phase,
} from "./constants";

export interface TimeState {
  dayCount: number;
  phase: Phase;
  /** Real ms elapsed in the current phase. Persisted (not wallclock) so
   *  save/load resumes mid-phase without skipping ahead. */
  elapsedInPhaseMs: number;
  /** Hours already emitted this phase, 0..HOURS_PER_PHASE. Tracked to
   *  guarantee exactly HOURS_PER_PHASE hourTicks per phase regardless of
   *  frame jitter. */
  hoursEmittedThisPhase: number;
  /** Quarter-hours already emitted this phase, 0..(HOURS_PER_PHASE*4). */
  quartersEmittedThisPhase: number;

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
  hoursEmittedThisPhase: number;
  /** Optional: older saves predate this; `hydrate` recomputes from elapsed. */
  quartersEmittedThisPhase?: number;
}

const INITIAL: Required<TimeSnapshot> = {
  dayCount: 1,
  phase: "day",
  elapsedInPhaseMs: 0,
  hoursEmittedThisPhase: 0,
  quartersEmittedThisPhase: 0,
};

export const useTimeStore = create<TimeState & { paused: boolean }>(
  (set, get) => ({
    ...INITIAL,
    paused: false,

    tick: (deltaMs) => {
      if (deltaMs <= 0) return;
      if (get().paused) return;

      let { dayCount, phase, elapsedInPhaseMs, hoursEmittedThisPhase, quartersEmittedThisPhase } = get();
      let remaining = deltaMs;

      while (remaining > 0) {
        const phaseLen = phaseDurationMs(phase);
        const hourLen = hourDurationMs(phase);
        const quarterLen = hourLen / 4;
        const room = phaseLen - elapsedInPhaseMs;

        if (remaining < room) {
          elapsedInPhaseMs += remaining;
          remaining = 0;
        } else {
          elapsedInPhaseMs = phaseLen;
          remaining -= room;
        }

        // Emit any hour boundaries we've crossed within this phase.
        const hoursDue = Math.min(
          HOURS_PER_PHASE,
          Math.floor(elapsedInPhaseMs / hourLen),
        );
        while (hoursEmittedThisPhase < hoursDue) {
          const hourIndex = hoursEmittedThisPhase;
          hoursEmittedThisPhase += 1;
          // Persist progress before emit so listeners see consistent state.
          set({ dayCount, phase, elapsedInPhaseMs, hoursEmittedThisPhase, quartersEmittedThisPhase });
          bus.emitTyped("time:hourTick", { dayCount, phase, hourIndex });
        }

        // Emit any quarter-hour boundaries we've crossed within this phase.
        // Fired after hour ticks so subscribers that want true sub-hour cadence
        // see exactly one quarter event per quarter; hour-aligned subscribers
        // can keep using `time:hourTick` and ignore these.
        const quartersDue = Math.min(
          HOURS_PER_PHASE * 4,
          Math.floor(elapsedInPhaseMs / quarterLen),
        );
        while (quartersEmittedThisPhase < quartersDue) {
          const quarterIndex = quartersEmittedThisPhase;
          quartersEmittedThisPhase += 1;
          set({ dayCount, phase, elapsedInPhaseMs, hoursEmittedThisPhase, quartersEmittedThisPhase });
          bus.emitTyped("time:quarterHourTick", { dayCount, phase, quarterIndex });
        }

        // Phase rollover.
        if (elapsedInPhaseMs >= phaseLen) {
          const nextPhase: Phase = phase === "day" ? "night" : "day";
          const crossedDayBoundary = phase === "night";
          if (crossedDayBoundary) dayCount += 1;
          phase = nextPhase;
          elapsedInPhaseMs = 0;
          hoursEmittedThisPhase = 0;
          quartersEmittedThisPhase = 0;
          set({ dayCount, phase, elapsedInPhaseMs, hoursEmittedThisPhase, quartersEmittedThisPhase });
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

      set({ dayCount, phase, elapsedInPhaseMs, hoursEmittedThisPhase, quartersEmittedThisPhase });
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
      const hourLen = hourDurationMs(phase);
      const hoursEmittedThisPhase = Math.min(
        HOURS_PER_PHASE,
        Math.floor(elapsedInPhaseMs / hourLen),
      );
      const quartersEmittedThisPhase = Math.min(
        HOURS_PER_PHASE * 4,
        Math.floor(elapsedInPhaseMs / (hourLen / 4)),
      );
      set({ dayCount, phase, elapsedInPhaseMs, hoursEmittedThisPhase, quartersEmittedThisPhase });
    },

    setPaused: (paused) => set({ paused }),

    reset: () => set({ ...INITIAL }),

    hydrate: (data) =>
      set({
        dayCount: data.dayCount,
        phase: data.phase,
        elapsedInPhaseMs: data.elapsedInPhaseMs,
        hoursEmittedThisPhase: data.hoursEmittedThisPhase,
        // Older saves predate quarter-hour tracking; recompute from elapsed.
        quartersEmittedThisPhase:
          data.quartersEmittedThisPhase ??
          Math.min(
            HOURS_PER_PHASE * 4,
            Math.floor(
              data.elapsedInPhaseMs / (hourDurationMs(data.phase) / 4),
            ),
          ),
      }),

    serialize: () => {
      const {
        dayCount,
        phase,
        elapsedInPhaseMs,
        hoursEmittedThisPhase,
        quartersEmittedThisPhase,
      } = get();
      return {
        dayCount,
        phase,
        elapsedInPhaseMs,
        hoursEmittedThisPhase,
        quartersEmittedThisPhase,
      };
    },
  }),
);
