import { useEffect, useMemo, useState } from "react";
import { bus } from "../game/bus";
import {
  ITEMS,
  slotsForFamily,
  type EquipSlot,
} from "../game/inventory/items";
import { HOTBAR_SIZE, type Slot } from "../game/inventory/types";
import type { Equipped } from "../game/equipment/operations";
import {
  selectEquipped,
  selectInventorySlots,
  useGameStore,
} from "../game/store/gameStore";
import { useUIStore } from "./store/uiStore";
import { showToast } from "./store/ui";
import "./InventoryTouch.css";

/**
 * Mobile-first inventory. A full-screen modal (not a scaled-down desktop
 * panel) with three tabs — Equipped, Hotbar, and Inventory — each
 * rendering as its own full page so the slots get enough room.
 *
 * Selection model:
 *   - Tap a filled slot  → select it.
 *   - Tap the selected   → deselect.
 *   - Tap another slot   → move/swap (inv ↔ inv, inv → hotbar, inv →
 *                           fitting equip, etc.).
 *   - Bottom action bar  → explicit Equip / Unequip / Drop / Cancel.
 */

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

// Paper-doll layout: 3 cols × 4 rows. Centre column holds head/body/legs;
// hands flank body; rings flank legs; trinkets sit on the bottom row.
const PAPER_DOLL_GRID: (EquipSlot | null)[][] = [
  [null,       "head",  null     ],
  ["mainHand", "body",  "offHand"],
  ["ringL",    "legs",  "ringR"  ],
  ["trinketL", null,    "trinketR"],
];

const BAG_COLS = 5;
const BAG_ROWS = 5;

type Tab = "equipped" | "hotbar" | "inventory";

type Selection =
  | { kind: "inv"; index: number }
  | { kind: "equip"; slot: EquipSlot };

