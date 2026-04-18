import { ALL_JOB_IDS, type JobId } from "./jobs";
import { levelFromXp } from "./xpTable";

export type JobXp = Record<JobId, number>;

export function emptyJobXp(): JobXp {
  const out = {} as JobXp;
  for (const id of ALL_JOB_IDS) out[id] = 0;
  return out;
}

export interface AddXpResult {
  xp: JobXp;
  prevLevel: number;
  nextLevel: number;
}

/** Pure: returns new xp bucket with `amount` added to `jobId`. */
export function addXp(xp: JobXp, jobId: JobId, amount: number): AddXpResult {
  const prev = xp[jobId] ?? 0;
  const next = Math.max(0, prev + Math.max(0, Math.floor(amount)));
  return {
    xp: { ...xp, [jobId]: next },
    prevLevel: levelFromXp(prev),
    nextLevel: levelFromXp(next),
  };
}

/** Merge persisted data onto a fresh bucket — ignores unknown ids. */
export function hydrateJobXp(data: Partial<Record<string, number>>): JobXp {
  const out = emptyJobXp();
  for (const id of ALL_JOB_IDS) {
    const v = data[id];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[id] = v;
  }
  return out;
}
