import { useCallback, useEffect, useRef, useState } from "react";
import { bus } from "../../game/bus";
import { dispatchVirtualKey, type VirtualKey } from "../../game/input/virtualInput";
import { useUIStore } from "../store/uiStore";
import "./TouchControls.css";

interface Props {
  visible: boolean;
}

export function TouchControls({ visible }: Props) {
  const mode = useUIStore((s) => s.hud.mode);
  if (!visible) return null;

  const atHelm = mode === "AtHelm" || mode === "Anchoring";

  return (
    <div className="touch-controls" aria-hidden="true">
      <DragPad mode={atHelm ? "helm" : "walk"} />
      <PauseButton />
      {atHelm ? (
        <div className="touch-actions">
          <TouchButton vkey="helmThrottleUp" className="touch-action touch-action-q" label="Q" />
          <TouchButton vkey="helmThrottleDown" className="touch-action touch-action-e" label="E" />
          <TouchButton vkey="helmAnchor" className="touch-action touch-action-sprint" label="⚓" />
        </div>
      ) : (
        <div className="touch-actions">
          <TouchButton vkey="attack" className="touch-action touch-action-q" label="Q" />
          <TouchButton vkey="interact" className="touch-action touch-action-e" label="E" />
          <TouchButton vkey="sprint" className="touch-action touch-action-sprint" label="⇧" />
        </div>
      )}
    </div>
  );
}

function PauseButton() {
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.classList.add("touch-btn-active");
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.classList.remove("touch-btn-active");
  }, []);
  const onClick = useCallback(() => {
    bus.emitTyped("pause:toggle");
  }, []);
  return (
    <button
      type="button"
      className="touch-btn touch-pause"
      aria-label="Pause"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerUp}
      onClick={onClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="touch-btn-label">☰</span>
    </button>
  );
}

type DirKey4 = "up" | "down" | "left" | "right";
type DirKey = DirKey4; // superset in walk mode: same four keys, diagonals press two.

const WALK_KEYS: Record<DirKey4, VirtualKey> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
};
const HELM_KEYS: Record<DirKey4, VirtualKey> = {
  up: "helmN",
  right: "helmE",
  down: "helmS",
  left: "helmW",
};

/**
 * Compute the dir keys for the nearest compass direction (8 sectors;
 * diagonals press two cardinals). Same in walk and helm modes — the ship
 * now supports 8-directional movement, with diagonals producing a diagonal
 * velocity while the hull's visual still snaps to the nearest cardinal.
 */
function dirsFromVector(dx: number, dy: number): Set<DirKey> {
  const result = new Set<DirKey>();
  const angle = Math.atan2(-dy, dx); // 0 = right, +y up in math coords
  const two_pi = Math.PI * 2;
  const normalized = (angle + two_pi) % two_pi;
  const octant = Math.round(normalized / (Math.PI / 4)) % 8;
  switch (octant) {
    case 0: result.add("right"); break;
    case 1: result.add("up"); result.add("right"); break;
    case 2: result.add("up"); break;
    case 3: result.add("up"); result.add("left"); break;
    case 4: result.add("left"); break;
    case 5: result.add("down"); result.add("left"); break;
    case 6: result.add("down"); break;
    case 7: result.add("down"); result.add("right"); break;
  }
  return result;
}

function DragPad({ mode }: { mode: "walk" | "helm" }) {
  const baseRef = useRef<HTMLDivElement | null>(null);
  const activePointer = useRef<number | null>(null);
  const activeDirs = useRef<Set<DirKey>>(new Set());
  const centerRef = useRef<{ x: number; y: number } | null>(null);
  const modeRef = useRef(mode);
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);

  const vkeyFor = useCallback(
    (d: DirKey): VirtualKey =>
      (modeRef.current === "helm" ? HELM_KEYS : WALK_KEYS)[d],
    [],
  );

  const releaseAll = useCallback(() => {
    for (const k of activeDirs.current) dispatchVirtualKey(vkeyFor(k), false);
    activeDirs.current.clear();
  }, [vkeyFor]);

  const updateDirs = useCallback(
    (next: Set<DirKey>) => {
      const prev = activeDirs.current;
      for (const k of prev) if (!next.has(k)) dispatchVirtualKey(vkeyFor(k), false);
      for (const k of next) if (!prev.has(k)) dispatchVirtualKey(vkeyFor(k), true);
      activeDirs.current = next;
    },
    [vkeyFor],
  );

  // If the mode flips mid-drag (e.g. take helm / drop anchor while touching
  // the pad), release anything we were holding so we don't leave keys
  // pressed under the wrong mapping.
  useEffect(() => {
    if (modeRef.current === mode) return;
    releaseAll();
    modeRef.current = mode;
  }, [mode, releaseAll]);

  const handleMove = useCallback(
    (dx: number, dy: number) => {
      const el = baseRef.current;
      if (!el) return;
      const radius = el.clientWidth / 2;
      const deadzone = radius * 0.25;
      const mag = Math.hypot(dx, dy);
      if (mag < deadzone) {
        updateDirs(new Set());
        setKnob({ x: dx, y: dy });
        return;
      }
      const next = dirsFromVector(dx, dy);
      updateDirs(next);
      const max = radius;
      const scale = mag > max ? max / mag : 1;
      setKnob({ x: dx * scale, y: dy * scale });
    },
    [updateDirs],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activePointer.current !== null) return;
      const el = baseRef.current;
      if (!el) return;
      activePointer.current = e.pointerId;
      el.setPointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      centerRef.current = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      handleMove(e.clientX - centerRef.current.x, e.clientY - centerRef.current.y);
    },
    [handleMove],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activePointer.current !== e.pointerId) return;
      const c = centerRef.current;
      if (!c) return;
      handleMove(e.clientX - c.x, e.clientY - c.y);
    },
    [handleMove],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activePointer.current !== e.pointerId) return;
      activePointer.current = null;
      const el = baseRef.current;
      if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      releaseAll();
      setKnob(null);
      centerRef.current = null;
    },
    [releaseAll],
  );

  useEffect(() => releaseAll, [releaseAll]);

  return (
    <div
      ref={baseRef}
      className="touch-dragpad"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="touch-dragpad-ring" />
      <div
        className={`touch-dragpad-knob${knob ? " touch-dragpad-knob-active" : ""}`}
        style={knob ? { transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` } : undefined}
      />
    </div>
  );
}

interface TouchButtonProps {
  vkey: VirtualKey;
  className: string;
  label: string;
}

function TouchButton({ vkey, className, label }: TouchButtonProps) {
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
