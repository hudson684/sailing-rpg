import { create } from "zustand";
import { bus } from "../bus";
import { addToSlots } from "../inventory/operations";
import { CURRENCY_ITEM_ID } from "../inventory/items";
import { useGameStore } from "../store/gameStore";
import type { Slot } from "../inventory/types";
import { removeFromSlot } from "../inventory/operations";
import { businesses, businessKinds, ALL_BUSINESS_IDS } from "./registry";
import { findUpgradeNode, prerequisitesMet } from "./upgradeEffects";
import {
  BUSINESS_DEFAULT_REPUTATION,
  BUSINESS_LEDGER_CAP,
  type BusinessId,
  type BusinessState,
  type DailyEntry,
  type HiredNpc,
  type LastTickRef,
} from "./businessTypes";

// ─── Currency helpers (mirrors shopStore.ts) ──────────────────────────────

type Slots = ReadonlyArray<Slot | null>;

function countCurrency(slots: Slots): number {
  let total = 0;
  for (const s of slots)
    if (s && s.itemId === CURRENCY_ITEM_ID) total += s.quantity;
  return total;
}

function removeCurrency(
  slots: Slots,
  amount: number,
): { slots: Slots; removed: number } {
  let working: Slots = slots;
  let remaining = amount;
  for (let i = 0; i < working.length && remaining > 0; i++) {
    const s = working[i];
    if (!s || s.itemId !== CURRENCY_ITEM_ID) continue;
    const r = removeFromSlot(working, i, Math.min(s.quantity, remaining));
    working = r.slots;
    remaining -= r.removed;
    if (r.removed === 0) break;
  }
  return { slots: working, removed: amount - remaining };
}

// ─── Defaults / seeding ───────────────────────────────────────────────────

function seedState(id: BusinessId): BusinessState {
  return {
    id,
    owned: false,
    coffers: 0,
    unlockedNodes: [],
    staff: [],
    stock: {},
    reputation: BUSINESS_DEFAULT_REPUTATION,
    ledger: [],
    lastTick: null,
    todaysDraft: null,
  };
}

export function blankDraft(dayCount: number): import("./businessTypes").DailyEntry {
  return {
    dayCount,
    revenue: 0,
    expenses: 0,
    wages: 0,
    walkouts: 0,
  };
}

function seedAll(): Record<BusinessId, BusinessState> {
  const out: Record<BusinessId, BusinessState> = {};
  for (const id of ALL_BUSINESS_IDS) out[id] = seedState(id);
  return out;
}

// ─── Store ────────────────────────────────────────────────────────────────

export type PurchaseResult =
  | { ok: true }
  | { ok: false; reason: "alreadyOwned" | "unknownBusiness" | "insufficientCoin" | "inventoryFull" };

export type WalletResult =
  | { ok: true }
  | { ok: false; reason: "unknownBusiness" | "notOwned" | "insufficientFunds" | "inventoryFull" | "invalidAmount" };

export type UnlockResult =
  | { ok: true; cost: number }
  | {
      ok: false;
      reason:
        | "unknownBusiness"
        | "unknownNode"
        | "notOwned"
        | "alreadyUnlocked"
        | "missingPrerequisites"
        | "insufficientCoffers";
    };

export interface BusinessStoreState {
  byId: Record<BusinessId, BusinessState>;

  // Read
  get: (id: BusinessId) => BusinessState | null;
  all: () => BusinessState[];
  ownedIds: () => BusinessId[];

  // Lifecycle
  purchase: (id: BusinessId) => PurchaseResult;
  deposit: (id: BusinessId, amount: number) => WalletResult;
  withdraw: (id: BusinessId, amount: number) => WalletResult;
  /** Pay a node's cost from coffers and add it to `unlockedNodes`. Distinct
   *  from raw `unlockNode` (used by step 2 / save replay) which doesn't
   *  validate prereqs or charge. */
  tryUnlockNode: (id: BusinessId, nodeId: string) => UnlockResult;

