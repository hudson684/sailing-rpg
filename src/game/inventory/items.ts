import { createRegistry } from "../data/createRegistry";
import itemData from "../data/items.json";
import { iconForItem } from "./itemIcons";
import type { JobId } from "../jobs/jobs";

/**
 * Items are authored in `src/game/data/items.json` and resolved to fully-
 * formed `ItemDef` records at module load. Icons are bundler-imported in
 * `itemIcons.ts` and looked up by id — keeping this split lets designers
 * edit item metadata as data without touching TypeScript.
 *
 * `ItemId` is a runtime string — validity is guaranteed by the registry,
 * not the type system. If you need a literal union, `ALL_ITEM_IDS` is the
 * canonical source at runtime.
 */

export type ItemId = string;

/**
 * Nine concrete equipment slots, matching the paper-doll in UI_Premade.
 * Rings and trinkets come in pairs; items target them via the `ring` /
 * `trinket` families (see SlotFamily below).
 */
export type EquipSlot =
  | "head"
  | "body"
  | "legs"
  | "mainHand"
  | "offHand"
  | "ringL"
  | "ringR"
  | "trinketL"
  | "trinketR";

export const EQUIP_SLOTS: readonly EquipSlot[] = [
  "head",
  "body",
  "legs",
  "mainHand",
  "offHand",
  "ringL",
  "ringR",
  "trinketL",
  "trinketR",
] as const;

/**
 * What kind of slot an item fits into. Singletons map 1:1 to an EquipSlot;
 * `ring` and `trinket` can go in either of two positions.
 */
export type SlotFamily =
  | "head"
  | "body"
  | "legs"
  | "mainHand"
  | "offHand"
  | "ring"
  | "trinket";

export function slotsForFamily(family: SlotFamily): readonly EquipSlot[] {
  if (family === "ring") return ["ringL", "ringR"] as const;
  if (family === "trinket") return ["trinketL", "trinketR"] as const;
  return [family] as const;
}

export type ItemType = "resource" | "weapon" | "armor" | "tool" | "consumable" | "ammo";

/**
 * Flat stat deltas applied by equipped items. Missing fields read as 0.
 * Keep this set small — add fields only when something actually uses them.
 */
export interface ItemStats {
  maxHp?: number;
  attack?: number;
  defense?: number;
  /** Flat pixels/sec added to PLAYER_SPEED when on foot. */
  moveSpeed?: number;
  /** Flat bonus to ship speed when at the helm. */
  sailSpeed?: number;
  /** Fractional bonus to crafting-minigame fill per non-miss hit (0.25 = +25%).
   *  Read off the equipped mainHand by CraftingScene — no aggregation needed. */
  craftFillBonus?: number;
}

/**
 * Optional paper-doll layer this equippable contributes to. The Player reads
 * this when an item is equipped/unequipped and calls `setLayer(layer, variant)`
 * to swap the corresponding CF sprite sheet. `layer` must match a `CfLayer`
 * (base / feet / legs / chest / hands / hair / accessory / tool) and `variant`
 * must match the file basename loaded as `cf-<layer>-<variant>.png`.
 */
export interface VisualLayer {
  layer: "feet" | "legs" | "chest" | "hands" | "hair" | "accessory" | "tool";
  variant: string;
}

export interface ConsumableEffect {
  /** HP restored when the player uses this item. */
  healHp?: number;
}

/**
 * Ranged-weapon stats. Present only on weapons that fire a projectile.
 * `projectile` is the ItemId of the ammo consumed per shot.
 */
export interface RangedWeapon {
  rangePx: number;
  projectileSpeedPx: number;
  damage: number;
  projectile: ItemId;
  cooldownMs: number;
}

/** Melee-weapon stats. Present on weapons swung with Q. */
export interface MeleeWeapon {
  damageMin: number;
  damageMax: number;
}

/**
 * Shop pricing sold in fixed lots (e.g. "15 arrows for 5g"). When present,
 * the shop buys and sells this item only in multiples of `quantity`, at
 * `buyPrice` / `sellPrice` per bundle — `value` is ignored for shop math.
 */
