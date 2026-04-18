import { useEffect, useState } from "react";
import { bus } from "../game/bus";
import { ITEMS } from "../game/inventory/items";
import type { Slot } from "../game/inventory/types";
import { selectInventorySlots, useGameStore } from "../game/store/gameStore";
import "./Inventory.css";

const DRAG_MIME = "application/x-sailing-rpg-slot";

export function Inventory() {
  const slots = useGameStore(selectInventorySlots);
  const [open, setOpen] = useState(true);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [hoverTo, setHoverTo] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "i") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) {
    return <div className="inv-toggle-hint">Press I for inventory</div>;
  }

  const handleDrop = (to: number) => {
    if (dragFrom === null || dragFrom === to) return;
    bus.emitTyped("inventory:action", { type: "move", from: dragFrom, to });
  };

  return (
    <div className="inv-panel" role="region" aria-label="Inventory">
      <div className="inv-header">
        <span>Inventory</span>
        <button className="inv-close" onClick={() => setOpen(false)} aria-label="Close inventory">
          ×
        </button>
      </div>
      <div className="inv-grid">
        {slots.map((slot, i) => (
          <SlotCell
            key={i}
            index={i}
            slot={slot}
            isDragging={dragFrom === i}
            isHoverTarget={hoverTo === i && dragFrom !== null && dragFrom !== i}
            onDragStart={() => setDragFrom(i)}
            onDragEnd={() => {
              setDragFrom(null);
              setHoverTo(null);
            }}
            onDragEnter={() => setHoverTo(i)}
            onDragLeave={() => setHoverTo((cur) => (cur === i ? null : cur))}
            onDrop={() => handleDrop(i)}
          />
        ))}
      </div>
      <div className="inv-footer">G: grant debug item · I: toggle</div>
    </div>
  );
}

interface SlotCellProps {
  index: number;
  slot: Slot | null;
  isDragging: boolean;
  isHoverTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
}

function SlotCell(props: SlotCellProps) {
  const {
    index,
    slot,
    isDragging,
    isHoverTarget,
    onDragStart,
    onDragEnd,
    onDragEnter,
    onDragLeave,
    onDrop,
  } = props;
  const def = slot ? ITEMS[slot.itemId] : null;

  return (
    <div
      className={
        "inv-slot" +
        (slot ? " inv-slot-filled" : "") +
        (isDragging ? " inv-slot-dragging" : "") +
        (isHoverTarget ? " inv-slot-target" : "")
      }
      draggable={slot !== null}
      onDragStart={(e) => {
        if (!slot) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(DRAG_MIME, String(index));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      title={def ? `${def.name} — ${def.description}` : ""}
      aria-label={def ? `${def.name} ×${slot!.quantity}` : "Empty slot"}
    >
      {def && slot && (
        <>
          <span className="inv-icon" style={{ color: def.color }}>{def.icon}</span>
          {slot.quantity > 1 && <span className="inv-qty">{formatQty(slot.quantity)}</span>}
        </>
      )}
    </div>
  );
}

function formatQty(n: number): string {
  if (n >= 1_000_000) return `${Math.floor(n / 100_000) / 10}M`;
  if (n >= 10_000) return `${Math.floor(n / 1000)}K`;
  return String(n);
}
