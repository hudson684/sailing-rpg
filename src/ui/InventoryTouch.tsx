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
import { showToast } from "./store/ui";
import "./InventoryPremade.css";
import "./InventoryTouch.css";

/**
 * Touch-first inventory. Mirrors `InventoryPremade`'s paper-doll +
 * backpack + hotbar layout, but replaces drag/drop, right-click menus
 * and double-click shortcuts with a tap-to-select + bottom action bar
 * model that works reliably with fingers.
 *
 * Tap rules:
 *   - Tap a filled slot  → select it (highlighted).
 *   - Tap the selected   → deselect.
 *   - Tap a second inv   → move/swap the selected inv item into it.
 *   - Tap a fitting      → equip the selected inv item into that slot.
 *     equip slot
 *   - Bottom action bar  → explicit Equip / Unequip / Drop / Cancel.
 */

const SCALE = 4;
const SLOT_SIZE = 16;

const EQUIP_PANEL = { x: 0, y: 0, w: 75, h: 83 };
const INFO_PANEL = { x: 0, y: 82, w: 68, h: 68 };
const INV_GRID = { x: 72, y: 0, w: 120, h: 125 };
const HOTBAR = { x: 72, y: 124, w: 120, h: 30 };
const INFO_TOGGLE = { x: 28, y: 69, w: 16, h: 10 };

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

const INV_COLS = [78, 101, 124, 147, 170];
const INV_ROWS = [6, 29, 52, 75, 98];

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

type Selection =
  | { kind: "inv"; index: number }
  | { kind: "equip"; slot: EquipSlot };

export function InventoryTouch() {
  const slots = useGameStore(selectInventorySlots);
  const equipped = useGameStore(selectEquipped);
  const [open, setOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(true);
  const [selected, setSelected] = useState<Selection | null>(null);

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

  // Clear selection whenever the panel closes so reopening starts fresh.
  useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);

  const goldCount = useMemo(() => {
    let total = 0;
    for (const s of slots) if (s?.itemId === "coin") total += s.quantity;
    return total;
  }, [slots]);

  const equippedMainName = equipped.mainHand ? ITEMS[equipped.mainHand].name : null;
  const equippedOffName = equipped.offHand ? ITEMS[equipped.offHand].name : null;

  if (!open) return null;

  const selectedInvSlot: Slot | null =
    selected?.kind === "inv" ? slots[selected.index] ?? null : null;
  const selectedInvDef = selectedInvSlot ? ITEMS[selectedInvSlot.itemId] : null;
  const selectedFamily = selectedInvDef?.slot;

  const moveSlot = (from: number, to: number) => {
    if (from === to) return;
    bus.emitTyped("inventory:action", { type: "move", from, to });
  };

  const equipSelectedInv = () => {
    if (selected?.kind !== "inv") return;
    const res = useGameStore.getState().equipFromInventory(selected.index);
    if (!res.ok && res.reason === "inventory_full") {
      showToast("Inventory full", 2000, "warn");
    }
    setSelected(null);
  };

  const dropSelectedInv = () => {
    if (selected?.kind !== "inv") return;
    bus.emitTyped("inventory:action", { type: "drop", slot: selected.index });
    setSelected(null);
  };

  const unequipSelected = () => {
    if (selected?.kind !== "equip") return;
    const res = useGameStore.getState().unequip(selected.slot);
    if (!res.ok && res.reason === "inventory_full") {
      showToast("Inventory full", 2000, "warn");
    }
    setSelected(null);
  };

  const handleInvTap = (index: number) => {
    const slot = slots[index] ?? null;
    // Tapping the already-selected inv slot deselects.
    if (selected?.kind === "inv" && selected.index === index) {
      setSelected(null);
      return;
    }
    // If an inv item is selected, use this tap as the move destination.
    if (selected?.kind === "inv") {
      moveSlot(selected.index, index);
      setSelected(null);
      return;
    }
    // Otherwise, select this slot if it has an item.
    if (slot) setSelected({ kind: "inv", index });
    else setSelected(null);
  };

  const handleEquipTap = (equipSlot: EquipSlot) => {
    // If an inv item of the right family is selected, equip it here.
    if (selected?.kind === "inv" && selectedFamily &&
        slotsForFamily(selectedFamily).includes(equipSlot)) {
      equipSelectedInv();
      return;
    }
    // Tapping the same equip selection deselects.
    if (selected?.kind === "equip" && selected.slot === equipSlot) {
      setSelected(null);
      return;
    }
    // Otherwise select the equip slot if it has an item.
    if (equipped[equipSlot]) setSelected({ kind: "equip", slot: equipSlot });
    else setSelected(null);
  };

  return (
    <>
      <div
        className="inv-touch-root"
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
            const fits =
              selectedFamily !== undefined && slotsForFamily(selectedFamily).includes(slot);
            const isSelected = selected?.kind === "equip" && selected.slot === slot;
            return (
              <button
                key={slot}
                className={
                  "inv-premade-slot inv-touch-slot" +
                  (def ? " is-filled" : "") +
                  (isSelected ? " is-selected" : "") +
                  (fits ? " is-target" : "")
                }
                style={innerCellStyle(pos.x - EQUIP_PANEL.x, pos.y - EQUIP_PANEL.y)}
                onClick={() => handleEquipTap(slot)}
                aria-label={
                  def ? `${def.name} equipped in ${EQUIP_LABELS[slot]}` : `${EQUIP_LABELS[slot]} (empty)`
                }
              >
                {def && (
                  <img className="inv-premade-icon" src={def.icon} alt="" draggable={false} />
                )}
              </button>
            );
          })}

          <button
            className={"inv-premade-info-toggle" + (infoOpen ? " is-open" : "")}
            style={{
              left: `calc(${INFO_TOGGLE.x - EQUIP_PANEL.x}px * var(--scale))`,
              top: `calc(${INFO_TOGGLE.y - EQUIP_PANEL.y}px * var(--scale))`,
              width: `calc(${INFO_TOGGLE.w}px * var(--scale))`,
              height: `calc(${INFO_TOGGLE.h}px * var(--scale))`,
            }}
            onClick={() => setInfoOpen((v) => !v)}
            aria-label={infoOpen ? "Collapse equipped summary" : "Expand equipped summary"}
          />
        </div>

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

        <div className="inv-premade-panel" style={panelStyle(INV_GRID, "/ui/premade-inv-grid.png")}>
          {INV_ROWS.map((rowY, row) =>
            INV_COLS.map((colX, col) => {
              const i = HOTBAR_SIZE + row * 5 + col;
              const slot = slots[i] ?? null;
              const def = slot ? ITEMS[slot.itemId] : null;
              const isSelected = selected?.kind === "inv" && selected.index === i;
              return (
                <button
                  key={i}
                  className={
                    "inv-premade-slot inv-touch-slot" +
                    (slot ? " is-filled" : "") +
                    (isSelected ? " is-selected" : "")
                  }
                  style={innerCellStyle(colX - INV_GRID.x, rowY - INV_GRID.y)}
                  onClick={() => handleInvTap(i)}
                  aria-label={def && slot ? `${def.name} ×${slot.quantity}` : "Empty slot"}
                >
                  {def && slot && (
                    <>
                      <img className="inv-premade-icon" src={def.icon} alt="" draggable={false} />
                      {slot.quantity > 1 && (
                        <span className="inv-premade-qty">{formatQty(slot.quantity)}</span>
                      )}
                    </>
                  )}
                </button>
              );
            }),
          )}
        </div>

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
          Tap to select · tap another slot to move or equip
        </div>
      </div>

      <TouchActionBar
        selected={selected}
        selectedDef={selectedInvDef}
        selectedQuantity={selectedInvSlot?.quantity ?? 0}
        onEquip={equipSelectedInv}
        onDrop={dropSelectedInv}
        onUnequip={unequipSelected}
        onCancel={() => setSelected(null)}
      />
    </>
  );
}

