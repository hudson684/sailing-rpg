import { createRegistry } from "../data/createRegistry";

/**
 * Jobs are per-skill progression tracks. Each has an XP bucket and a derived
 * level (see xpTable). Start with a small, sailing-themed set — add more as
 * gameplay systems show up that need them.
 */
export type JobId =
  | "sailing"
  | "fishing"
  | "combat"
  | "exploration";

export type JobCategory = "seafaring" | "gathering" | "combat";

export interface JobDef {
  id: JobId;
  name: string;
  icon: string;
  color: string;
  category: JobCategory;
  description: string;
}

const DEFS: ReadonlyArray<JobDef> = [
  {
    id: "sailing",
    name: "Sailing",
    icon: "⛵",
    color: "#6bb7d6",
    category: "seafaring",
    description: "Your skill at the helm. Gained by time spent under sail.",
  },
  {
    id: "fishing",
    name: "Fishing",
    icon: "🎣",
    color: "#4a90a4",
    category: "gathering",
    description: "Patience, line, and knowing where the deep runs cold.",
  },
  {
    id: "combat",
    name: "Combat",
    icon: "⚔️",
    color: "#c94e4e",
    category: "combat",
    description: "Swordplay, boarding actions, and staying alive.",
  },
  {
    id: "exploration",
    name: "Exploration",
    icon: "🧭",
    color: "#b4c3d4",
    category: "seafaring",
    description: "Charting the unknown. Rewards seeing new shores.",
  },
];

export const jobs = createRegistry<JobDef>(DEFS, { label: "job" });

export const JOBS: Record<JobId, JobDef> = Object.fromEntries(
  DEFS.map((d) => [d.id, d]),
) as Record<JobId, JobDef>;

export const ALL_JOB_IDS: JobId[] = DEFS.map((d) => d.id);
