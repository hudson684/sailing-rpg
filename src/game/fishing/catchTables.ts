import type { ItemId } from "../inventory/items";
import type { FishingSurface } from "./fishingSurface";
import raw from "../data/fishingCatchTables.json";

interface CatchRoll {
  itemId: ItemId;
  weight: number;
  min: number;
  max: number;
}

interface CatchTablesFile {
  surfaces: Record<string, CatchRoll[]>;
  interiorOverrides?: Record<string, Record<string, CatchRoll[]>>;
}

const file = raw as CatchTablesFile;

export interface CatchResult {
  itemId: ItemId;
  quantity: number;
}

/** Pick a single catch from the table that best matches (surface, contextKey).
 *  Lookup order: interior override for the surface → global surface default.
 *  Returns null if no table exists for the surface in the given context
 *  (caller treats as "nothing biting here"). */
export function rollCatch(
  surface: FishingSurface,
  contextKey: string | null,
): CatchResult | null {
  const table = pickTable(surface, contextKey);
  if (!table || table.length === 0) return null;
  let total = 0;
  for (const r of table) total += Math.max(0, r.weight);
  if (total <= 0) return null;
  let pick = Math.random() * total;
  for (const r of table) {
    pick -= Math.max(0, r.weight);
    if (pick <= 0) {
      const qty = r.min + Math.floor(Math.random() * (r.max - r.min + 1));
      return { itemId: r.itemId, quantity: Math.max(1, qty) };
    }
  }
  const last = table[table.length - 1];
  return { itemId: last.itemId, quantity: Math.max(1, last.min) };
}

function pickTable(surface: string, contextKey: string | null): CatchRoll[] | undefined {
  if (contextKey) {
    const override = file.interiorOverrides?.[contextKey]?.[surface];
    if (override) return override;
  }
  return file.surfaces[surface];
}
