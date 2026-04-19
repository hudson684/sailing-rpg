import { z } from "zod";
import type { Saveable } from "./Saveable";
import type { Player } from "../entities/Player";
import type { Ship } from "../entities/Ship";
import type { GroundItemsState } from "../world/groundItemsState";
import type { DroppedItemsState, DroppedItem } from "../world/droppedItemsState";
import type { SceneState } from "./sceneState";
import { ALL_ITEM_IDS, EQUIP_SLOTS } from "../inventory/items";
import { useGameStore } from "../store/gameStore";
import { useShopStore } from "../store/shopStore";
import type { ShopInstance } from "../shops/types";
import { useSettingsStore } from "../store/settingsStore";
import { SKIN_PALETTE_IDS, type SkinPaletteId } from "../entities/playerSkin";
import { bus } from "../bus";
import type { Equipped } from "../equipment/operations";

// ─── Inventory ────────────────────────────────────────────────────────────

const ItemIdSchema = z.enum(ALL_ITEM_IDS as [string, ...string[]]);

const SlotSchema = z
  .object({ itemId: ItemIdSchema, quantity: z.number().int().positive() })
  .nullable();

const InventoryDataSchema = z.array(SlotSchema);

export function inventorySaveable(): Saveable<z.infer<typeof InventoryDataSchema>> {
  return {
    id: "inventory",
    version: 1,
    schema: InventoryDataSchema,
    serialize: () =>
      useGameStore.getState().inventory.slots as z.infer<typeof InventoryDataSchema>,
    hydrate: (data) => useGameStore.getState().inventoryHydrate(data as never),
  };
}

// ─── Equipment ────────────────────────────────────────────────────────────

const EquipSlotSchema = z.enum(EQUIP_SLOTS as unknown as [string, ...string[]]);
const EquippedSchema = z.record(EquipSlotSchema, ItemIdSchema);

export function equipmentSaveable(): Saveable<z.infer<typeof EquippedSchema>> {
  return {
    id: "equipment",
    version: 1,
    schema: EquippedSchema,
    serialize: () =>
      useGameStore.getState().equipment.equipped as z.infer<typeof EquippedSchema>,
    hydrate: (data) => useGameStore.getState().equipmentHydrate(data as Equipped),
  };
}

// ─── Jobs (XP) ────────────────────────────────────────────────────────────

const JobsDataSchema = z.record(z.string(), z.number().nonnegative());

export function jobsSaveable(): Saveable<z.infer<typeof JobsDataSchema>> {
  return {
    id: "jobs",
    version: 1,
    schema: JobsDataSchema,
    serialize: () =>
      useGameStore.getState().jobs.xp as z.infer<typeof JobsDataSchema>,
    hydrate: (data) => useGameStore.getState().jobsHydrate(data),
  };
}

// ─── Health ───────────────────────────────────────────────────────────────

const HealthDataSchema = z.object({
  current: z.number().nonnegative(),
});

export function healthSaveable(): Saveable<z.infer<typeof HealthDataSchema>> {
  return {
    id: "health",
    version: 1,
    schema: HealthDataSchema,
    serialize: () => ({ current: useGameStore.getState().health.current }),
    hydrate: (data) => useGameStore.getState().healthHydrate(data),
  };
}

// ─── Player ───────────────────────────────────────────────────────────────

const FacingSchema = z.enum([
  "up",
  "up-right",
  "right",
  "down-right",
  "down",
  "down-left",
  "left",
  "up-left",
]);
const PlayerDataSchema = z.object({
  x: z.number(),
  y: z.number(),
  facing: FacingSchema,
});

export function playerSaveable(player: Player): Saveable<z.infer<typeof PlayerDataSchema>> {
  return {
    id: "player",
    version: 1,
    schema: PlayerDataSchema,
    serialize: () => player.serialize(),
    hydrate: (data) => player.hydrate(data),
  };
}

// ─── Ship ─────────────────────────────────────────────────────────────────

const HeadingSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const ShipModeSchema = z.enum(["docked", "sailing", "anchoring"]);
const DockedPoseSchema = z.object({
  tx: z.number().int(),
  ty: z.number().int(),
  heading: HeadingSchema,
});

const ShipDataSchema = z.object({
  id: z.string().min(1),
  defId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  heading: HeadingSchema,
  mode: ShipModeSchema,
  speed: z.number(),
  targetThrottle: z.number().min(0).max(1),
  docked: DockedPoseSchema,
});

