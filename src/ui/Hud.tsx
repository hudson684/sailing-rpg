import type { HudState } from "../game/bus";
import { selectHud, selectToasts, useUIStore } from "./store/uiStore";
import "./Hud.css";

export function Hud() {
  const state = useUIStore(selectHud);
  const toasts = useUIStore(selectToasts);

  const headingDeg = ((state.heading * 180) / Math.PI + 360) % 360;
  const compass = compassLabel(headingDeg);

  return (
    <div className="hud">
      <div className="hud-top">
        <div className="hud-panel">
          <div className="hud-label">Mode</div>
          <div className="hud-value">{modeLabel(state.mode)}</div>
        </div>
        <div className="hud-panel">
          <div className="hud-label">Speed</div>
          <div className="hud-value">{state.speed} kt</div>
        </div>
        <div className="hud-panel">
          <div className="hud-label">Heading</div>
          <div className="hud-value">
            {Math.round(headingDeg)}° {compass}
          </div>
        </div>
      </div>

      {state.prompt && <div className="hud-prompt">{state.prompt}</div>}

      {toasts.length > 0 && (
        <div className="hud-toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`hud-toast hud-toast-${t.kind}`}>
              {t.text}
            </div>
          ))}
        </div>
      )}

      <div className="hud-controls">
        <span>WASD / Arrows — move or steer</span>
        <span>E — interact / take helm / drop anchor</span>
      </div>
    </div>
  );
}

function modeLabel(m: HudState["mode"]): string {
  switch (m) {
    case "OnFoot":
      return "On foot";
    case "OnDeck":
      return "On deck";
    case "AtHelm":
      return "At the helm";
    case "Anchoring":
      return "Anchoring…";
    case "Boarding":
      return "Boarding";
  }
}

function compassLabel(deg: number): string {
  // Phaser angles: 0° = east. Convert to traditional compass (0° = north).
  const compassDeg = (deg + 90) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(compassDeg / 45) % 8;
  return dirs[idx];
}
