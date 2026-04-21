import { selectHud, selectToasts, useUIStore } from "./store/uiStore";
import { computeMaxHp, useGameStore } from "../game/store/gameStore";
import { Hotbar } from "./Hotbar";
import { useIsMobile, useIsPortrait } from "./mobile/useMobile";
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
