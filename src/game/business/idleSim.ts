/**
 * Closed-form idle simulation. Each `time:hourTick` (6× per phase) every
 * owned business that the player isn't currently sitting in earns one
 * in-game hour's worth of expected revenue, computed to match what live
 * mode would produce on average.
 */

import { bus } from "../bus";
import { hourDurationMs, type Phase } from "../time/constants";
import { useBusinessStore } from "./businessStore";
import { businesses, businessKinds } from "./registry";
import {
  getEffectiveStats,
  spawnRatePerSecond,
  staffByRole,
} from "./upgradeEffects";
import type {
  BusinessId,
  BusinessKindDef,
  BusinessState,
} from "./businessTypes";

let currentInteriorKey: string | null = null;
let initialized = false;

/** Expected revenue for one in-game hour of `phase` for a single business.
 *  Mirrors the live spawn-and-serve loop: spawn rate × in-game hour duration,
 *  capped by staff throughput, times the average price across eligible
 *  revenue sources. Returns 0 if the business can't make a sale (no unlocked
 *  menu has staff). Shared with the Overview projection chart. */
export function getHourlyExpectedRevenue(
  state: BusinessState,
  kind: BusinessKindDef,
  phase: Phase,
): number {
  if (!state.owned) return 0;
  const stats = getEffectiveStats(state, kind);
  const byRole = staffByRole(state);

  const eligible = kind.revenueSources.filter((s) => {
    if (!stats.unlockedMenus.has(s.id)) return false;
    return (byRole[s.requiresRole] ?? []).length > 0;
  });
  if (eligible.length === 0) return 0;

  const baseRate = spawnRatePerSecond(state, kind);
  if (baseRate <= 0) return 0;

  const hourMs = hourDurationMs(phase);
  const customersFromSpawn = baseRate * (hourMs / 1000);

  let staffCount = 0;
  let weightedService = 0;
  for (const s of eligible) {
    const c = (byRole[s.requiresRole] ?? []).length;
    staffCount += c;
    weightedService += s.serviceTimeMs * c;
  }
  const avgServiceMs = staffCount > 0 ? weightedService / staffCount : 0;
  const throughputCap =
    avgServiceMs > 0 ? staffCount * (hourMs / avgServiceMs) : Infinity;

  const customers = Math.min(customersFromSpawn, throughputCap);

  let priceSum = 0;
  for (const s of eligible) priceSum += s.pricePerSale;
  const avgPrice = priceSum / eligible.length;

  return customers * avgPrice;
}

function applyHourTo(
  businessId: BusinessId,
  phase: Phase,
  dayCount: number,
  hourIndex: number,
): void {
  const def = businesses.tryGet(businessId);
  if (!def) return;

  const store = useBusinessStore.getState();
  store.setLastTick(businessId, { dayCount, phase, hourIndex });

  // Skip if the player is currently inside this interior — live sim is
  // already spawning customers there. (Plan §07 option A.)
  if (currentInteriorKey === def.interiorKey) return;

  const kind = businessKinds.tryGet(def.kindId);
  if (!kind) return;
  const state = store.get(businessId);
  if (!state || !state.owned) return;

  const revenue = getHourlyExpectedRevenue(state, kind, phase);
  const rounded = Math.round(revenue);
  if (rounded > 0) store.applyIdleHour(businessId, rounded, dayCount);
}

/** Wire idle revenue to `time:hourTick`. Idempotent so HMR doesn't double-
 *  subscribe. Also tracks the active map id so we can avoid double-counting
 *  the interior the player is currently inside. */
export function initIdleSimSubsystem(): void {
  if (initialized) return;
  initialized = true;

  bus.onTyped("world:mapEntered", ({ mapId }) => {
    currentInteriorKey = mapId.startsWith("interior:")
      ? mapId.slice("interior:".length)
      : null;
  });

  bus.onTyped("time:hourTick", ({ phase, dayCount, hourIndex }) => {
    const ids = useBusinessStore.getState().ownedIds();
    for (const id of ids) applyHourTo(id, phase, dayCount, hourIndex);
  });
}
