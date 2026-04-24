import { useEffect, useState } from "react";
import { selectHud, selectToasts, useUIStore } from "./store/uiStore";
import { computeMaxHp, selectJobXp, useGameStore } from "../game/store/gameStore";
import { Hotbar } from "./Hotbar";
import { useIsMobile, useIsPortrait } from "./mobile/useMobile";
import { bus } from "../game/bus";
import { JOBS, type JobId } from "../game/jobs/jobs";
import {
  MAX_LEVEL,
  levelFromXp,
  xpInCurrentLevel,
  xpToNextLevel,
} from "../game/jobs/xpTable";
import heartIcon from "./icons/hud/hud_heart.png";
import inventoryIcon from "./icons/hud/hud_inventory.png";
import "./Hud.css";

export function Hud() {
  const state = useUIStore(selectHud);
  const toasts = useUIStore(selectToasts);
  const hpCurrent = useGameStore((s) => s.health.current);
  const equipped = useGameStore((s) => s.equipment.equipped);
  const hpMax = computeMaxHp(equipped);
  const isMobile = useIsMobile();
  const isPortrait = useIsPortrait();

  const pct = hpMax > 0 ? Math.max(0, Math.min(1, hpCurrent / hpMax)) : 0;
  const stamina = state.stamina;
  const staminaMax = state.staminaMax;
  const staminaPct =
    staminaMax > 0 ? Math.max(0, Math.min(1, stamina / staminaMax)) : 0;

  const hudScale = isMobile && !isPortrait ? 2 : 3;

  return (
    <div
      className="hud"
      style={{ ["--hud-scale" as string]: hudScale }}
    >
      <div className="hud-health" role="status" aria-label={`Health ${hpCurrent} of ${hpMax}`}>
        <img className="hud-health-icon" src={heartIcon} alt="" aria-hidden="true" />
        <div className="hud-health-bar">
          <div className="hud-health-fill" style={{ width: `${pct * 100}%` }} />
          <div className="hud-health-text">{hpCurrent} / {hpMax}</div>
        </div>
      </div>

      <div
        className="hud-stamina"
        role="status"
        aria-label={`Stamina ${stamina} of ${staminaMax}`}
      >
        <div className="hud-stamina-icon" aria-hidden="true" />
        <div className="hud-stamina-bar">
          <div className="hud-stamina-fill" style={{ width: `${staminaPct * 100}%` }} />
          <div className="hud-stamina-text">{stamina} / {staminaMax}</div>
        </div>
      </div>

      <Hotbar variant="hud" scale={hudScale} />
      <button
        type="button"
        className="hud-inventory-btn"
        style={{ ["--hotbar-scale" as string]: hudScale }}
        aria-label="Open inventory"
        onPointerDown={(e) => e.currentTarget.classList.add("is-active")}
        onPointerUp={(e) => e.currentTarget.classList.remove("is-active")}
        onPointerCancel={(e) => e.currentTarget.classList.remove("is-active")}
        onPointerLeave={(e) => e.currentTarget.classList.remove("is-active")}
        onClick={() => window.dispatchEvent(new CustomEvent("inventory:toggle"))}
        onContextMenu={(e) => e.preventDefault()}
      >
        <img className="hud-inventory-btn-label" src={inventoryIcon} alt="" aria-hidden="true" />
      </button>

      <XpRing />

      <SailingIndicator />

      {state.prompt && <div className="px-panel hud-prompt">{state.prompt}</div>}

      {toasts.length > 0 && (
        <div className="hud-toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`px-panel hud-toast hud-toast-${t.kind}`}>
              {t.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Compass-rose wind indicator + speed bar. Renders only while the HUD is
 *  in a sailing mode (WorldScene emits `wind` and `shipMaxSpeed` as non-null
 *  exactly when the player is AtHelm or Anchoring). The arrow points in the
 *  wind's travel direction — i.e. where the wind is *pushing* the ship —
 *  which is how a telltale or flag reads, not the aviation "from" convention.
 */
function SailingIndicator() {
  const state = useUIStore(selectHud);
  const wind = state.wind;
  const maxSpeed = state.shipMaxSpeed;
  if (!wind || !maxSpeed) return null;

  const speedPct = Math.max(0, Math.min(1, state.speed / maxSpeed));
  // Convert wind angle (radians, 0 = east, screen-space +y = south) to CSS
  // degrees. The SVG arrow is drawn pointing east at 0°, so a raw rad→deg
  // conversion lines up — no offset needed.
  const arrowDeg = (wind.angle * 180) / Math.PI;
  // Strength drives arrow opacity/length so a weak wind reads differently
  // from a strong one at a glance.
  const strength = Math.max(0, Math.min(1, wind.strength));
  // Visual length scales within a reasonable band so a near-calm wind is
  // still legible instead of invisible.
  const arrowLen = 10 + strength * 14;

  return (
    <div className="hud-sailing" role="status" aria-label="Sailing">
      <div
        className="hud-sailing-compass"
        aria-label={`Wind strength ${Math.round(strength * 100)}%`}
      >
        <svg viewBox="-24 -24 48 48" aria-hidden="true">
          <circle className="hud-sailing-compass-ring" cx="0" cy="0" r="20" />
          <line className="hud-sailing-compass-axis" x1="-16" y1="0" x2="16" y2="0" />
          <line className="hud-sailing-compass-axis" x1="0" y1="-16" x2="0" y2="16" />
          <g transform={`rotate(${arrowDeg})`}>
            <line
              className="hud-sailing-compass-arrow"
              x1={-arrowLen * 0.4}
              y1="0"
              x2={arrowLen}
              y2="0"
              style={{ opacity: 0.4 + strength * 0.6 }}
            />
            <polygon
              className="hud-sailing-compass-head"
              points={`${arrowLen},0 ${arrowLen - 6},-4 ${arrowLen - 6},4`}
              style={{ opacity: 0.4 + strength * 0.6 }}
            />
          </g>
        </svg>
      </div>
      <div className="hud-sailing-speed" aria-label={`Speed ${state.speed}`}>
        <div className="hud-sailing-speed-bar">
          <div
            className="hud-sailing-speed-fill"
            style={{ width: `${speedPct * 100}%` }}
          />
        </div>
        <div className="hud-sailing-speed-text">{state.speed} kt</div>
      </div>
    </div>
  );
}

function XpRing() {
  const xpByJob = useGameStore(selectJobXp);
  const [lastJob, setLastJob] = useState<JobId | null>(null);

  useEffect(() => {
    const onXp = ({ jobId }: { jobId: JobId; amount: number }) => setLastJob(jobId);
    bus.onTyped("jobs:xpGained", onXp);
    return () => {
      bus.offTyped("jobs:xpGained", onXp);
    };
  }, []);

  if (!lastJob) return null;
  const def = JOBS[lastJob];
  const totalXp = xpByJob[lastJob] ?? 0;
  const level = levelFromXp(totalXp);
  const atMax = level >= MAX_LEVEL;
  const intoLevel = atMax ? 0 : xpInCurrentLevel(totalXp, level);
  const needed = atMax ? 1 : xpToNextLevel(level);
  const pct = atMax ? 1 : Math.max(0, Math.min(1, intoLevel / needed));
  const R = 22;
  const C = 2 * Math.PI * R;

  return (
    <div
      className="hud-xp-ring"
      role="status"
      aria-label={`${def.name} level ${level}, ${Math.round(pct * 100)}% to next`}
      title={`${def.name} Lv ${level} — ${intoLevel} / ${needed} XP`}
    >
      <svg className="hud-xp-ring-svg" viewBox="0 0 52 52" aria-hidden="true">
        <circle className="hud-xp-ring-track" cx="26" cy="26" r={R} />
        <circle
          className="hud-xp-ring-fill"
          cx="26"
          cy="26"
          r={R}
          stroke={def.color}
          strokeDasharray={`${C * pct} ${C}`}
        />
      </svg>
      <img className="hud-xp-ring-icon" src={def.icon} alt="" draggable={false} />
      <span className="hud-xp-ring-level">{level}</span>
    </div>
  );
}
