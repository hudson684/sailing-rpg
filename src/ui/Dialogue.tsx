import { useEffect, useState } from "react";
import { bus, type DialogueState } from "../game/bus";
import { useShopStore } from "../game/store/shopStore";
import "./Dialogue.css";

function requestOpenShop(shopId: string) {
  useShopStore.getState().openShop(shopId);
  bus.emitTyped("shop:open", { shopId });
  bus.emitTyped("dialogue:action", { type: "close" });
}

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
    const choices = state.choices;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      // Number keys pick a choice when one is showing. Ignored otherwise so
      // they don't accidentally fire on plain dialogue.
      if (choices && choices.length > 0 && e.key >= "1" && e.key <= "9") {
        const index = Number(e.key) - 1;
        if (index < choices.length) {
          e.preventDefault();
          bus.emitTyped("dialogue:action", { type: "select", index });
          return;
        }
      }
      if (e.key === "e" || e.key === "E" || e.key === " " || e.key === "Enter") {
        e.preventDefault();
        bus.emitTyped("dialogue:action", { type: "advance" });
      } else if (e.key === "Escape") {
        e.preventDefault();
        bus.emitTyped("dialogue:action", { type: "close" });
      } else if ((e.key === "t" || e.key === "T") && state.shopId) {
        e.preventDefault();
        requestOpenShop(state.shopId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.visible, state.shopId, state.choices]);

  if (!state.visible) return null;

  const page = state.pages[state.page] ?? "";
  const isLast = state.page >= state.pages.length - 1;
  const choices = state.choices;
  const hasChoices = isLast && choices && choices.length > 0;
  const onAdvance = () => {
    // Choices block advance — clicking the panel during a choice prompt
    // shouldn't accidentally close the cutscene mid-decision.
    if (hasChoices) return;
    bus.emitTyped("dialogue:action", { type: "advance" });
  };
  const onClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    bus.emitTyped("dialogue:action", { type: "close" });
  };
  const onTrade = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state.shopId) requestOpenShop(state.shopId);
  };
  const onChoice = (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    bus.emitTyped("dialogue:action", { type: "select", index });
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
        {hasChoices && (
          <div className="dialogue-options">
            {choices!.map((c, i) => (
              <button
                key={`${i}-${c.label}`}
                type="button"
                className="px-btn px-btn-orange"
                onClick={(e) => onChoice(e, i)}
              >
                {i + 1}. {c.label}
              </button>
            ))}
          </div>
        )}
        {!hasChoices && state.shopId && (
          <div className="dialogue-options">
            <button type="button" className="px-btn px-btn-orange" onClick={onTrade}>
              Trade (T)
            </button>
          </div>
        )}
        <div className="px-footer dialogue-footer">
          <span>
            {hasChoices
              ? "1-9 — choose · Esc — close"
              : `${isLast ? "E / Space — close" : "E / Space — next"} · Esc — close`}
          </span>
          <span className="dialogue-progress">
            {state.page + 1} / {state.pages.length}
          </span>
        </div>
      </div>
    </div>
  );
}
