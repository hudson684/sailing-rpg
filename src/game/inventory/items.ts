export type ItemId = "rope" | "plank" | "fish" | "coin" | "compass";

export interface ItemDef {
  id: ItemId;
  name: string;
  icon: string;
  color: string;
  stackable: boolean;
  maxStack: number;
  description: string;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  rope: {
    id: "rope",
    name: "Rope",
    icon: "🪢",
    color: "#c8a36a",
    stackable: true,
    maxStack: 50,
    description: "A coil of sturdy hemp rope.",
  },
  plank: {
    id: "plank",
    name: "Plank",
    icon: "🪵",
    color: "#8b5a2b",
    stackable: true,
    maxStack: 50,
    description: "A length of weathered timber.",
  },
  fish: {
    id: "fish",
    name: "Fish",
    icon: "🐟",
    color: "#6bb7d6",
    stackable: true,
    maxStack: 20,
    description: "Fresh from the sea.",
  },
  coin: {
    id: "coin",
    name: "Gold Coin",
    icon: "🪙",
    color: "#e5c14a",
    stackable: true,
    maxStack: 1000,
    description: "A doubloon bearing a weathered crest.",
  },
  compass: {
    id: "compass",
    name: "Compass",
    icon: "🧭",
    color: "#b4c3d4",
    stackable: false,
    maxStack: 1,
    description: "Points true north, mostly.",
  },
};

export const ALL_ITEM_IDS: ItemId[] = Object.keys(ITEMS) as ItemId[];