export function InventoryTouch() {
  const slots = useGameStore(selectInventorySlots);
  const equipped = useGameStore(selectEquipped);
  const setInventoryOpen = useUIStore((s) => s.setInventoryOpen);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("inventory");
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

  useEffect(() => {
    setInventoryOpen(open);
    if (!open) setSelected(null);
  }, [open, setInventoryOpen]);

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

  const consumeSelectedInv = () => {
    if (selected?.kind !== "inv") return;
    const slot = slots[selected.index];
    const def = slot ? ITEMS[slot.itemId] : null;
    const effect = def?.consumable;
    const res = useGameStore.getState().useConsumable(selected.index);
    if (!res.ok && res.reason === "no_effect") {
      showToast("Already at full health.", 1200);
    } else if (res.ok && effect?.healHp) {
      showToast(`+${effect.healHp} HP`, 1200, "success");
    } else if (res.ok && effect?.regenHp) {
      showToast(`+${effect.regenHp} HP regen`, 1200, "success");
    }
    setSelected(null);
  };

  const dropSelectedInv = () => {
    if (selected?.kind !== "inv") return;
    bus.emitTyped("inventory:action", { type: "drop", slot: selected.index });
    setSelected(null);
  };

  const addSelectedToHotbar = () => {
    if (selected?.kind !== "inv") return;
    if (selected.index < HOTBAR_SIZE) return;
    let target = -1;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      if (!slots[i]) {
        target = i;
        break;
      }
    }
    if (target < 0) {
      showToast("Hotbar full", 1500, "warn");
      return;
    }
    moveSlot(selected.index, target);
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
    if (selected?.kind === "inv" && selected.index === index) {
      setSelected(null);
      return;
    }
    if (selected?.kind === "inv") {
      moveSlot(selected.index, index);
      setSelected(null);
      return;
    }
    if (slot) setSelected({ kind: "inv", index });
    else setSelected(null);
  };

  const handleEquipTap = (equipSlot: EquipSlot) => {
    if (selected?.kind === "inv" && selectedFamily &&
        slotsForFamily(selectedFamily).includes(equipSlot)) {
      equipSelectedInv();
      return;
    }
    if (selected?.kind === "equip" && selected.slot === equipSlot) {
      setSelected(null);
      return;
    }
    if (equipped[equipSlot]) setSelected({ kind: "equip", slot: equipSlot });
    else setSelected(null);
  };

  return (
    <>
      <div
        className="inv-touch-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpen(false);
        }}
      >
        <div
          className="px-panel inv-touch-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Inventory"
        >
          <div className="inv-touch-header">
            <div className="inv-touch-title">Inventory</div>
            <div className="inv-touch-summary">
              <span className="inv-touch-summary-chip">
                <span className="inv-touch-summary-label">Gold</span>
                <span className="inv-touch-summary-value">{goldCount}</span>
              </span>
              <span className="inv-touch-summary-chip">
                <span className="inv-touch-summary-label">Main</span>
                <span className="inv-touch-summary-value">{equippedMainName ?? "—"}</span>
              </span>
              <span className="inv-touch-summary-chip">
                <span className="inv-touch-summary-label">Off</span>
                <span className="inv-touch-summary-value">{equippedOffName ?? "—"}</span>
              </span>
            </div>
            <button
              className="px-close inv-touch-close"
              onClick={() => setOpen(false)}
              aria-label="Close inventory"
            >
              ×
            </button>
          </div>

          <div className="inv-touch-tabs" role="tablist">
            <TabButton active={tab === "equipped"} onClick={() => setTab("equipped")}>
              Equipped
            </TabButton>
            <TabButton active={tab === "hotbar"} onClick={() => setTab("hotbar")}>
              Hotbar
            </TabButton>
            <TabButton active={tab === "inventory"} onClick={() => setTab("inventory")}>
              Inventory
            </TabButton>
          </div>

          <div className="inv-touch-body">
            {tab === "equipped" && (
              <PaperDoll
                equipped={equipped}
                selected={selected}
                selectedFamily={selectedFamily}
                onTap={handleEquipTap}
              />
            )}
            {tab === "hotbar" && (
              <HotbarPage
                slots={slots}
                selected={selected}
                onTap={handleInvTap}
              />
            )}
            {tab === "inventory" && (
              <BagGrid
                slots={slots}
                selected={selected}
                onTap={handleInvTap}
              />
            )}
          </div>

          <div className="inv-touch-hint">
            Tap to select · tap another slot to move or equip
          </div>
        </div>
      </div>

      <TouchActionBar
        selected={selected}
        selectedDef={selectedInvDef}
        selectedQuantity={selectedInvSlot?.quantity ?? 0}
        onEquip={equipSelectedInv}
        onConsume={consumeSelectedInv}
        onAddToHotbar={addSelectedToHotbar}
        onDrop={dropSelectedInv}
        onUnequip={unequipSelected}
        onCancel={() => setSelected(null)}
      />
    </>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      role="tab"
      aria-selected={active}
      className={"px-btn inv-touch-tab" + (active ? " is-active" : "")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface PaperDollProps {
  equipped: Equipped;
  selected: Selection | null;
  selectedFamily: string | undefined;
  onTap: (slot: EquipSlot) => void;
}

function PaperDoll({ equipped, selected, selectedFamily, onTap }: PaperDollProps) {
  return (
    <div className="inv-touch-paperdoll" role="group" aria-label="Equipped items">
      {PAPER_DOLL_GRID.map((row, ri) =>
        row.map((slot, ci) => {
          if (!slot) return <div key={`${ri}-${ci}`} className="inv-touch-paperdoll-spacer" />;
          return (
            <EquipSlotCell
              key={slot}
              slot={slot}
              equipped={equipped}
              selected={selected}
              selectedFamily={selectedFamily}
              onTap={onTap}
            />
          );
        }),
      )}
    </div>
  );
}

interface EquipSlotCellProps {
  slot: EquipSlot;
  equipped: Equipped;
  selected: Selection | null;
  selectedFamily: string | undefined;
  onTap: (slot: EquipSlot) => void;
}

function EquipSlotCell({ slot, equipped, selected, selectedFamily, onTap }: EquipSlotCellProps) {
  const id = equipped[slot];
  const def = id ? ITEMS[id] : null;
  const fits =
    selectedFamily !== undefined &&
    slotsForFamily(selectedFamily as Parameters<typeof slotsForFamily>[0]).includes(slot);
  const isSelected = selected?.kind === "equip" && selected.slot === slot;
  return (
    <button
      className={
        "px-slot inv-touch-cell" +
        (def ? " px-slot-filled" : "") +
        (isSelected ? " is-selected" : "") +
        (fits ? " is-target" : "")
      }
      onClick={() => onTap(slot)}
      aria-label={
        def ? `${def.name} equipped in ${EQUIP_LABELS[slot]}` : `${EQUIP_LABELS[slot]} (empty)`
      }
    >
      <span className="inv-touch-cell-label">{EQUIP_LABELS[slot]}</span>
      {def && <img className="inv-touch-icon" src={def.icon} alt="" draggable={false} />}
    </button>
  );
}

interface BagGridProps {
  slots: (Slot | null)[];
  selected: Selection | null;
  onTap: (index: number) => void;
}

function BagGrid({ slots, selected, onTap }: BagGridProps) {
  const cells: number[] = [];
  for (let i = 0; i < BAG_COLS * BAG_ROWS; i++) cells.push(HOTBAR_SIZE + i);
  return (
    <div
      className="inv-touch-bag"
      role="grid"
      aria-label="Inventory bag"
      style={{ gridTemplateColumns: `repeat(${BAG_COLS}, 1fr)` }}
    >
      {cells.map((i) => (
        <BagCell key={i} index={i} slot={slots[i] ?? null} selected={selected} onTap={onTap} />
      ))}
    </div>
  );
}

interface BagCellProps {
  index: number;
  slot: Slot | null;
  selected: Selection | null;
  onTap: (index: number) => void;
}

function BagCell({ index, slot, selected, onTap }: BagCellProps) {
  const def = slot ? ITEMS[slot.itemId] : null;
  const isSelected = selected?.kind === "inv" && selected.index === index;
  return (
    <button
      className={
        "px-slot inv-touch-cell" +
        (slot ? " px-slot-filled" : "") +
        (isSelected ? " is-selected" : "")
      }
      onClick={() => onTap(index)}
      aria-label={def && slot ? `${def.name} ×${slot.quantity}` : "Empty slot"}
    >
      {def && slot && (
        <>
          <img className="inv-touch-icon" src={def.icon} alt="" draggable={false} />
          {slot.quantity > 1 && (
            <span className="px-slot-qty inv-touch-qty">{formatQty(slot.quantity)}</span>
          )}
        </>
      )}
    </button>
  );
}

interface HotbarPageProps {
  slots: (Slot | null)[];
  selected: Selection | null;
  onTap: (index: number) => void;
}

function HotbarPage({ slots, selected, onTap }: HotbarPageProps) {
  const cells: number[] = [];
  for (let i = 0; i < HOTBAR_SIZE; i++) cells.push(i);
  return (
    <div className="inv-touch-hotbar" role="group" aria-label="Hotbar">
      {cells.map((i) => {
        const slot = slots[i] ?? null;
        const def = slot ? ITEMS[slot.itemId] : null;
        const isSelected = selected?.kind === "inv" && selected.index === i;
        return (
          <button
            key={i}
            className={
              "px-slot inv-touch-cell inv-touch-hotbar-cell" +
              (slot ? " px-slot-filled" : "") +
              (isSelected ? " is-selected" : "")
            }
            onClick={() => onTap(i)}
            aria-label={def && slot ? `Hotbar ${i + 1}: ${def.name} ×${slot.quantity}` : `Hotbar ${i + 1} (empty)`}
          >
            <span className="inv-touch-hotbar-key">{i + 1}</span>
            {def && slot && (
              <>
                <img className="inv-touch-icon" src={def.icon} alt="" draggable={false} />
                {slot.quantity > 1 && (
                  <span className="px-slot-qty inv-touch-qty">{formatQty(slot.quantity)}</span>
                )}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

interface TouchActionBarProps {
  selected: Selection | null;
  selectedDef: (typeof ITEMS)[string] | null;
  selectedQuantity: number;
  onEquip: () => void;
  onConsume: () => void;
  onAddToHotbar: () => void;
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
            className="px-btn px-btn-green"
            onClick={props.onEquip}
          >
            Equip
          </button>
        )}
        {selected.kind === "inv" && selectedDef?.consumable && (
          <button
            className="px-btn px-btn-green"
            onClick={props.onConsume}
          >
            Eat
          </button>
        )}
        {selected.kind === "inv" && selected.index >= HOTBAR_SIZE && (
          <button
            className="px-btn px-btn-blue"
            onClick={props.onAddToHotbar}
          >
            Add to Hotbar
          </button>
        )}
        {selected.kind === "inv" && (
          <button
            className="px-btn px-btn-red"
            onClick={props.onDrop}
          >
            {selectedQuantity > 1 ? `Drop ×${selectedQuantity}` : "Drop"}
          </button>
        )}
        {selected.kind === "equip" && (
          <button
            className="px-btn px-btn-green"
            onClick={props.onUnequip}
          >
            Unequip
          </button>
        )}
        <button className="px-btn px-btn-grey" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function formatQty(n: number): string {
  if (n >= 1_000_000) return `${Math.floor(n / 100_000) / 10}M`;
  if (n >= 10_000) return `${Math.floor(n / 1000)}K`;
  return String(n);
}
