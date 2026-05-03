/**
 * Business system — generic property-ownership data model.
 *
 * `BusinessKindDef` describes a class of business (tavern, blacksmith…)
 * — what roles exist, what customers want, what upgrades unlock. It is
 * shared by every property of that kind.
 *
 * `BusinessDef` is one specific buyable property, pointing at a kind.
 *
 * `BusinessState` is the runtime per-property record persisted to saves.
 */

export type BusinessKindId = string;
export type BusinessId = string;
export type RoleId = string;

// ─── Definitions (data, immutable) ────────────────────────────────────────

export type UpgradeEffect =
  | { op: "+capacity"; val: number }
  | { op: "+revenuePerSale"; val: number }
  | { op: "unlockRole"; val: RoleId }
  | { op: "unlockMenu"; val: string }
  | { op: "+spawnMultiplier"; val: number };

export interface UpgradeNodeDef {
  id: string;
  displayName: string;
  description: string;
  kind: "repair" | "upgrade";
  cost: number;
  requires: string[];
  effects: UpgradeEffect[];
}

export interface RoleDef {
  id: RoleId;
  workstationTag: string;
  produces: string[];
}

export interface RevenueSourceDef {
  id: string;
  displayName: string;
  requiresRole: RoleId;
  pricePerSale: number;
  serviceTimeMs: number;
  requiresStock?: { itemId: string; qtyPerSale: number };
}

export interface CustomerProfileDef {
  id: string;
  displayName: string;
  spawnWeight: number;
  phaseMultiplier: { day: number; night: number };
  buys: string[];
}

export interface BusinessKindDef {
  id: BusinessKindId;
  displayName: string;
  defaultCapacity: number;
  roles: RoleDef[];
  revenueSources: RevenueSourceDef[];
  customerProfiles: CustomerProfileDef[];
  upgradeTree: UpgradeNodeDef[];
}

/** Optional opening-hours window for a business. Both fields are minute-of-
 *  day in [0, 1440); when `closeMinute < openMinute` the window wraps past
 *  midnight (e.g. 600/120 = 10:00 → 02:00 next day). Omit the schedule
 *  entirely for a 24/7 business. */
export interface BusinessSchedule {
  openMinute: number;
  closeMinute: number;
}

export interface BusinessDef {
  id: BusinessId;
  kindId: BusinessKindId;
  displayName: string;
  interiorKey: string;
  signObjectId: string;
  purchasePrice: number;
  schedule?: BusinessSchedule;
}

// ─── Runtime state (per save) ─────────────────────────────────────────────

export interface HiredNpc {
  hireableId: string;
  roleId: RoleId;
  hiredOnDay: number;
  unpaidDays: number;
}

export interface DailyEntry {
  dayCount: number;
  revenue: number;
  expenses: number;
  wages: number;
  walkouts: number;
  note?: string;
}

export interface LastTickRef {
  dayCount: number;
  phase: "day" | "night";
  hourIndex: number;
}

export interface BusinessState {
  id: BusinessId;
  owned: boolean;
  coffers: number;
  unlockedNodes: string[];
  staff: HiredNpc[];
  stock: Record<string, number>;
  reputation: number;
  ledger: DailyEntry[];
  lastTick: LastTickRef | null;
  /** Per-day rolling DailyEntry that the live customer sim accumulates into.
   *  Committed to `ledger[]` at day rollover (in `hireables.ts` alongside
   *  wage settlement) and reset to a blank entry for the new day. Null until
   *  the first sale/walkout of the day. */
  todaysDraft: DailyEntry | null;
}

export const BUSINESS_LEDGER_CAP = 30;
export const BUSINESS_DEFAULT_REPUTATION = 50;