  // Mutations used by later steps
  setCoffers: (id: BusinessId, n: number) => void;
  unlockNode: (id: BusinessId, nodeId: string) => void;
  addStaff: (id: BusinessId, hire: HiredNpc) => void;
  removeStaff: (id: BusinessId, hireableId: string) => void;
  /** Wholesale replace the staff list. Used by wage settlement to bump
   *  `unpaidDays` on every member (or zero them on a successful payday)
   *  without forcing the caller to round-trip through hire/fire. */
  replaceStaff: (id: BusinessId, staff: HiredNpc[]) => void;
  appendLedger: (id: BusinessId, entry: DailyEntry) => void;
  setStock: (id: BusinessId, itemId: string, qty: number) => void;
  setReputation: (id: BusinessId, value: number) => void;
  setLastTick: (id: BusinessId, ref: LastTickRef) => void;
  setTodaysDraft: (id: BusinessId, draft: DailyEntry | null) => void;
  /** Credit a sale: bump coffers, add to today's draft revenue, +1 small
   *  reputation bump (capped). */
  recordSale: (id: BusinessId, amount: number, dayCount: number) => void;
  /** Customer left without buying. Increments today's draft walkouts. */
  recordWalkout: (id: BusinessId, dayCount: number) => void;
  /** Closed-form idle credit for one in-game hour: bumps coffers and today's
   *  draft revenue. No reputation change — idle is passive book-keeping. */
  applyIdleHour: (id: BusinessId, amount: number, dayCount: number) => void;

