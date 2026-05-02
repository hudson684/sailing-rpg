import { bus } from "../bus";
import hireablesDataRaw from "../data/hireables.json";
import npcDataRaw from "../data/npcs.json";
import type { NpcData, NpcDef } from "../entities/npcTypes";
import { blankDraft, useBusinessStore } from "./businessStore";
import { businesses, businessKinds } from "./registry";
import type { BusinessId, HiredNpc, RoleId } from "./businessTypes";

export interface HireableDef {
  id: string;
  name: string;
  /** Pack key into `hireables.json#spritePacks`, which maps to an existing
   *  NPC id whose sheets are pre-loaded by the asset manifest. */
  spritePack: string;
  roles: RoleId[];
  skill: 1 | 2 | 3 | 4 | 5;
  wagePerDay: number;
  traits: string[];
}

interface HireablesFile {
  spritePacks: Record<string, string>;
  candidates: HireableDef[];
}

const HIREABLES = hireablesDataRaw as HireablesFile;
const HIREABLES_BY_ID: ReadonlyMap<string, HireableDef> = new Map(
  HIREABLES.candidates.map((h) => [h.id, h]),
);
const NPCS_BY_ID: ReadonlyMap<string, NpcDef> = new Map(
  (npcDataRaw as NpcData).npcs.map((n) => [n.id, n]),
);

/** How often the candidate slate refreshes, in in-game days. */
export const SLATE_REFRESH_DAYS = 2;
const SLATE_SIZE_MIN = 3;
const SLATE_SIZE_MAX = 5;
const UNPAID_REP_HIT = 4;

export function getHireable(id: string): HireableDef | null {
  return HIREABLES_BY_ID.get(id) ?? null;
}

/** Days remaining until the next slate refresh, given the current dayCount.
 *  Refresh days are multiples of `SLATE_REFRESH_DAYS`; report 0 on a refresh
 *  day so the UI can call out "fresh slate today". */
export function daysUntilSlateRefresh(dayCount: number): number {
  const mod = dayCount % SLATE_REFRESH_DAYS;
  return mod === 0 ? 0 : SLATE_REFRESH_DAYS - mod;
}

/** Deterministic hash of (dayCount, businessId). Used as the seed so the
 *  slate looks "rolled" but stays stable across React re-renders within the
 *  same in-game day. */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Compute the candidate slate for a business at a given day. The slate is
 *  derived (never persisted) — `(dayCount, businessId)` deterministically
 *  selects 3..5 candidates from the pool, excluding anyone already hired,
 *  and filters to candidates with at least one role this kind cares about. */
export function getSlate(businessId: BusinessId, dayCount: number): HireableDef[] {
  const def = businesses.tryGet(businessId);
  if (!def) return [];
  const kind = businessKinds.tryGet(def.kindId);
  if (!kind) return [];
  const kindRoles = new Set(kind.roles.map((r) => r.id));
  const state = useBusinessStore.getState().get(businessId);
  const hired = new Set((state?.staff ?? []).map((h) => h.hireableId));

  const eligible = HIREABLES.candidates.filter((h) => {
    if (hired.has(h.id)) return false;
    return h.roles.some((r) => kindRoles.has(r));
  });
  if (eligible.length === 0) return [];

  // Snap dayCount to the most recent refresh boundary so the slate stays
  // stable across the SLATE_REFRESH_DAYS window.
  const slateDay = dayCount - (dayCount % SLATE_REFRESH_DAYS);
  const rng = mulberry32(hash32(`${slateDay}|${businessId}`));

  const pool = [...eligible];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const size = Math.min(
    pool.length,
    SLATE_SIZE_MIN + Math.floor(rng() * (SLATE_SIZE_MAX - SLATE_SIZE_MIN + 1)),
  );
  return pool.slice(0, size);
}

export type HireResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "unknownBusiness"
        | "notOwned"
        | "unknownHireable"
        | "unknownRole"
        | "alreadyHired";
    };

