import { z } from "zod";
import type { Saveable } from "./Saveable";
import type { Inventory } from "../inventory/Inventory";
import type { Player } from "../entities/Player";
import type { Ship } from "../entities/Ship";
import type { GroundItemsState } from "../world/groundItemsState";
import type { SceneState } from "./sceneState";
import { ALL_ITEM_IDS } from "../inventory/items";

// ─── Inventory ────────────────────────────────────────────────────────────

const ItemIdSchema = z.enum(ALL_ITEM_IDS as [string, ...string[]]);

const SlotSchema = z
  .object({ itemId: ItemIdSchema, quantity: z.number().int().positive() })
  .nullable();

const InventoryDataSchema = z.array(SlotSchema);

export function inventorySaveable(inv: Inventory): Saveable<z.infer<typeof InventoryDataSchema>> {
  return {
    id: "inventory",
    version: 1,
    schema: InventoryDataSchema,
    serialize: () => inv.serialize() as z.infer<typeof InventoryDataSchema>,
    hydrate: (data) => inv.hydrate(data as never),
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
  x: z.number(),
  y: z.number(),
  heading: HeadingSchema,
  mode: ShipModeSchema,
  speed: z.number(),
  targetThrottle: z.number().min(0).max(1),
  docked: DockedPoseSchema,
});

export function shipSaveable(ship: Ship): Saveable<z.infer<typeof ShipDataSchema>> {
  return {
    id: "ship",
    version: 1,
    schema: ShipDataSchema,
    serialize: () => ship.serialize(),
    hydrate: (data) => ship.hydrate(data),
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

// ─── Scene state (mode) ───────────────────────────────────────────────────

const SceneDataSchema = z.object({
  mode: z.enum(["OnFoot", "AtHelm", "Anchoring"]),
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