  // Save lifecycle
  serialize: () => Record<BusinessId, BusinessState>;
  hydrate: (data: Record<BusinessId, BusinessState>) => void;
  reset: () => void;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function patch(
  set: (
    fn: (s: BusinessStoreState) => Partial<BusinessStoreState>,
  ) => void,
  id: BusinessId,
  mut: (s: BusinessState) => BusinessState,
) {
  set((store) => {
    const cur = store.byId[id];
    if (!cur) return {};
    return { byId: { ...store.byId, [id]: mut(cur) } };
  });
}

export const useBusinessStore = create<BusinessStoreState>()((set, get) => ({
  byId: seedAll(),

  get: (id) => get().byId[id] ?? null,
  all: () => Object.values(get().byId),
  ownedIds: () =>
    Object.values(get().byId)
      .filter((b) => b.owned)
      .map((b) => b.id),

  purchase: (id) => {
    const def = businesses.tryGet(id);
    if (!def) return { ok: false, reason: "unknownBusiness" };
    const cur = get().byId[id];
    if (!cur) return { ok: false, reason: "unknownBusiness" };
    if (cur.owned) return { ok: false, reason: "alreadyOwned" };

    const game = useGameStore.getState();
    const slots = game.inventory.slots;
    if (countCurrency(slots) < def.purchasePrice)
      return { ok: false, reason: "insufficientCoin" };

    const { slots: afterPay } = removeCurrency(slots, def.purchasePrice);
    game.inventoryHydrate(afterPay as never);

    patch(set, id, (s) => ({ ...s, owned: true }));
    return { ok: true };
  },

  deposit: (id, amount) => {
    if (!Number.isFinite(amount) || amount <= 0)
      return { ok: false, reason: "invalidAmount" };
    const cur = get().byId[id];
    if (!cur) return { ok: false, reason: "unknownBusiness" };
    if (!cur.owned) return { ok: false, reason: "notOwned" };

    const game = useGameStore.getState();
    const slots = game.inventory.slots;
    if (countCurrency(slots) < amount)
      return { ok: false, reason: "insufficientFunds" };

    const { slots: afterPay } = removeCurrency(slots, amount);
    game.inventoryHydrate(afterPay as never);
    patch(set, id, (s) => ({ ...s, coffers: s.coffers + amount }));
    return { ok: true };
  },

  withdraw: (id, amount) => {
    if (!Number.isFinite(amount) || amount <= 0)
      return { ok: false, reason: "invalidAmount" };
    const cur = get().byId[id];
    if (!cur) return { ok: false, reason: "unknownBusiness" };
    if (!cur.owned) return { ok: false, reason: "notOwned" };
    if (cur.coffers < amount)
      return { ok: false, reason: "insufficientFunds" };

    const game = useGameStore.getState();
    const { slots: afterAdd, leftover } = addToSlots(
      game.inventory.slots,
      CURRENCY_ITEM_ID,
      amount,
    );
    if (leftover > 0) return { ok: false, reason: "inventoryFull" };

    game.inventoryHydrate(afterAdd as never);
    patch(set, id, (s) => ({ ...s, coffers: s.coffers - amount }));
    return { ok: true };
  },

  tryUnlockNode: (id, nodeId) => {
    const def = businesses.tryGet(id);
    if (!def) return { ok: false, reason: "unknownBusiness" };
    const kind = businessKinds.tryGet(def.kindId);
    if (!kind) return { ok: false, reason: "unknownBusiness" };
    const cur = get().byId[id];
    if (!cur) return { ok: false, reason: "unknownBusiness" };
    if (!cur.owned) return { ok: false, reason: "notOwned" };
    const node = findUpgradeNode(kind, nodeId);
    if (!node) return { ok: false, reason: "unknownNode" };
    if (cur.unlockedNodes.includes(nodeId))
      return { ok: false, reason: "alreadyUnlocked" };
    if (!prerequisitesMet(node, cur.unlockedNodes))
      return { ok: false, reason: "missingPrerequisites" };
    if (cur.coffers < node.cost)
      return { ok: false, reason: "insufficientCoffers" };

    patch(set, id, (s) => ({
      ...s,
      coffers: s.coffers - node.cost,
      unlockedNodes: [...s.unlockedNodes, nodeId],
    }));
    return { ok: true, cost: node.cost };
  },

  setCoffers: (id, n) =>
    patch(set, id, (s) => ({ ...s, coffers: Math.max(0, n) })),

  unlockNode: (id, nodeId) =>
    patch(set, id, (s) =>
      s.unlockedNodes.includes(nodeId)
        ? s
        : { ...s, unlockedNodes: [...s.unlockedNodes, nodeId] },
    ),

  addStaff: (id, hire) => {
    patch(set, id, (s) => ({ ...s, staff: [...s.staff, hire] }));
    bus.emitTyped("business:staffChanged", { businessId: id });
  },

  removeStaff: (id, hireableId) => {
    patch(set, id, (s) => ({
      ...s,
      staff: s.staff.filter((h) => h.hireableId !== hireableId),
    }));
    bus.emitTyped("business:staffChanged", { businessId: id });
  },

  replaceStaff: (id, staff) => {
    patch(set, id, (s) => ({ ...s, staff }));
    // No "staffChanged" emit — wage settlement only mutates unpaidDays;
    // sprite identity / count is unchanged so the interior scene doesn't
    // need to despawn/respawn.
  },

  appendLedger: (id, entry) =>
    patch(set, id, (s) => ({
      ...s,
      ledger: [...s.ledger, entry].slice(-BUSINESS_LEDGER_CAP),
    })),

  setStock: (id, itemId, qty) =>
    patch(set, id, (s) => ({
      ...s,
      stock: { ...s.stock, [itemId]: Math.max(0, qty) },
    })),

  setReputation: (id, value) =>
    patch(set, id, (s) => ({ ...s, reputation: clamp(value, 0, 100) })),

  setLastTick: (id, ref) => patch(set, id, (s) => ({ ...s, lastTick: ref })),

  setTodaysDraft: (id, draft) =>
    patch(set, id, (s) => ({ ...s, todaysDraft: draft })),

  recordSale: (id, amount, dayCount) =>
    patch(set, id, (s) => {
      const draft = s.todaysDraft ?? blankDraft(dayCount);
      return {
        ...s,
        coffers: s.coffers + amount,
        reputation: clamp(s.reputation + 0.1, 0, 100),
        todaysDraft: { ...draft, revenue: draft.revenue + amount },
      };
    }),

  recordWalkout: (id, dayCount) =>
    patch(set, id, (s) => {
      const draft = s.todaysDraft ?? blankDraft(dayCount);
      return { ...s, todaysDraft: { ...draft, walkouts: draft.walkouts + 1 } };
    }),

  applyIdleHour: (id, amount, dayCount) =>
    patch(set, id, (s) => {
      const draft = s.todaysDraft ?? blankDraft(dayCount);
      return {
        ...s,
        coffers: s.coffers + amount,
        todaysDraft: { ...draft, revenue: draft.revenue + amount },
      };
    }),

  serialize: () => get().byId,

  hydrate: (data) => {
    // Merge: use save data where present, fall back to seed for any
    // newly-added BusinessDef the save predates.
    const merged: Record<BusinessId, BusinessState> = {};
    for (const id of ALL_BUSINESS_IDS) {
      merged[id] = data[id]
        ? { ...seedState(id), ...data[id] }
        : seedState(id);
    }
    for (const id of Object.keys(data)) {
      if (!ALL_BUSINESS_IDS.includes(id)) {
        // Save references a business we no longer ship — drop it.
        // eslint-disable-next-line no-console
        console.warn(`[businessStore] dropping unknown business "${id}"`);
      }
    }
    set({ byId: merged });
  },

  reset: () => set({ byId: seedAll() }),
}));
