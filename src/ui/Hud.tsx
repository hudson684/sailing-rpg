import { selectHud, selectToasts, useUIStore } from "./store/uiStore";
import { computeMaxHp, useGameStore } from "../game/store/gameStore";
import { Hotbar } from "./Hotbar";
import heartIcon from "./icons/hud/hud_heart.png";
import "./Hud.css";

export function Hud() {
  const state = useUIStore(selectHud);
  const toasts = useUIStore(selectToasts);
  const hpCurrent = useGameStore((s) => s.health.current);
  const equipped = useGameStore((s) => s.equipment.equipped);
  const hpMax = computeMaxHp(equipped);

  const pct = hpMax > 0 ? Math.max(0, Math.min(1, hpCurrent / hpMax)) : 0;

  return (
    <div className="hud">
      <div className="hud-health" role="status" aria-label={`Health ${hpCurrent} of ${hpMax}`}>
        <img className="hud-health-icon" src={heartIcon} alt="" aria-hidden="true" />
        <div className="hud-health-bar">
          <div className="hud-health-fill" style={{ width: `${pct * 100}%` }} />
          <div className="hud-health-text">{hpCurrent} / {hpMax}</div>
        </div>
      </div>

      <Hotbar variant="hud" />

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
