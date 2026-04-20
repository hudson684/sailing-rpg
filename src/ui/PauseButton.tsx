import { useCallback } from "react";
import { bus } from "../game/bus";
import "./PauseButton.css";

/**
 * Top-right menu button that opens the pause menu. Always visible while
 * the game is in-session — independent of whether touch controls are on,
 * so turning touch controls off can't lock the user out of the menu.
 */
export function PauseButton() {
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.classList.add("pause-btn-active");
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.classList.remove("pause-btn-active");
  }, []);
  const onClick = useCallback(() => {
    bus.emitTyped("pause:toggle");
  }, []);
  return (
    <button
      type="button"
      className="pause-btn"
      aria-label="Pause"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerUp}
      onClick={onClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="pause-btn-label">☰</span>
    </button>
  );
}
