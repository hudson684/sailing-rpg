import { useTimeStore } from "../game/time/timeStore";
import { phaseDurationMs } from "../game/time/constants";
import {
  calendarContextFor,
  formatCalendarLine,
} from "../game/sim/calendar/calendar";
import "./Clock.css";

// In-game day starts at 06:00 and night at 18:00. Each phase covers 12
// clock-hours regardless of HOURS_PER_PHASE, so the tooltip reads as a
// familiar 24h time even if the phase tick rate changes.
const DAY_START_MIN = 6 * 60;
const NIGHT_START_MIN = 18 * 60;
const PHASE_SPAN_MIN = 12 * 60;

function formatClock(phase: "day" | "night", progress: number): string {
  const base = phase === "day" ? DAY_START_MIN : NIGHT_START_MIN;
  const total = (base + progress * PHASE_SPAN_MIN) % (24 * 60);
  const h = Math.floor(total / 60);
  const m = Math.floor(total % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export function Clock() {
  const phase = useTimeStore((s) => s.phase);
  const elapsed = useTimeStore((s) => s.elapsedInPhaseMs);
  const dayCount = useTimeStore((s) => s.dayCount);

  const total = phaseDurationMs(phase);
  const pct = total > 0 ? Math.max(0, Math.min(1, elapsed / total)) : 0;
  const time = formatClock(phase, pct);
  const calendar = calendarContextFor(dayCount);
  const label = import.meta.env.DEV
    ? `${formatCalendarLine(calendar)} · ${time}`
    : `Day ${dayCount} · ${time}`;

  return (
    <div
      className={`hud-clock hud-clock-${phase}`}
      role="status"
      aria-label={`Day ${dayCount}, ${phase}, ${time}`}
    >
      <div className="hud-clock-icon" aria-hidden="true">
        {phase === "day" ? "☀" : "☾"}
      </div>
      <div className="hud-clock-bar">
        <div className="hud-clock-fill" style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="hud-clock-tooltip" role="tooltip">{label}</div>
      {import.meta.env.DEV && (
        <div className="hud-clock-dev">
          <button
            type="button"
            className="hud-clock-dev-btn"
            aria-label="Skip forward one hour (dev)"
            title="+1h"
            onClick={() => useTimeStore.getState().devShiftHours(1)}
          >+</button>
        </div>
      )}
    </div>
  );
}
