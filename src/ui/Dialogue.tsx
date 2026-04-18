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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.visible]);

  if (!state.visible) return null;

  const page = state.pages[state.page] ?? "";
  const isLast = state.page >= state.pages.length - 1;
  const onClick = () => bus.emitTyped("dialogue:action", { type: "advance" });

  return (
    <div className="dialogue-root">
      <div className="dialogue-box" onClick={onClick} role="dialog" aria-label={`Dialogue: ${state.speaker}`}>
        <div className="dialogue-speaker">{state.speaker}</div>
        <div className="dialogue-text">{page}</div>
        <div className="dialogue-footer">
          <span className="dialogue-hint">
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
