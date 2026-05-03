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
import { useTimeStore } from "../time/timeStore";
import { useBusinessStore } from "../business/businessStore";
import type { BusinessState } from "../business/businessTypes";
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
  vx: z.number(),
  vy: z.number(),
  docked: DockedPoseSchema,
});

const ShipsDataSchema = z.array(ShipDataSchema);

export function shipsSaveable(
  getShips: () => Ship[],
  hydrate: (states: z.infer<typeof ShipsDataSchema>) => void,
): Saveable<z.infer<typeof ShipsDataSchema>> {
  return {
    id: "ships",
    version: 2,
    schema: ShipsDataSchema,
    serialize: () => getShips().map((s) => s.serialize()),
    hydrate: (data) => hydrate(data),
    migrations: {
      // v1 stored throttle-based physics (speed/targetThrottle); v2 stores a
      // 2D velocity vector (vx/vy). Velocity is transient — zeroing it on load
      // preserves the player's sailing position + heading without guessing at
      // the old throttle-to-velocity mapping, which isn't lossless.
      1: (from) => {
        if (!Array.isArray(from)) return from;
        return from.map((entry) => {
          if (!entry || typeof entry !== "object") return entry;
          const { speed: _speed, targetThrottle: _targetThrottle, ...rest } =
            entry as Record<string, unknown>;
          return { ...rest, vx: 0, vy: 0 };
        });
      },
    },
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
  /** Added in v2 — `"world"` or `"interior:<key>"`. */
  mapId: z.string().min(1),
});

const DroppedItemsDataSchema = z.array(DroppedItemSchema);

export function droppedItemsSaveable(
  state: DroppedItemsState,
): Saveable<z.infer<typeof DroppedItemsDataSchema>> {
  return {
    id: "droppedItems",
    version: 2,
    schema: DroppedItemsDataSchema,
    serialize: () => state.serialize() as z.infer<typeof DroppedItemsDataSchema>,
    hydrate: (data) => state.hydrate(data as DroppedItem[]),
    migrations: {
      // v1 → v2: only the world had drops, so backfill mapId="world".
      1: (from) => {
        const arr = from as Array<Record<string, unknown>>;
        return arr.map((entry) => ({ ...entry, mapId: "world" }));
      },
    },
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

// ─── Time of day ──────────────────────────────────────────────────────────

// Older saves persisted `hoursEmittedThisPhase` (and later
// `quartersEmittedThisPhase`); the time store now emits a single sub-hour
// `simTick` (10 in-game min) and re-derives the count from
// `elapsedInPhaseMs` on load, so legacy fields are accepted but unused.
const TimeDataSchema = z.object({
  dayCount: z.number().int().positive(),
  phase: z.enum(["day", "night"]),
  elapsedInPhaseMs: z.number().nonnegative(),
  ticksEmittedThisPhase: z.number().int().nonnegative().optional(),
  hoursEmittedThisPhase: z.number().int().nonnegative().optional(),
  quartersEmittedThisPhase: z.number().int().nonnegative().optional(),
});

export function timeSaveable(): Saveable<z.infer<typeof TimeDataSchema>> {
  return {
    id: "time",
    version: 1,
    schema: TimeDataSchema,
    serialize: () => useTimeStore.getState().serialize(),
    hydrate: (data) => useTimeStore.getState().hydrate(data),
  };
}

// ─── Businesses ───────────────────────────────────────────────────────────

const HiredNpcSchema = z.object({
  hireableId: z.string().min(1),
  roleId: z.string().min(1),
  hiredOnDay: z.number().int().nonnegative(),
  unpaidDays: z.number().int().nonnegative(),
});

const DailyEntrySchema = z.object({
  dayCount: z.number().int().nonnegative(),
  revenue: z.number().nonnegative(),
  expenses: z.number().nonnegative(),
  wages: z.number().nonnegative(),
  walkouts: z.number().int().nonnegative(),
  note: z.string().optional(),
});

const LastTickRefSchema = z.object({
  dayCount: z.number().int().nonnegative(),
  phase: z.enum(["day", "night"]),
  tickIndex: z.number().int().nonnegative(),
});

const BusinessStateSchema = z.object({
  id: z.string().min(1),
  owned: z.boolean(),
  coffers: z.number().nonnegative(),
  unlockedNodes: z.array(z.string().min(1)),
  staff: z.array(HiredNpcSchema),
  stock: z.record(z.string().min(1), z.number().nonnegative()),
  reputation: z.number().min(0).max(100),
  ledger: z.array(DailyEntrySchema),
  lastTick: LastTickRefSchema.nullable(),
  todaysDraft: DailyEntrySchema.nullable().optional(),
});

const BusinessesDataSchema = z.record(z.string().min(1), BusinessStateSchema);

export function businessSaveable(): Saveable<z.infer<typeof BusinessesDataSchema>> {
  return {
    id: "businesses",
    version: 2,
    schema: BusinessesDataSchema,
    serialize: () =>
      useBusinessStore.getState().serialize() as z.infer<
        typeof BusinessesDataSchema
      >,
    hydrate: (data) =>
      useBusinessStore
        .getState()
        .hydrate(data as Record<string, BusinessState>),
    migrations: {
      // v1 → v2: sim cadence moved from `hourTick` (60 sim-min) to `simTick`
      // (10 sim-min). Each business's `lastTick.hourIndex` becomes
      // `tickIndex` scaled by TICKS_PER_HOUR (6) so the next tick after load
      // lands at roughly the same wall-time as the saved hour boundary.
      1: (data: unknown) => {
        if (!data || typeof data !== "object") return data;
        const out: Record<string, unknown> = {};
        for (const [id, raw] of Object.entries(data as Record<string, unknown>)) {
          if (!raw || typeof raw !== "object") {
            out[id] = raw;
            continue;
          }
          const b = raw as Record<string, unknown>;
          const lt = b.lastTick as
            | { dayCount: number; phase: string; hourIndex?: number; tickIndex?: number }
            | null
            | undefined;
          if (lt && lt.tickIndex === undefined && typeof lt.hourIndex === "number") {
            out[id] = {
              ...b,
              lastTick: {
                dayCount: lt.dayCount,
                phase: lt.phase,
                tickIndex: lt.hourIndex * 6,
              },
            };
          } else {
            out[id] = b;
          }
        }
        return out;
      },
    },
  };
}
