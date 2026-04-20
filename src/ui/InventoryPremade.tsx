import { useEffect, useMemo, useState } from "react";
import { bus } from "../game/bus";
import {
  EQUIP_SLOTS,
  ITEMS,
  slotsForFamily,
  type EquipSlot,
} from "../game/inventory/items";
import { HOTBAR_SIZE, type Slot } from "../game/inventory/types";
import {
  selectEquipped,
  selectInventorySlots,
  useGameStore,
} from "../game/store/gameStore";
import { Hotbar } from "./Hotbar";
import { selectDragSource, useDragStore } from "./store/dragStore";
import { showToast } from "./store/ui";
import {
  InventoryContextMenu,
  type ContextMenuItem,
} from "./InventoryContextMenu";
import "./InventoryPremade.css";

type CtxMenuState =
  | { kind: "inv"; index: number; x: number; y: number }
  | { kind: "equip"; slot: EquipSlot; x: number; y: number };

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
  const dragSource = useDragStore(selectDragSource);
  const setDragSource = useDragStore((s) => s.setSource);
  const [open, setOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(true);
  const [hoverTo, setHoverTo] = useState<DropTarget | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const k = e.key.toLowerCase();
      if (k === "i" || k === "c") {
        setOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        setOpen((wasOpen) => {
          if (wasOpen) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return false;
          }
          return wasOpen;
        });
      }
    };
    const onToggle = () => setOpen((v) => !v);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("inventory:toggle", onToggle);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("inventory:toggle", onToggle);
    };
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
    if (dragSource === null) return;
    if (to.kind === "inv") {
      if (dragSource === to.index) return;
      bus.emitTyped("inventory:action", { type: "move", from: dragSource, to: to.index });
    } else {
      useGameStore.getState().equipFromInventory(dragSource);
    }
  };

  const handleUnequip = (slot: EquipSlot) => {
    const res = useGameStore.getState().unequip(slot);
    if (!res.ok && res.reason === "inventory_full") {
      showToast("Inventory full", 2000, "warn");
    }
  };

  const handleQuickEquip = (index: number) => {
    const slot = slots[index];
    if (!slot) return;
    const def = ITEMS[slot.itemId];
    if (!def?.slot) return;
    const res = useGameStore.getState().equipFromInventory(index);
    if (!res.ok && res.reason === "inventory_full") {
      showToast("Inventory full", 2000, "warn");
    }
  };

  const handleDropSlot = (index: number) => {
    bus.emitTyped("inventory:action", { type: "drop", slot: index });
  };

  const buildInvMenu = (index: number): ContextMenuItem[] => {
    const slot = slots[index];
    if (!slot) return [];
    const def = ITEMS[slot.itemId];
    const items: ContextMenuItem[] = [];
    if (def?.slot) {
      items.push({ label: "Equip", onSelect: () => handleQuickEquip(index) });
    }
    items.push({
      label: slot.quantity > 1 ? `Drop all (×${slot.quantity})` : "Drop",
      onSelect: () => handleDropSlot(index),
      variant: "danger",
    });
    return items;
  };

  const buildEquipMenu = (slot: EquipSlot): ContextMenuItem[] => {
    if (!equipped[slot]) return [];
    return [{ label: "Unequip", onSelect: () => handleUnequip(slot) }];
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
          const dragSlot = dragSource !== null ? slots[dragSource] : null;
          const dragFamily = dragSlot ? ITEMS[dragSlot.itemId].slot : undefined;
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
              onContextMenu={(e) => {
                e.preventDefault();
                if (!def) return;
                setCtxMenu({ kind: "equip", slot, x: e.clientX, y: e.clientY });
              }}
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
                <img
                  className="inv-premade-icon"
                  src={def.icon}
                  alt=""
                  draggable={false}
                />
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

      {/* Backpack grid 5×5 — absolute slot indices [HOTBAR_SIZE, HOTBAR_SIZE+25). */}
      <div className="inv-premade-panel" style={panelStyle(INV_GRID, "/ui/premade-inv-grid.png")}>
        {INV_ROWS.map((rowY, row) =>
          INV_COLS.map((colX, col) => {
            const i = HOTBAR_SIZE + row * 5 + col;
            const slot = slots[i] ?? null;
            return (
              <InvCell
                key={i}
                index={i}
                slot={slot}
                x={colX - INV_GRID.x}
                y={rowY - INV_GRID.y}
                isDragging={dragSource === i}
                isHoverTarget={
                  hoverTo?.kind === "inv" &&
                  hoverTo.index === i &&
                  dragSource !== null &&
                  dragSource !== i
                }
                onDragStart={() => setDragSource(i)}
                onDragEnd={() => {
                  setDragSource(null);
                  setHoverTo(null);
                }}
                onDragEnter={() => setHoverTo({ kind: "inv", index: i })}
                onDragLeave={() =>
                  setHoverTo((cur) =>
                    cur?.kind === "inv" && cur.index === i ? null : cur,
                  )
                }
                onDrop={() => handleDrop({ kind: "inv", index: i })}
                onDoubleClick={() => handleQuickEquip(i)}
                onContextMenu={(x, y) => {
                  if (!slot) return;
                  setCtxMenu({ kind: "inv", index: i, x, y });
                }}
              />
            );
          }),
        )}
      </div>

      {/* Hotbar — mirrors slots[0..HOTBAR_SIZE) shown in the HUD. */}
      <div
        className="inv-premade-hotbar-mount"
        style={{
          left: `calc(${HOTBAR.x}px * var(--scale))`,
          top: `calc(${HOTBAR.y}px * var(--scale))`,
          width: `calc(${HOTBAR.w}px * var(--scale))`,
          height: `calc(${HOTBAR.h}px * var(--scale))`,
        }}
      >
        <Hotbar variant="embedded" scale={SCALE} />
      </div>

      <div className="inv-premade-hint">
        I: toggle · drag or double-click to equip · right-click for options · 1-5 hotbar
      </div>

      {ctxMenu && (
        <InventoryContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={
            ctxMenu.kind === "inv"
              ? buildInvMenu(ctxMenu.index)
              : buildEquipMenu(ctxMenu.slot)
          }
          onClose={() => setCtxMenu(null)}
        />
      )}
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
  onDoubleClick?: () => void;
  onContextMenu?: (x: number, y: number) => void;
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
      onDoubleClick={props.onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onContextMenu?.(e.clientX, e.clientY);
      }}
      data-tip={def ? `${def.name}${def.description ? " · " + def.description : ""}` : undefined}
      aria-label={def ? `${def.name} ×${slot!.quantity}` : "Empty slot"}
    >
      {def && slot && (
        <>
          <img
            className="inv-premade-icon"
            src={def.icon}
            alt=""
            draggable={false}
          />
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
