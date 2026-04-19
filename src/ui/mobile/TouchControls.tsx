import { useCallback, useRef } from "react";
import { dispatchVirtualKey, type VirtualKey } from "../../game/input/virtualInput";
import "./TouchControls.css";

interface Props {
  visible: boolean;
}

export function TouchControls({ visible }: Props) {
  if (!visible) return null;

  return (
    <div className="touch-controls" aria-hidden="true">
      <div className="touch-dpad">
        <TouchButton vkey="up" className="touch-dpad-up" label="▲" />
        <TouchButton vkey="left" className="touch-dpad-left" label="◀" />
        <TouchButton vkey="right" className="touch-dpad-right" label="▶" />
        <TouchButton vkey="down" className="touch-dpad-down" label="▼" />
      </div>
      <div className="touch-actions">
        <TouchButton vkey="attack" className="touch-action touch-action-q" label="Q" />
        <TouchButton vkey="interact" className="touch-action touch-action-e" label="E" />
        <TouchButton vkey="sprint" className="touch-action touch-action-sprint" label="⇧" />
      </div>
    </div>
  );
}

interface TouchButtonProps {
  vkey: VirtualKey;
  className: string;
  label: string;
}

function TouchButton({ vkey, className, label }: TouchButtonProps) {
  // Track active pointer so we always release, even if the finger slides
  // off the button. Use pointer capture so the move/up events keep coming
  // to this element after a slight drag.
  const activePointer = useRef<number | null>(null);

  const press = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (activePointer.current !== null) return;
      activePointer.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.classList.add("touch-btn-active");
      dispatchVirtualKey(vkey, true);
    },
    [vkey],
  );

  const release = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (activePointer.current !== e.pointerId) return;
      activePointer.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      e.currentTarget.classList.remove("touch-btn-active");
      dispatchVirtualKey(vkey, false);
    },
    [vkey],
  );

  return (
    <button
      type="button"
      className={`touch-btn ${className}`}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="touch-btn-label">{label}</span>
    </button>
  );
}
