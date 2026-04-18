import { useEffect, useMemo, useState } from "react";
import { bus } from "../game/bus";
import {
  EQUIP_SLOTS,
  ITEMS,
  slotsForFamily,
  type EquipSlot,
} from "../game/inventory/items";
import type { Slot } from "../game/inventory/types";
import {
  selectEquipped,
  selectInventorySlots,
  useGameStore,
} from "../game/store/gameStore";
import { showToast } from "./store/ui";
import "./InventoryPremade.css";

/**
 * Inventory + Equipment panel built on sliced pieces of UI_Premade.png.
 * Each sub-panel is its own absolutely-positioned background image so that
 * the info panel (gold / main / off) can collapse independently via the
 * white arrow embedded in the equipment panel.
 *
 * All coordinates below are in *source pixels* relative to the top-left of
 * the original left-layout extract (192×154 src). They're rendered at 4×.
 */

const SCALE = 4;
const SLOT_SIZE = 16;

// Sub-panel positions + sizes (src px)
const EQUIP_PANEL = { x: 0, y: 0, w: 75, h: 83 };
const INFO_PANEL = { x: 0, y: 82, w: 68, h: 68 };
const INV_GRID = { x: 72, y: 0, w: 120, h: 125 };
const HOTBAR = { x: 72, y: 124, w: 120, h: 30 };

// The white arrow embedded in the equipment panel's bottom center — we
// overlay an invisible button here so a click toggles the info panel.
const INFO_TOGGLE = { x: 28, y: 69, w: 16, h: 10 };

// Paper-doll slot positions (relative to EQUIP_PANEL origin — same as src).
const EQUIP_POS: Record<EquipSlot, { x: number; y: number }> = {
  head:     { x: 28, y:  6 },
  body:     { x: 28, y: 28 },
  legs:     { x: 28, y: 50 },
  mainHand: { x:  6, y: 17 },
  offHand:  { x:  6, y: 39 },
  ringL:    { x: 50, y: 17 },
  ringR:    { x: 50, y: 39 },
  trinketL: { x:  6, y: 61 },
  trinketR: { x: 50, y: 61 },
};

const EQUIP_LABELS: Record<EquipSlot, string> = {
  head: "Head",
  body: "Body",
  legs: "Legs",
  mainHand: "Main Hand",
  offHand: "Off Hand",
  ringL: "Ring (Left)",
  ringR: "Ring (Right)",
  trinketL: "Trinket (Left)",
  trinketR: "Trinket (Right)",
};

// Inventory grid: 5 cols × 5 rows, slot top-left src coords.
const INV_COLS = [78, 101, 124, 147, 170];
const INV_ROWS = [6, 29, 52, 75, 98];
const HOTBAR_ROW_Y = 132;

// Bounding box of the whole assembled layout (for positioning the root).
const TOTAL_W = Math.max(
  EQUIP_PANEL.x + EQUIP_PANEL.w,
  INFO_PANEL.x + INFO_PANEL.w,
  INV_GRID.x + INV_GRID.w,
  HOTBAR.x + HOTBAR.w,
);
const TOTAL_H = Math.max(
  EQUIP_PANEL.y + EQUIP_PANEL.h,
  INFO_PANEL.y + INFO_PANEL.h,
  INV_GRID.y + INV_GRID.h,
  HOTBAR.y + HOTBAR.h,
);

