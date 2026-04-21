import { addToSlots, removeFromSlot } from "../inventory/operations";
import type { Slot } from "../inventory/types";
import type { ItemId } from "../inventory/items";
import type { RecipeDef } from "./types";

/**
 * Pure helpers for validating and applying a craft against an inventory
 * snapshot. Separated from the store so they can be unit-tested without a
 * React render, and so the minigame scene can peek at "can we still craft?"
 * without mutating anything.
 */

export function countInInventory(
  slots: ReadonlyArray<Slot | null>,
  itemId: ItemId,
): number {
  let total = 0;
  for (const s of slots) if (s && s.itemId === itemId) total += s.quantity;
  return total;
}

export function hasAllInputs(
  slots: ReadonlyArray<Slot | null>,
  recipe: RecipeDef,
): boolean {
  for (const inp of recipe.inputs) {
    if (countInInventory(slots, inp.itemId) < inp.qty) return false;
  }
  return true;
}

export interface ApplyResult {
  slots: (Slot | null)[];
  ok: boolean;
  /** Populated when ok=false: the input that ran out. */
  missing?: ItemId;
  /** Populated when ok=true: output units that didn't fit (inventory full). */
  leftoverOutput?: number;
}

/**
 * Consume recipe inputs from `slots` and add `outputMultiplier * output.qty`
 * units of the output item. Returns a new slots array plus status flags.
 * Use `outputMultiplier` to scale reward by craft tier (e.g. 2 for Perfect).
 */
export function applyCraft(
  slots: ReadonlyArray<Slot | null>,
  recipe: RecipeDef,
  outputMultiplier = 1,
): ApplyResult {
  // First pass: validate everything is present. Bail before mutating if not.
  for (const inp of recipe.inputs) {
    if (countInInventory(slots, inp.itemId) < inp.qty) {
      return { slots: slots.map((s) => (s ? { ...s } : null)), ok: false, missing: inp.itemId };
    }
  }

  let working: ReadonlyArray<Slot | null> = slots;
  for (const inp of recipe.inputs) {
    let remaining = inp.qty;
    for (let i = 0; i < working.length && remaining > 0; i++) {
      const s = working[i];
      if (!s || s.itemId !== inp.itemId) continue;
      const take = Math.min(s.quantity, remaining);
      const r = removeFromSlot(working, i, take);
      working = r.slots;
      remaining -= r.removed;
    }
  }

  const outQty = Math.max(1, Math.floor(recipe.output.qty * outputMultiplier));
  const add = addToSlots(working, recipe.output.itemId, outQty);
  return { slots: add.slots, ok: true, leftoverOutput: add.leftover };
}