interface TouchActionBarProps {
  selected: Selection | null;
  selectedDef: (typeof ITEMS)[string] | null;
  selectedQuantity: number;
  onEquip: () => void;
  onDrop: () => void;
  onUnequip: () => void;
  onCancel: () => void;
}

function TouchActionBar(props: TouchActionBarProps) {
  const { selected, selectedDef, selectedQuantity } = props;
  if (!selected) return null;

  const label =
    selected.kind === "inv"
      ? selectedDef?.name ?? "Empty"
      : EQUIP_LABELS[selected.slot];

  return (
    <div className="inv-touch-actionbar" role="toolbar" aria-label="Inventory actions">
      <div className="inv-touch-actionbar__label">{label}</div>
      <div className="inv-touch-actionbar__buttons">
        {selected.kind === "inv" && selectedDef?.slot && (
          <button
            className="inv-touch-btn inv-touch-btn--primary"
            onClick={props.onEquip}
          >
            Equip
          </button>
        )}
        {selected.kind === "inv" && (
          <button
            className="inv-touch-btn inv-touch-btn--danger"
            onClick={props.onDrop}
          >
            {selectedQuantity > 1 ? `Drop ×${selectedQuantity}` : "Drop"}
          </button>
        )}
        {selected.kind === "equip" && (
          <button
            className="inv-touch-btn inv-touch-btn--primary"
            onClick={props.onUnequip}
          >
            Unequip
          </button>
        )}
        <button className="inv-touch-btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
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

function formatQty(n: number): string {
  if (n >= 1_000_000) return `${Math.floor(n / 100_000) / 10}M`;
  if (n >= 10_000) return `${Math.floor(n / 1000)}K`;
  return String(n);
}