export function InventoryPremade() {
  const slots = useGameStore(selectInventorySlots);
  const equipped = useGameStore(selectEquipped);
  const [open, setOpen] = useState(true);
  const [infoOpen, setInfoOpen] = useState(true);
  const [dragFrom, setDragFrom] = useState<DragSource | null>(null);
  const [hoverTo, setHoverTo] = useState<DropTarget | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k !== "i" && k !== "c") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const goldCount = useMemo(() => {
    let total = 0;
    for (const s of slots) if (s?.itemId === "coin") total += s.quantity;
    return total;
  }, [slots]);

  const equippedMainName = equipped.mainHand
    ? ITEMS[equipped.mainHand].name
    : null;
  const equippedOffName = equipped.offHand
    ? ITEMS[equipped.offHand].name
    : null;

  if (!open) return null;

  const handleDrop = (to: DropTarget) => {
    if (!dragFrom) return;
    if (dragFrom.kind === "inv" && to.kind === "inv") {
      if (dragFrom.index === to.index) return;
      bus.emitTyped("inventory:action", { type: "move", from: dragFrom.index, to: to.index });
    } else if (dragFrom.kind === "inv" && to.kind === "equip") {
      useGameStore.getState().equipFromInventory(dragFrom.index);
    }
  };

  const handleUnequip = (slot: EquipSlot) => {
    const res = useGameStore.getState().unequip(slot);
    if (!res.ok && res.reason === "inventory_full") {
      showToast("Inventory full", 2000, "warn");
    }
  };

  return (
    <div
      className="inv-premade-root"
      role="region"
      aria-label="Inventory"
      style={{
        ["--scale" as string]: SCALE,
        width: `calc(${TOTAL_W}px * var(--scale))`,
        height: `calc(${TOTAL_H}px * var(--scale))`,
      }}
    >
      <button
        className="inv-premade-close"
        onClick={() => setOpen(false)}
        aria-label="Close inventory"
      >
        ×
      </button>

      {/* Equipment paper-doll panel */}
      <div className="inv-premade-panel" style={panelStyle(EQUIP_PANEL, "/ui/premade-equipment.png")}>
        {EQUIP_SLOTS.map((slot) => {
          const pos = EQUIP_POS[slot];
          const id = equipped[slot];
          const def = id ? ITEMS[id] : null;
          const dragDef = dragFrom?.kind === "inv" ? slots[dragFrom.index] : null;
          const dragFamily = dragDef ? ITEMS[dragDef.itemId].slot : undefined;
          const fits =
            dragFamily !== undefined && slotsForFamily(dragFamily).includes(slot);
          const isTarget = hoverTo?.kind === "equip" && hoverTo.slot === slot && fits;
          const target: DropTarget = { kind: "equip", slot };
          return (
            <button
              key={slot}
              className={"inv-premade-slot" + (def ? " is-filled" : "") + (isTarget ? " is-target" : "")}
              style={innerCellStyle(pos.x - EQUIP_PANEL.x, pos.y - EQUIP_PANEL.y)}
              onClick={() => def && handleUnequip(slot)}
              onDragOver={(e) => {
                if (!fits) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDragEnter={() => setHoverTo(target)}
              onDragLeave={() =>
                setHoverTo((cur) =>
                  cur?.kind === "equip" && cur.slot === slot ? null : cur,
                )
              }
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(target);
              }}
              data-tip={def ? `${def.name} · click to unequip` : EQUIP_LABELS[slot]}
              aria-label={def ? `${def.name} equipped in ${EQUIP_LABELS[slot]}` : `${EQUIP_LABELS[slot]} (empty)`}
            >
              {def && (
                <span className="inv-premade-icon" style={{ color: def.color }}>
                  {def.icon}
                </span>
              )}
            </button>
          );
        })}

        {/* The white arrow acts as a collapse toggle for the info panel */}
        <button
          className={"inv-premade-info-toggle" + (infoOpen ? " is-open" : "")}
          style={{
            left: `calc(${INFO_TOGGLE.x - EQUIP_PANEL.x}px * var(--scale))`,
            top: `calc(${INFO_TOGGLE.y - EQUIP_PANEL.y}px * var(--scale))`,
            width: `calc(${INFO_TOGGLE.w}px * var(--scale))`,
            height: `calc(${INFO_TOGGLE.h}px * var(--scale))`,
          }}
          onClick={() => setInfoOpen((v) => !v)}
          data-tip={infoOpen ? "Hide equipped summary" : "Show equipped summary"}
          aria-label={infoOpen ? "Collapse equipped summary" : "Expand equipped summary"}
        />
      </div>

      {/* Info panel (gold + equipped weapon/offhand). Collapsible. */}
      {infoOpen && (
        <div className="inv-premade-panel" style={panelStyle(INFO_PANEL, "/ui/premade-info.png")}>
          <div className="inv-premade-info-text inv-premade-info-gold">{goldCount}</div>
          <div className="inv-premade-info-text inv-premade-info-main">
            {equippedMainName ?? "—"}
          </div>
          <div className="inv-premade-info-text inv-premade-info-off">
            {equippedOffName ?? "—"}
          </div>
        </div>
      )}

      {/* Inventory grid 5×5 */}
      <div className="inv-premade-panel" style={panelStyle(INV_GRID, "/ui/premade-inv-grid.png")}>
        {slots.map((slot, i) => {
          const col = i % 5;
          const row = Math.floor(i / 5);
          if (row >= INV_ROWS.length) return null;
          return (
            <InvCell
              key={i}
              index={i}
              slot={slot}
              x={INV_COLS[col] - INV_GRID.x}
              y={INV_ROWS[row] - INV_GRID.y}
              isDragging={dragFrom?.kind === "inv" && dragFrom.index === i}
              isHoverTarget={
                hoverTo?.kind === "inv" &&
                hoverTo.index === i &&
                dragFrom?.kind === "inv" &&
                dragFrom.index !== i
              }
              onDragStart={() => setDragFrom({ kind: "inv", index: i })}
              onDragEnd={() => {
                setDragFrom(null);
                setHoverTo(null);
              }}
              onDragEnter={() => setHoverTo({ kind: "inv", index: i })}
              onDragLeave={() =>
                setHoverTo((cur) =>
                  cur?.kind === "inv" && cur.index === i ? null : cur,
                )
              }
              onDrop={() => handleDrop({ kind: "inv", index: i })}
            />
          );
        })}
      </div>

      {/* Hotbar (decorative placeholder) */}
      <div className="inv-premade-panel" style={panelStyle(HOTBAR, "/ui/premade-hotbar.png")}>
        {INV_COLS.map((x, i) => (
          <div
            key={`hot-${i}`}
            className="inv-premade-slot is-hotbar"
            style={innerCellStyle(x - HOTBAR.x, HOTBAR_ROW_Y - HOTBAR.y)}
            aria-label={`Hotbar ${i + 1}`}
          />
        ))}
      </div>

      <div className="inv-premade-hint">I: toggle · drag to move · click equip slot to unequip</div>
    </div>
  );
}

