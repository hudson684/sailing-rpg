import { useEffect, useMemo, useState } from "react";
import { EQUIP_SLOTS, ITEMS, type EquipSlot } from "../game/inventory/items";
import { computeEquippedStats } from "../game/equipment/operations";
import {
  selectEquipped,
  selectInventorySlots,
  useGameStore,
} from "../game/store/gameStore";
import { showToast } from "./store/ui";
import "./Equipment.css";

const SLOT_LABELS: Record<EquipSlot, string> = {
  weapon: "Weapon",
  head: "Head",
  body: "Body",
  hands: "Hands",
  feet: "Feet",
  trinket: "Trinket",
};

export function Equipment() {
  const equipped = useGameStore(selectEquipped);
  const stats = useMemo(() => computeEquippedStats(equipped), [equipped]);
  const inventory = useGameStore(selectInventorySlots);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "c") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  const handleUnequip = (slot: EquipSlot) => {
    const res = useGameStore.getState().unequip(slot);
    if (!res.ok && res.reason === "inventory_full") {
      showToast("Inventory full", 2000, "warn");
    }
  };

  const equippableInventory = inventory
    .map((s, i) => ({ slot: s, index: i }))
    .filter(({ slot }) => slot && ITEMS[slot.itemId].slot);

  return (
    <div className="eq-panel" role="region" aria-label="Equipment">
      <div className="eq-header">
        <span>Equipment</span>
        <button className="eq-close" onClick={() => setOpen(false)} aria-label="Close equipment">
          ×
        </button>
      </div>

      <div className="eq-slots">
        {EQUIP_SLOTS.map((slot) => {
          const id = equipped[slot];
          const def = id ? ITEMS[id] : null;
          return (
            <button
              key={slot}
              className={"eq-slot" + (def ? " eq-slot-filled" : "")}
              onClick={() => def && handleUnequip(slot)}
              title={def ? `${def.name} — click to unequip` : `Empty ${SLOT_LABELS[slot]}`}
            >
              <span className="eq-slot-label">{SLOT_LABELS[slot]}</span>
              {def ? (
                <span className="eq-icon" style={{ color: def.color }}>{def.icon}</span>
              ) : (
                <span className="eq-icon eq-icon-empty">—</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="eq-stats">
        <StatRow label="Max HP" value={stats.maxHp} />
        <StatRow label="Attack" value={stats.attack} />
        <StatRow label="Defense" value={stats.defense} />
        <StatRow label="Move" value={stats.moveSpeed} />
        <StatRow label="Sail" value={stats.sailSpeed} />
      </div>

      {equippableInventory.length > 0 && (
        <div className="eq-available">
          <div className="eq-available-label">Equippable in inventory</div>
          <div className="eq-available-list">
            {equippableInventory.map(({ slot, index }) => {
              const def = ITEMS[slot!.itemId];
              return (
                <button
                  key={index}
                  className="eq-available-item"
                  onClick={() => useGameStore.getState().equipFromInventory(index)}
                  title={`Equip ${def.name} (${def.slot})`}
                >
                  <span className="eq-icon" style={{ color: def.color }}>{def.icon}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="eq-footer">C: toggle · click slot to unequip</div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: number }) {
  return (
    <div className={"eq-stat" + (value !== 0 ? " eq-stat-active" : "")}>
      <span className="eq-stat-label">{label}</span>
      <span className="eq-stat-value">{formatStat(value)}</span>
    </div>
  );
}

function formatStat(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${n}` : String(n);
}
