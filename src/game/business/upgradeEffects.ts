/**
 * Pure applier for `UpgradeEffect[]`. Folds the kind's upgrade tree (limited
 * to nodes the business has actually unlocked) over a base view to produce
 * the effective stats used by sims and UI. State is never mutated — the
 * derived stats are recomputed on demand so saves stay stable.
 */

import type {
  BusinessKindDef,
  BusinessState,
  HiredNpc,
  UpgradeEffect,
  UpgradeNodeDef,
} from "./businessTypes";

export interface EffectiveStats {
  capacity: number;
  /** Multiplied onto each revenue source's `pricePerSale` at sale time. */
  revenuePerSaleBonus: number;
  /** Customer-spawn multiplier; 1 means baseline. */
  spawnMultiplier: number;
  /** Role ids unlocked beyond what the kind ships with. */
  unlockedRoles: Set<string>;
  /** Revenue-source ids the player has unlocked via the upgrade tree. */
  unlockedMenus: Set<string>;
}

function emptyStats(kind: BusinessKindDef): EffectiveStats {
  return {
    capacity: kind.defaultCapacity,
    revenuePerSaleBonus: 0,
    spawnMultiplier: 1,
    unlockedRoles: new Set(),
    unlockedMenus: new Set(),
  };
}

function applyEffect(stats: EffectiveStats, effect: UpgradeEffect): void {
  switch (effect.op) {
    case "+capacity":
      stats.capacity += effect.val;
      return;
    case "+revenuePerSale":
      stats.revenuePerSaleBonus += effect.val;
      return;
    case "+spawnMultiplier":
      stats.spawnMultiplier += effect.val;
      return;
    case "unlockRole":
      stats.unlockedRoles.add(effect.val);
      return;
    case "unlockMenu":
      stats.unlockedMenus.add(effect.val);
      return;
  }
}

export function getEffectiveStats(
  state: BusinessState,
  kind: BusinessKindDef,
): EffectiveStats {
  const stats = emptyStats(kind);
  const unlocked = new Set(state.unlockedNodes);
  for (const node of kind.upgradeTree) {
    if (!unlocked.has(node.id)) continue;
    for (const effect of node.effects) applyEffect(stats, effect);
  }
  return stats;
}

/** Group the staff list by role id. Used by the customer sim to find staff
 *  that can fulfill a given revenue source's `requiresRole`. */
export function staffByRole(
  state: BusinessState,
): Record<string, HiredNpc[]> {
  const out: Record<string, HiredNpc[]> = {};
  for (const s of state.staff) {
    (out[s.roleId] ??= []).push(s);
  }
  return out;
}

/** Customer-spawn rate per second for a business in the given phase. Scales
 *  with capacity, reputation (0.5×–1.5×), and per-profile phase multiplier
 *  (the caller usually averages or picks one — here we return the base rate
 *  WITHOUT the phase multiplier; sim folds that in per profile). */
export function spawnRatePerSecond(
  state: BusinessState,
  kind: BusinessKindDef,
): number {
  const stats = getEffectiveStats(state, kind);
  const base = stats.capacity / 60; // ~1 customer per minute per slot
  const repMult = 0.5 + state.reputation / 100;
  return base * repMult * stats.spawnMultiplier;
}

/** Find a node in the kind's upgrade tree by id. Returns null if missing. */
export function findUpgradeNode(
  kind: BusinessKindDef,
  nodeId: string,
): UpgradeNodeDef | null {
  return kind.upgradeTree.find((n) => n.id === nodeId) ?? null;
}

/** Are all of `node.requires` already in `unlockedNodes`? */
export function prerequisitesMet(
  node: UpgradeNodeDef,
  unlockedNodes: ReadonlyArray<string>,
): boolean {
  if (node.requires.length === 0) return true;
  const set = new Set(unlockedNodes);
  return node.requires.every((req) => set.has(req));
}
