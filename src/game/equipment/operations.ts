import { ITEMS, type EquipSlot, type ItemId, type ItemStats } from "../inventory/items";
import { addToSlots } from "../inventory/operations";
import type { Slot } from "../inventory/types";

export type Equipped = Partial<Record<EquipSlot, ItemId>>;

export interface EquipResult {
  inventory: (Slot | null)[];
  equipped: Equipped;
  ok: boolean;
  /** Reason for failure if ok=false. For UI messages. */
  reason?: "not_equippable" | "inventory_full";
}

/**
 * Move the item at `inventoryIndex` into its natural equipment slot. If the
 * slot is occupied, the currently-equipped item is swapped back into the
 * vacated inventory slot (one-for-one — always fits).
 *
 * Pure: returns new inventory + equipped maps. Caller commits to the store.
 */
export function equipFromInventory(
  inventory: ReadonlyArray<Slot | null>,
  equipped: Equipped,
  inventoryIndex: number,
): EquipResult {
  const slot = inventory[inventoryIndex];
  if (!slot) return fail(inventory, equipped, "not_equippable");
  const def = ITEMS[slot.itemId];
  if (!def.slot) return fail(inventory, equipped, "not_equippable");

  const equipSlot = def.slot;
  const previous = equipped[equipSlot];

  // Clone both collections.
  const nextInv = inventory.map((s) => (s ? { ...s } : null));
  const nextEq: Equipped = { ...equipped };

  // Remove 1 unit from the inventory slot. (Equippables are non-stackable
  // per ItemDef, so this always empties the slot.)
  nextInv[inventoryIndex] = null;
  if (previous) {
    nextInv[inventoryIndex] = { itemId: previous, quantity: 1 };
  }
  nextEq[equipSlot] = slot.itemId;

  return { inventory: nextInv, equipped: nextEq, ok: true };
}

export interface UnequipResult {
  inventory: (Slot | null)[];
  equipped: Equipped;
  ok: boolean;
  reason?: "empty" | "inventory_full";
}

/** Unequip the given slot, returning the item to inventory. */
export function unequip(
  inventory: ReadonlyArray<Slot | null>,
  equipped: Equipped,
  slot: EquipSlot,
): UnequipResult {
  const id = equipped[slot];
  if (!id) return { inventory: [...inventory], equipped, ok: false, reason: "empty" };

  const { slots: nextInv, leftover } = addToSlots(inventory, id, 1);
  if (leftover > 0) {
    return { inventory: [...inventory], equipped, ok: false, reason: "inventory_full" };
  }

  const nextEq: Equipped = { ...equipped };
  delete nextEq[slot];
  return { inventory: nextInv, equipped: nextEq, ok: true };
}

/** Aggregate stats across all equipped items. Missing fields contribute 0. */
export function computeEquippedStats(equipped: Equipped): Required<ItemStats> {
  const total: Required<ItemStats> = {
    maxHp: 0,
    attack: 0,
    defense: 0,
    moveSpeed: 0,
    sailSpeed: 0,
  };
  for (const id of Object.values(equipped)) {
    if (!id) continue;
    const stats = ITEMS[id].stats;
    if (!stats) continue;
    total.maxHp += stats.maxHp ?? 0;
    total.attack += stats.attack ?? 0;
    total.defense += stats.defense ?? 0;
    total.moveSpeed += stats.moveSpeed ?? 0;
    total.sailSpeed += stats.sailSpeed ?? 0;
  }
  return total;
}

/** Drop unknown ids and wrong-slot placements from persisted data. */
export function hydrateEquipped(data: Equipped): Equipped {
  const next: Equipped = {};
  for (const [slot, id] of Object.entries(data) as [EquipSlot, ItemId | undefined][]) {
    if (!id) continue;
    const def = ITEMS[id];
    if (!def || def.slot !== slot) continue;
    next[slot] = id;
  }
  return next;
}

function fail(
  inventory: ReadonlyArray<Slot | null>,
  equipped: Equipped,
  reason: EquipResult["reason"],
): EquipResult {
  return { inventory: [...inventory], equipped, ok: false, reason };
}
