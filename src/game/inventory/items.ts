import { createRegistry } from "../data/createRegistry";

export type ItemId =
  | "rope"
  | "plank"
  | "fish"
  | "coin"
  | "compass"
  // equippables
  | "tricorn"
  | "sailors_coat"
  | "leather_boots"
  | "cutlass"
  | "signet_ring";

/**
 * Six equipment slots, picked to fit sailing + light swashbuckling combat.
 * Each equippable item pins itself to exactly one slot.
 */
export type EquipSlot =
  | "weapon"
  | "head"
  | "body"
  | "hands"
  | "feet"
  | "trinket";

export const EQUIP_SLOTS: readonly EquipSlot[] = [
  "weapon",
  "head",
  "body",
  "hands",
  "feet",
  "trinket",
] as const;

export type ItemType = "resource" | "weapon" | "armor" | "tool" | "consumable";

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
  slot?: EquipSlot;
  stats?: ItemStats;
}

const DEFS: ReadonlyArray<ItemDef> = [
  // ─── Resources / pickups ─────────────────────────────────────────
  {
    id: "rope",
    name: "Rope",
    icon: "🪢",
    color: "#c8a36a",
    stackable: true,
    maxStack: 50,
    description: "A coil of sturdy hemp rope.",
    type: "resource",
  },
  {
    id: "plank",
    name: "Plank",
    icon: "🪵",
    color: "#8b5a2b",
    stackable: true,
    maxStack: 50,
    description: "A length of weathered timber.",
    type: "resource",
  },
  {
    id: "fish",
    name: "Fish",
    icon: "🐟",
    color: "#6bb7d6",
    stackable: true,
    maxStack: 20,
    description: "Fresh from the sea.",
    type: "consumable",
  },
  {
    id: "coin",
    name: "Gold Coin",
    icon: "🪙",
    color: "#e5c14a",
    stackable: true,
    maxStack: 1000,
    description: "A doubloon bearing a weathered crest.",
    type: "resource",
  },
  {
    id: "compass",
    name: "Compass",
    icon: "🧭",
    color: "#b4c3d4",
    stackable: false,
    maxStack: 1,
    description: "Points true north, mostly.",
    type: "tool",
  },

  // ─── Equipment ───────────────────────────────────────────────────
  {
    id: "tricorn",
    name: "Tricorn Hat",
    icon: "🎩",
    color: "#2a2030",
    stackable: false,
    maxStack: 1,
    description: "Battered three-cornered hat. Makes you look the part.",
    type: "armor",
    slot: "head",
    stats: { defense: 1 },
  },
  {
    id: "sailors_coat",
    name: "Sailor's Coat",
    icon: "🧥",
    color: "#345c7a",
    stackable: false,
    maxStack: 1,
    description: "Salt-stained wool. Warmer than it looks.",
    type: "armor",
    slot: "body",
    stats: { maxHp: 5, defense: 2 },
  },
  {
    id: "leather_boots",
    name: "Leather Boots",
    icon: "🥾",
    color: "#6b4a2a",
    stackable: false,
    maxStack: 1,
    description: "Sturdy boots with good tread for wet decks.",
    type: "armor",
    slot: "feet",
    stats: { moveSpeed: 12 },
  },
  {
    id: "cutlass",
    name: "Cutlass",
    icon: "⚔️",
    color: "#c0c0c0",
    stackable: false,
    maxStack: 1,
    description: "A curved sword, well-balanced for close quarters.",
    type: "weapon",
    slot: "weapon",
    stats: { attack: 5 },
  },
  {
    id: "signet_ring",
    name: "Captain's Signet",
    icon: "💍",
    color: "#e5c14a",
    stackable: false,
    maxStack: 1,
    description: "Bronze ring bearing an unfamiliar crest. Feels lucky.",
    type: "armor",
    slot: "trinket",
    stats: { sailSpeed: 6, maxHp: 2 },
  },
];

export const items = createRegistry<ItemDef>(DEFS, { label: "item" });

/** Record view for ergonomic lookup by literal id. Equivalent to `items.get(id)`. */
export const ITEMS: Record<ItemId, ItemDef> = Object.fromEntries(
  DEFS.map((d) => [d.id, d]),
) as Record<ItemId, ItemDef>;

export const ALL_ITEM_IDS: ItemId[] = DEFS.map((d) => d.id);