function panelStyle(
  p: { x: number; y: number; w: number; h: number },
  img: string,
): React.CSSProperties {
  return {
    left: `calc(${p.x}px * var(--scale))`,
    top: `calc(${p.y}px * var(--scale))`,
    width: `calc(${p.w}px * var(--scale))`,
    height: `calc(${p.h}px * var(--scale))`,
    backgroundImage: `url(${img})`,
  };
}

function innerCellStyle(x: number, y: number): React.CSSProperties {
  return {
    left: `calc(${x}px * var(--scale))`,
    top: `calc(${y}px * var(--scale))`,
    width: `calc(${SLOT_SIZE}px * var(--scale))`,
    height: `calc(${SLOT_SIZE}px * var(--scale))`,
  };
}

type DragSource = { kind: "inv"; index: number };
type DropTarget = { kind: "inv"; index: number } | { kind: "equip"; slot: EquipSlot };

interface InvCellProps {
  index: number;
  slot: Slot | null;
  x: number;
  y: number;
  isDragging: boolean;
  isHoverTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
}

function InvCell(props: InvCellProps) {
  const { slot, x, y, isDragging, isHoverTarget } = props;
  const def = slot ? ITEMS[slot.itemId] : null;

  return (
    <div
      className={
        "inv-premade-slot" +
        (slot ? " is-filled" : "") +
        (isDragging ? " is-dragging" : "") +
        (isHoverTarget ? " is-target" : "")
      }
      style={innerCellStyle(x, y)}
      draggable={slot !== null}
      onDragStart={(e) => {
        if (!slot) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(props.index));
        props.onDragStart();
      }}
      onDragEnd={props.onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragEnter={props.onDragEnter}
      onDragLeave={props.onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        props.onDrop();
      }}
      data-tip={def ? `${def.name}${def.description ? " · " + def.description : ""}` : undefined}
      aria-label={def ? `${def.name} ×${slot!.quantity}` : "Empty slot"}
    >
      {def && slot && (
        <>
          <span className="inv-premade-icon" style={{ color: def.color }}>
            {def.icon}
          </span>
          {slot.quantity > 1 && (
            <span className="inv-premade-qty">{formatQty(slot.quantity)}</span>
          )}
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
