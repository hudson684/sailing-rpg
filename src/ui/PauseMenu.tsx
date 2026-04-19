import { useEffect, useState } from "react";
import { bus, type PauseMenuSlot, type PauseMenuState } from "../game/bus";
import { MANUAL_SLOT_IDS, type SaveEnvelope, type SlotId } from "../game/save";
import { useSettingsStore, type MobileMode } from "../game/store/settingsStore";
import "./PauseMenu.css";

const EMPTY_STATE: PauseMenuState = { visible: false, slots: [] };

const SLOT_ORDER: readonly SlotId[] = [
  ...MANUAL_SLOT_IDS,
  "autosave",
  "quicksave",
];

export function PauseMenu() {
  const [state, setState] = useState<PauseMenuState>(EMPTY_STATE);

  useEffect(() => {
    const onUpdate = (next: PauseMenuState) => setState(next);
    bus.onTyped("pause:update", onUpdate);
    bus.emitTyped("save:request", { type: "refresh" });
    return () => {
      bus.offTyped("pause:update", onUpdate);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      bus.emitTyped("pause:toggle");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!state.visible) return null;

  const bySlot = new Map(state.slots.map((s) => [s.slot, s] as const));
  const rows = SLOT_ORDER.map((slot) => bySlot.get(slot) ?? { slot, envelope: null });

  const resume = () => bus.emitTyped("pause:toggle");
  const newGame = () => {
    if (!confirm("Start a new game? Unsaved progress will be lost.")) return;
    bus.emitTyped("save:request", { type: "newGame" });
  };

  return (
    <div className="pause-backdrop" role="dialog" aria-modal="true" aria-label="Pause menu">
      <div className="px-panel pause-panel">
        <div className="px-header pause-header">
          <span className="px-header-title">Paused</span>
          <button className="px-close" onClick={resume} aria-label="Resume">×</button>
        </div>
        <div className="pause-slots">
          {rows.map((row) => (
            <SlotRow key={row.slot} row={row} />
          ))}
        </div>
        <MobileModeRow />
        <div className="pause-actions">
          <button className="px-btn px-btn-green" onClick={resume}>Resume</button>
          <button
            className="px-btn px-btn-orange"
            onClick={() => {
              bus.emitTyped("pause:toggle");
              window.dispatchEvent(new CustomEvent("character:open"));
            }}
          >
            Customize
          </button>
          <button className="px-btn px-btn-red" onClick={newGame}>New Game</button>
          {import.meta.env.DEV && (
            <button
              className="px-btn px-btn-grey"
              onClick={() => {
                bus.emitTyped("player:resetSpawn");
                bus.emitTyped("pause:toggle");
              }}
            >
              Reset to Spawn
            </button>
          )}
        </div>
        <div className="px-footer">ESC: toggle · F5: quicksave · F9: quickload</div>
      </div>
    </div>
  );
}

function MobileModeRow() {
  const mode = useSettingsStore((s) => s.mobileMode);
  const setMobileMode = useSettingsStore((s) => s.setMobileMode);
  const options: { value: MobileMode; label: string }[] = [
    { value: "auto", label: "Auto" },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];
  return (
    <div className="pause-mobile-row">
      <div className="pause-mobile-label">Touch Controls</div>
      <div className="pause-mobile-options">
        {options.map((opt) => (
          <button
            key={opt.value}
            className={`px-btn ${mode === opt.value ? "px-btn-green" : "px-btn-grey"}`}
            onClick={() => setMobileMode(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SlotRow({ row }: { row: PauseMenuSlot }) {
  const { slot, envelope } = row;
  const label = slotLabel(slot);
  const canSave = slot !== "autosave";
  const canLoad = envelope !== null;
  const canDelete = envelope !== null;

  const onSave = () => bus.emitTyped("save:request", { type: "save", slot });
  const onLoad = () => bus.emitTyped("save:request", { type: "load", slot });
  const onDelete = () => {
    if (!confirm(`Delete ${label}?`)) return;
    bus.emitTyped("save:request", { type: "delete", slot });
  };

  return (
    <div className="pause-slot">
      <div className="pause-slot-label">{label}</div>
      <div className="pause-slot-meta">
        {envelope ? <SlotMeta env={envelope} /> : <span className="pause-empty">— empty —</span>}
      </div>
      <div className="pause-slot-actions">
        <button className="px-btn px-btn-grey" disabled={!canSave} onClick={onSave}>Save</button>
        <button className="px-btn px-btn-blue" disabled={!canLoad} onClick={onLoad}>Load</button>
        <button className="px-btn px-btn-red" disabled={!canDelete} onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

function SlotMeta({ env }: { env: SaveEnvelope }) {
  return (
    <>
      <span className="pause-scene">{env.sceneKey}</span>
      <span className="pause-dot">·</span>
      <span>{formatPlaytime(env.playtimeMs)}</span>
      <span className="pause-dot">·</span>
      <span className="pause-time">{formatTimestamp(env.updatedAt)}</span>
    </>
  );
}

function slotLabel(slot: SlotId): string {
  if (slot === "autosave") return "Autosave";
  if (slot === "quicksave") return "Quicksave";
  return `Slot ${slot.replace("slot", "")}`;
}

function formatPlaytime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mo}-${dd} ${hh}:${mm}`;
}