/** Add the named hireable to a business's staff list at the given role. */
export function tryHire(
  businessId: BusinessId,
  hireableId: string,
  roleId: RoleId,
  dayCount: number,
): HireResult {
  const def = businesses.tryGet(businessId);
  if (!def) return { ok: false, reason: "unknownBusiness" };
  const kind = businessKinds.tryGet(def.kindId);
  if (!kind) return { ok: false, reason: "unknownBusiness" };
  const role = kind.roles.find((r) => r.id === roleId);
  if (!role) return { ok: false, reason: "unknownRole" };
  const hire = getHireable(hireableId);
  if (!hire) return { ok: false, reason: "unknownHireable" };
  if (!hire.roles.includes(roleId)) return { ok: false, reason: "unknownRole" };
  const state = useBusinessStore.getState().get(businessId);
  if (!state) return { ok: false, reason: "unknownBusiness" };
  if (!state.owned) return { ok: false, reason: "notOwned" };
  if (state.staff.some((s) => s.hireableId === hireableId)) {
    return { ok: false, reason: "alreadyHired" };
  }

  const entry: HiredNpc = {
    hireableId,
    roleId,
    hiredOnDay: dayCount,
    unpaidDays: 0,
  };
  useBusinessStore.getState().addStaff(businessId, entry);
  return { ok: true };
}

export function fire(businessId: BusinessId, hireableId: string): void {
  useBusinessStore.getState().removeStaff(businessId, hireableId);
}

/** Returns the source NPC def for a hireable's spritePack. We synthesize a
 *  per-hire NpcDef that copies this sprite block and sets `spritePackId` so
 *  texture/anim keys resolve to the source NPC's pre-loaded sheets. */
export function spritePackSourceNpc(packId: string): NpcDef | null {
  const sourceNpcId = HIREABLES.spritePacks[packId];
  if (!sourceNpcId) return null;
  return NPCS_BY_ID.get(sourceNpcId) ?? null;
}

// ─── Day rollover: commit draft + settle wages ───────────────────────────

/** Settle wages and commit the previous day's customer-sim draft into a
 *  single ledger entry, then start a fresh draft for the new day. Called
 *  on `time:phaseChange` to "day" — `newDayCount` has already incremented
 *  in `timeStore`, so the day that just ended is `newDayCount - 1`. */
function commitDay(businessId: BusinessId, newDayCount: number): void {
  const store = useBusinessStore.getState();
  const state = store.get(businessId);
  if (!state || !state.owned) return;

  const oldDay = newDayCount - 1;
  const draft = state.todaysDraft ?? blankDraft(oldDay);

  let totalWages = 0;
  for (const s of state.staff) {
    const hire = getHireable(s.hireableId);
    if (!hire) continue;
    totalWages += hire.wagePerDay;
  }

  let wagesPaid = 0;
  let note: string | undefined;
  if (totalWages > 0) {
    if (state.coffers >= totalWages) {
      wagesPaid = totalWages;
      store.setCoffers(businessId, state.coffers - totalWages);
      store.replaceStaff(
        businessId,
        state.staff.map((s) => ({ ...s, unpaidDays: 0 })),
      );
    } else {
      // All-or-nothing: don't pay anyone, bump every staff member's
      // unpaidDays, take a rep hit. Sharper bankruptcy signal.
      store.replaceStaff(
        businessId,
        state.staff.map((s) => ({ ...s, unpaidDays: s.unpaidDays + 1 })),
      );
      store.setReputation(businessId, state.reputation - UNPAID_REP_HIT);
      note = `Unpaid wages: ${totalWages} (coffers ${state.coffers})`;
    }
  }

  const entry = {
    dayCount: oldDay,
    revenue: draft.revenue,
    expenses: draft.expenses + wagesPaid,
    wages: wagesPaid,
    walkouts: draft.walkouts,
    ...(note ? { note } : {}),
  };
  // Skip empty days so an idle business doesn't accumulate noise entries.
  if (
    entry.revenue > 0 ||
    entry.expenses > 0 ||
    entry.walkouts > 0 ||
    entry.note
  ) {
    store.appendLedger(businessId, entry);
  }

  store.setTodaysDraft(businessId, blankDraft(newDayCount));
}

/** Commit the previous day for every owned business. Called at day rollover. */
export function commitDayForAll(newDayCount: number): void {
  const ids = useBusinessStore.getState().ownedIds();
  for (const id of ids) commitDay(id, newDayCount);
}

let initialized = false;

/** Wire wage settlement to `time:phaseChange` (day rollover). Idempotent so
 *  HMR doesn't double-subscribe. */
export function initHireablesSubsystem(): void {
  if (initialized) return;
  initialized = true;
  bus.onTyped("time:phaseChange", ({ phase, dayCount }) => {
    // Day rollover: phase transitioned night → day, dayCount has already
    // incremented in timeStore. (A "morning" tick is the natural payday.)
    if (phase !== "day") return;
    if (dayCount <= 1) return; // skip first-ever day so a fresh save isn't billed
    commitDayForAll(dayCount);
  });
}