const ShipsDataSchema = z.array(ShipDataSchema);

export function shipsSaveable(
  getShips: () => Ship[],
  hydrate: (states: z.infer<typeof ShipsDataSchema>) => void,
): Saveable<z.infer<typeof ShipsDataSchema>> {
  return {
    id: "ships",
    version: 1,
    schema: ShipsDataSchema,
    serialize: () => getShips().map((s) => s.serialize()),
    hydrate: (data) => hydrate(data),
  };
}

// ─── Ground items (picked-up uids) ────────────────────────────────────────

const GroundItemsDataSchema = z.array(z.string().min(1));

export function groundItemsSaveable(
  state: GroundItemsState,
): Saveable<z.infer<typeof GroundItemsDataSchema>> {
  return {
    id: "groundItems",
    version: 1,
    schema: GroundItemsDataSchema,
    serialize: () => state.serialize(),
    hydrate: (data) => state.hydrate(data),
  };
}

// ─── Dropped items (player-dropped, with expiry) ──────────────────────────

const DroppedItemSchema = z.object({
  uid: z.string().min(1),
  itemId: ItemIdSchema,
  quantity: z.number().int().positive(),
  x: z.number(),
  y: z.number(),
  expiresAt: z.number().int().nonnegative(),
});

const DroppedItemsDataSchema = z.array(DroppedItemSchema);

export function droppedItemsSaveable(
  state: DroppedItemsState,
): Saveable<z.infer<typeof DroppedItemsDataSchema>> {
  return {
    id: "droppedItems",
    version: 1,
    schema: DroppedItemsDataSchema,
    serialize: () => state.serialize() as z.infer<typeof DroppedItemsDataSchema>,
    hydrate: (data) => state.hydrate(data as DroppedItem[]),
  };
}

// ─── Scene state (mode) ───────────────────────────────────────────────────

const InteriorReturnSchema = z.object({
  interiorKey: z.string().min(1),
  returnWorldTx: z.number().int(),
  returnWorldTy: z.number().int(),
  returnFacing: z.string(),
});

const SceneDataSchema = z.object({
  mode: z.enum(["OnFoot", "AtHelm", "Anchoring", "Interior"]),
  interior: InteriorReturnSchema.nullable().optional(),
});

export function sceneSaveable(scene: SceneState): Saveable<z.infer<typeof SceneDataSchema>> {
  return {
    id: "scene",
    version: 1,
    schema: SceneDataSchema,
    serialize: () => scene.serialize(),
    hydrate: (data) => scene.hydrate(data),
  };
}

// ─── Shops ────────────────────────────────────────────────────────────────

const ShopStockSchema = z.object({
  itemId: ItemIdSchema,
  quantity: z.number().int().nonnegative(),
});

const BuybackSchema = z.object({
  itemId: ItemIdSchema,
  quantity: z.number().int().positive(),
  expiresAt: z.number().int().nonnegative(),
});

const ShopInstanceSchema = z.object({
  restockAt: z.number().int().nonnegative(),
  stock: z.array(ShopStockSchema),
  buyback: z.array(BuybackSchema),
});

const ShopsDataSchema = z.record(z.string(), ShopInstanceSchema);

export function shopsSaveable(): Saveable<z.infer<typeof ShopsDataSchema>> {
  return {
    id: "shops",
    version: 1,
    schema: ShopsDataSchema,
    serialize: () =>
      useShopStore.getState().instances as z.infer<typeof ShopsDataSchema>,
    hydrate: (data) =>
      useShopStore.getState().hydrate(data as Record<string, ShopInstance>),
  };
}

// ─── Appearance (skin tone) ───────────────────────────────────────────────
// Skin is also mirrored in settingsStore (so it survives without a save), but
// we capture it per-slot so loading an old save restores the look it had then.

const AppearanceDataSchema = z.object({
  skinTone: z.enum(SKIN_PALETTE_IDS as [SkinPaletteId, ...SkinPaletteId[]]),
});

export function appearanceSaveable(): Saveable<z.infer<typeof AppearanceDataSchema>> {
  return {
    id: "appearance",
    version: 1,
    schema: AppearanceDataSchema,
    serialize: () => ({ skinTone: useSettingsStore.getState().skinTone }),
    hydrate: (data) => {
      useSettingsStore.getState().setSkinTone(data.skinTone);
      bus.emitTyped("skin:apply", data.skinTone);
    },
  };
}
