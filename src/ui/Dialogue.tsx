import { useEffect, useState } from "react";
import { bus, type DialogueState } from "../game/bus";
import "./Dialogue.css";

const EMPTY: DialogueState = { visible: false, speaker: "", pages: [], page: 0 };

export function Dialogue() {
  const [state, setState] = useState<DialogueState>(EMPTY);

  useEffect(() => {
    const onUpdate = (next: DialogueState) => setState(next);
    bus.onTyped("dialogue:update", onUpdate);
    return () => {
      bus.offTyped("dialogue:update", onUpdate);
    };
  }, []);

  useEffect(() => {
    if (!state.visible) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      if (e.key === "e" || e.key === "E" || e.key === " " || e.key === "Enter") {
        e.preventDefault();
        bus.emitTyped("dialogue:action", { type: "advance" });
      } else if (e.key === "Escape") {
        e.preventDefault();
        bus.emitTyped("dialogue:action", { type: "close" });
      } else if ((e.key === "t" || e.key === "T") && state.shopId) {
        e.preventDefault();
        bus.emitTyped("dialogue:action", { type: "openShop" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.visible, state.shopId]);

  if (!state.visible) return null;

  const page = state.pages[state.page] ?? "";
  const isLast = state.page >= state.pages.length - 1;
  const onAdvance = () => bus.emitTyped("dialogue:action", { type: "advance" });
  const onClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    bus.emitTyped("dialogue:action", { type: "close" });
  };
  const onTrade = (e: React.MouseEvent) => {
    e.stopPropagation();
    bus.emitTyped("dialogue:action", { type: "openShop" });
  };

  return (
    <div className="dialogue-root">
      <div
        className="px-panel dialogue-box"
        onClick={onAdvance}
        role="dialog"
        aria-label={`Dialogue: ${state.speaker}`}
      >
        <div className="px-header">
          <span className="px-header-title">{state.speaker}</span>
          <button className="px-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="dialogue-text">{page}</div>
        {state.shopId && (
          <div className="dialogue-options">
            <button type="button" className="px-btn px-btn-orange" onClick={onTrade}>
              Trade (T)
            </button>
          </div>
        )}
        <div className="px-footer dialogue-footer">
          <span>
            {isLast ? "E / Space — close" : "E / Space — next"} · Esc — close
          </span>
          <span className="dialogue-progress">
            {state.page + 1} / {state.pages.length}
          </span>
        </div>
      </div>
    </div>
  );
}