export interface ItemBundle {
  quantity: number;
  buyPrice: number;
  sellPrice: number;
}

export interface ItemDef {
  id: ItemId;
  name: string;
  icon: string;
  color: string;
  stackable: boolean;
  maxStack: number;
  description: string;
  type: ItemType;
  slot?: SlotFamily;
  stats?: ItemStats;
  /** Job this item trains when used (gathering tools, weapons). */
  skill?: JobId;
  /** Paper-doll appearance — what to render on the player when equipped. */
  visualLayer?: VisualLayer;
  /** Effect applied when the player uses this item from the hotbar. */
  consumable?: ConsumableEffect;
  /** Ranged-weapon metadata. Present iff this item fires a projectile. */
  ranged?: RangedWeapon;
  /** Melee-weapon metadata. Present iff this item is swung with Q. */
  melee?: MeleeWeapon;
  /** Buy price at a shop. Sell price is floor(value / 2). Overridden by `bundle` when present. */
  value: number;
  /** Optional lot pricing — used instead of `value` when set. */
  bundle?: ItemBundle;
}

interface RawItem {
  id: string;
  name: string;
  color: string;
  stackable: boolean;
  maxStack: number;
  description: string;
  type: ItemType;
  slot?: SlotFamily;
  stats?: ItemStats;
  skill?: JobId;
  visualLayer?: VisualLayer;
  consumable?: ConsumableEffect;
  ranged?: RangedWeapon;
  melee?: MeleeWeapon;
  value: number;
  bundle?: ItemBundle;
}

const RAW = (itemData as unknown as { items: RawItem[] }).items;

const DEFS: ReadonlyArray<ItemDef> = RAW.map((r) => ({
  ...r,
  icon: iconForItem(r.id),
}));

export const items = createRegistry<ItemDef>(DEFS, { label: "item" });

/** Record view for ergonomic lookup by literal id. Equivalent to `items.get(id)`. */
export const ITEMS: Record<ItemId, ItemDef> = Object.fromEntries(
  DEFS.map((d) => [d.id, d]),
);

export const ALL_ITEM_IDS: ItemId[] = DEFS.map((d) => d.id);

/**
 * Minimum purchasable lot size. Normal items are sold one at a time; items
 * with a `bundle` only sell in multiples of `bundle.quantity`.
 */
export function itemBuyLot(id: ItemId): number {
  return items.tryGet(id)?.bundle?.quantity ?? 1;
}

/** Minimum sellable lot size. Mirrors `itemBuyLot` today. */
export function itemSellLot(id: ItemId): number {
  return items.tryGet(id)?.bundle?.quantity ?? 1;
}

/**
 * Total buy price for `qty` of this item. Callers must ensure `qty` is a
 * multiple of `itemBuyLot(id)` — fractional lots are floored.
 */
export function itemBuyPriceFor(id: ItemId, qty: number): number {
  const def = items.tryGet(id);
  if (!def) return 0;
  if (def.bundle) return Math.floor(qty / def.bundle.quantity) * def.bundle.buyPrice;
  return def.value * qty;
}

/**
 * Total price a shop pays the player for selling `qty` of this item. Callers
 * must ensure `qty` is a multiple of `itemSellLot(id)`.
 */
export function itemSellPriceFor(id: ItemId, qty: number): number {
  const def = items.tryGet(id);
  if (!def) return 0;
  if (def.bundle) return Math.floor(qty / def.bundle.quantity) * def.bundle.sellPrice;
  return Math.floor(def.value / 2) * qty;
}

/** Does any shop pay anything for this item? Used to hide zero-value items in the sell tab. */
export function itemIsSellable(id: ItemId): boolean {
  const def = items.tryGet(id);
  if (!def) return false;
  if (def.bundle) return def.bundle.sellPrice > 0;
  return Math.floor(def.value / 2) > 0;
}

/** Currency item id. Kept in one place so every buy/sell reads the same. */
export const CURRENCY_ITEM_ID: ItemId = "coin";
