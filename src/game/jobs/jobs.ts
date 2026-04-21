import { createRegistry } from "../data/createRegistry";
import iconSailor from "../../ui/icons/jobs/job_sailor.png";
import iconFisher from "../../ui/icons/jobs/job_fisher.png";
import iconWarrior from "../../ui/icons/jobs/job_warrior.png";
import iconRanger from "../../ui/icons/jobs/job_ranger.png";
import iconOrecheologist from "../../ui/icons/jobs/job_orecheologist.png";
import iconLumberjack from "../../ui/icons/jobs/job_lumberjack.png";

/**
 * Jobs are per-skill progression tracks. Each has an XP bucket and a derived
 * level (see xpTable). Start with a small, sailing-themed set — add more as
 * gameplay systems show up that need them.
 */
export type JobId =
  | "sailing"
  | "fishing"
  | "combat"
  | "ranger"
  | "orecheologist"
  | "lumberjack"
  | "blacksmith";

export type JobCategory = "seafaring" | "gathering" | "combat" | "crafting";

function emojiJobIcon(glyph: string): string {
  // SVG data-URL fallback for jobs without a shipped PNG. Kept inline so the
  // bundler doesn't have to resolve an import. Matches the approach used by
  // itemIcons.ts for placeholder item icons.
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>` +
    `<text x='16' y='24' font-size='22' text-anchor='middle'` +
    ` font-family='Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif'>` +
    `${glyph}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

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
    icon: iconSailor,
    color: "#6bb7d6",
    category: "seafaring",
    description: "Your skill at the helm. Gained by time spent under sail.",
  },
  {
    id: "fishing",
    name: "Fishing",
    icon: iconFisher,
    color: "#4a90a4",
    category: "gathering",
    description: "Patience, line, and knowing where the deep runs cold.",
  },
  {
    id: "orecheologist",
    name: "Orecheologist",
    icon: iconOrecheologist,
    color: "#b07a3a",
    category: "gathering",
    description: "Student of stone and seam. Gained by swinging a pickaxe.",
  },
  {
    id: "lumberjack",
    name: "Lumberjack",
    icon: iconLumberjack,
    color: "#5a8a3a",
    category: "gathering",
    description: "Felling timber. Gained by swinging an axe at trees.",
  },
  {
    id: "combat",
    name: "Combat",
    icon: iconWarrior,
    color: "#c94e4e",
    category: "combat",
    description: "Swordplay, boarding actions, and staying alive.",
  },
  {
    id: "ranger",
    name: "Ranger",
    icon: iconRanger,
    color: "#4e8a55",
    category: "combat",
    description: "Marksmanship with bow and arrow. Gained by ranged combat.",
  },
  {
    id: "blacksmith",
    name: "Blacksmith",
    icon: emojiJobIcon("⚒️"),
    color: "#a05a2a",
    category: "crafting",
    description: "Smelting ore and shaping steel at the forge.",
  },
];

export const jobs = createRegistry<JobDef>(DEFS, { label: "job" });

export const JOBS: Record<JobId, JobDef> = Object.fromEntries(
  DEFS.map((d) => [d.id, d]),
) as Record<JobId, JobDef>;

export const ALL_JOB_IDS: JobId[] = DEFS.map((d) => d.id);
