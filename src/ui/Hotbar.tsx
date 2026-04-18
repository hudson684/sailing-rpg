import { useState } from "react";
import { bus } from "../game/bus";
import { ITEMS } from "../game/inventory/items";
import { HOTBAR_SIZE } from "../game/inventory/types";
import type { Slot } from "../game/inventory/types";
import { selectInventorySlots, useGameStore } from "../game/store/gameStore";
import { selectDragSource, useDragStore } from "./store/dragStore";
import {
  InventoryContextMenu,
  type ContextMenuItem,
} from "./InventoryContextMenu";
import { showToast } from "./store/ui";
import "./Hotbar.css";

// Source-px coords inside premade-hotbar.png (120×30 src).
const HOTBAR_SRC_W = 120;
const HOTBAR_SRC_H = 30;
const SLOT_SRC = 16;
const SLOT_X = [6, 29, 52, 75, 98];
const SLOT_Y = 8;

interface HotbarProps {
  /** hud = pinned top-left with its own scale; embedded = positioned by parent. */
  variant?: "hud" | "embedded";
  scale?: number;
}

export function Hotbar({ variant = "hud", scale = 4 }: HotbarProps) {
  const slots = useGameStore(selectInventorySlots);
  const dragSource = useDragStore(selectDragSource);
  const setDragSource = useDragStore((s) => s.setSource);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ index: number; x: number; y: number } | null>(null);

  const quickEquip = (i: number) => {
    const slot = slots[i];
    if (!slot) return;
    const def = ITEMS[slot.itemId];
    if (!def?.slot) return;
    const res = useGameStore.getState().equipFromInventory(i);
    if (!res.ok && res.reason === "inventory_full") {
      showToast("Inventory full", 2000, "warn");
    }
  };

  const buildMenu = (i: number): ContextMenuItem[] => {
    const slot = slots[i];
    if (!slot) return [];
    const def = ITEMS[slot.itemId];
    const items: ContextMenuItem[] = [];
    if (def?.slot) {
      items.push({ label: "Equip", onSelect: () => quickEquip(i) });
    }
    items.push({
      label: slot.quantity > 1 ? `Drop all (×${slot.quantity})` : "Drop",
      onSelect: () => bus.emitTyped("inventory:action", { type: "drop", slot: i }),
      variant: "danger",
    });
    return items;
  };

  const cells: (Slot | null)[] = [];
  for (let i = 0; i < HOTBAR_SIZE; i++) cells.push(slots[i] ?? null);

  return (
    <div
      className={`hotbar-root hotbar-${variant}`}
      style={{
        ["--hotbar-scale" as string]: scale,
        width: `calc(${HOTBAR_SRC_W}px * var(--hotbar-scale))`,
        height: `calc(${HOTBAR_SRC_H}px * var(--hotbar-scale))`,
      }}
      role="list"
      aria-label="Hotbar"
    >
      {cells.map((slot, i) => {
        const def = slot ? ITEMS[slot.itemId] : null;
        const isDragging = dragSource === i;
        const isTarget = hoverIndex === i && dragSource !== null && dragSource !== i;
        return (
          <div
            key={i}
            role="listitem"
            className={
              "hotbar-slot" +
              (slot ? " is-filled" : "") +
              (isDragging ? " is-dragging" : "") +
              (isTarget ? " is-target" : "")
            }
            style={{
              left: `calc(${SLOT_X[i]}px * var(--hotbar-scale))`,
              top: `calc(${SLOT_Y}px * var(--hotbar-scale))`,
              width: `calc(${SLOT_SRC}px * var(--hotbar-scale))`,
              height: `calc(${SLOT_SRC}px * var(--hotbar-scale))`,
            }}
            onDragOver={(e) => {
              if (dragSource === null || dragSource === i) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDragEnter={() => setHoverIndex(i)}
            onDragLeave={() =>
              setHoverIndex((cur) => (cur === i ? null : cur))
            }
            onDrop={(e) => {
              e.preventDefault();
              const src = dragSource;
              setHoverIndex(null);
              if (src === null || src === i) return;
              bus.emitTyped("inventory:action", { type: "move", from: src, to: i });
            }}
            onDoubleClick={() => quickEquip(i)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!slot) return;
              setCtxMenu({ index: i, x: e.clientX, y: e.clientY });
            }}
            aria-label={def && slot ? `${def.name} ×${slot.quantity}` : `Hotbar ${i + 1} (empty)`}
          >
            <span className="hotbar-key">{i + 1}</span>
            {def && slot && (
              <div
                className="hotbar-content"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(i));
                  // Use the icon alone as the drag ghost so the hotbar key
                  // digit doesn't appear attached to the cursor.
                  const icon = e.currentTarget.querySelector<HTMLElement>(".hotbar-icon");
                  if (icon) {
                    const r = icon.getBoundingClientRect();
                    e.dataTransfer.setDragImage(icon, r.width / 2, r.height / 2);
                  }
                  setDragSource(i);
                }}
                onDragEnd={() => {
                  setDragSource(null);
                  setHoverIndex(null);
                }}
              >
                <img
                  className="hotbar-icon"
                  src={def.icon}
                  alt=""
                  draggable={false}
                />
                {slot.quantity > 1 && (
                  <span className="hotbar-qty">{formatQty(slot.quantity)}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
      {ctxMenu && (
        <InventoryContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildMenu(ctxMenu.index)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

function formatQty(n: number): string {
  if (n >= 1_000_000) return `${Math.floor(n / 100_000) / 10}M`;
  if (n >= 10_000) return `${Math.floor(n / 1000)}K`;
  return String(n);
}
