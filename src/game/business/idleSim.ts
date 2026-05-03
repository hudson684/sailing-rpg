/**
 * Closed-form idle simulation. Each `time:simTick` (every 10 in-game min,
 * 36× per phase) every owned business that the player isn't currently
 * sitting in earns one tick's worth of expected revenue, computed to match
 * what live mode would produce on average.
 */

import { bus } from "../bus";
import {
  minuteOfDay,
  MINUTES_PER_DAY,
  TICK_SIM_MINUTES,
  tickDurationMs,
  type Phase,
} from "../time/constants";
import { useBusinessStore } from "./businessStore";
import { businesses, businessKinds } from "./registry";
import { acceptanceFractionForWindow } from "./schedule";
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

/** Expected revenue for a window of `windowMs` real-ms during one tick for
 *  a single business. Mirrors the live spawn-and-serve loop: spawn rate ×
 *  window duration, capped by staff throughput, times the average price
 *  across eligible revenue sources. Returns 0 if the business can't make a
 *  sale (no unlocked menu has staff). */
export function getExpectedRevenueForWindow(
  state: BusinessState,
  kind: BusinessKindDef,
  windowMs: number,
): number {
  if (!state.owned) return 0;
  if (windowMs <= 0) return 0;
  const stats = getEffectiveStats(state, kind);
  const byRole = staffByRole(state);

  const eligible = kind.revenueSources.filter((s) => {
    if (!stats.unlockedMenus.has(s.id)) return false;
    return (byRole[s.requiresRole] ?? []).length > 0;
  });
  if (eligible.length === 0) return 0;

  const baseRate = spawnRatePerSecond(state, kind);
  if (baseRate <= 0) return 0;

  const customersFromSpawn = baseRate * (windowMs / 1000);

  let staffCount = 0;
  let weightedService = 0;
  for (const s of eligible) {
    const c = (byRole[s.requiresRole] ?? []).length;
    staffCount += c;
    weightedService += s.serviceTimeMs * c;
  }
  const avgServiceMs = staffCount > 0 ? weightedService / staffCount : 0;
  const throughputCap =
    avgServiceMs > 0 ? staffCount * (windowMs / avgServiceMs) : Infinity;

  const customers = Math.min(customersFromSpawn, throughputCap);

  let priceSum = 0;
  for (const s of eligible) priceSum += s.pricePerSale;
  const avgPrice = priceSum / eligible.length;

  return customers * avgPrice;
}

function applyTickTo(
  businessId: BusinessId,
  phase: Phase,
  dayCount: number,
  tickIndex: number,
): void {
  const def = businesses.tryGet(businessId);
  if (!def) return;

  const store = useBusinessStore.getState();
  store.setLastTick(businessId, { dayCount, phase, tickIndex });

  // Skip if the player is currently inside this interior — live sim is
  // already spawning customers there. (Plan §07 option A.)
  if (currentInteriorKey === def.interiorKey) return;

  const kind = businessKinds.tryGet(def.kindId);
  if (!kind) return;
  const state = store.get(businessId);
  if (!state || !state.owned) return;

  // Prorate by the share of this 10-min window the business is accepting
  // customers. acceptanceFractionForWindow samples at 10-min granularity
  // (matching the open/close buffer resolution), so for a one-tick window
  // this collapses to a single midpoint check.
  const tickMs = tickDurationMs(phase);
  const tickStartMs = tickIndex * tickMs;
  const tickStartMinute = minuteOfDay(phase, tickStartMs) % MINUTES_PER_DAY;
  const acceptanceFrac = acceptanceFractionForWindow(
    def.schedule,
    tickStartMinute,
    TICK_SIM_MINUTES,
  );
  if (acceptanceFrac <= 0) return;

  const revenue = getExpectedRevenueForWindow(state, kind, tickMs) * acceptanceFrac;
  const rounded = Math.round(revenue);
  if (rounded > 0) store.applyIdleTick(businessId, rounded, dayCount);
}

/** Wire idle revenue to `time:simTick`. Idempotent so HMR doesn't double-
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

  bus.onTyped("time:simTick", ({ phase, dayCount, tickIndex }) => {
    const ids = useBusinessStore.getState().ownedIds();
    for (const id of ids) applyTickTo(id, phase, dayCount, tickIndex);
  });
}
