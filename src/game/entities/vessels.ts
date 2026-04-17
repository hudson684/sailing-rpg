// Vessel templates + animation naming. Each vessel ships as per-direction
// spritesheets (up / down / sideways) with an idle and a sailing variant laid
// out on a grid. "sideways" covers both east and west via horizontal flip, so
// three sheets cover four cardinal headings.

export const VESSEL_ANIM_STATES = ["idle", "sailing"] as const;
export const VESSEL_ANIM_DIRS = ["up", "down", "sideways"] as const;

export type VesselAnimState = (typeof VESSEL_ANIM_STATES)[number];
export type VesselAnimDir = (typeof VESSEL_ANIM_DIRS)[number];

export interface VesselTemplate {
  /** Stable id, also used as texture-key / anim-key prefix. */
  id: "rowboat" | "galleon";
  /** Path prefix under /sprites. The loader composes `${spritePrefix}-${state}-${dir}.png`. */
  spritePrefix: string;
  /** Spritesheet layout. */
  frame: { width: number; height: number };
  /** Frame count per animation state (grids can have trailing blanks — we only play these). */
  frames: Record<VesselAnimState, number>;
  /** Uniform render scale applied to the sprite. */
  scale: number;
  /** Logical footprint in tiles when east/west-facing; the orthogonal axis is the smaller dim. */
  tilesLong: number;
  tilesWide: number;
  /** Animation frame rate (fps). */
  frameRate: number;
}

export const VESSEL_TEMPLATES: Record<VesselTemplate["id"], VesselTemplate> = {
  rowboat: {
    id: "rowboat",
    spritePrefix: "boat/boat",
    frame: { width: 288, height: 256 },
    frames: { idle: 14, sailing: 14 },
    scale: 0.4,
    tilesLong: 3,
    tilesWide: 2,
    frameRate: 12,
  },
  galleon: {
    id: "galleon",
    spritePrefix: "ship/ship",
    frame: { width: 608, height: 640 },
    // Per-state frame counts differ: idle packs 4×4=16 cells (15 frames + 1 blank);
    // sailing packs 5×4=20 cells (17 frames + 3 blanks).
    frames: { idle: 15, sailing: 17 },
    scale: 1,
    // Logical footprint (5×3) is kept smaller than the visual for now — the
    // galleon is decorative, so only `scale` drives how it renders. If/when
    // it becomes boardable, align these with the visible hull.
    tilesLong: 5,
    tilesWide: 3,
    frameRate: 12,
  },
};

export function vesselTextureKey(vessel: VesselTemplate, state: VesselAnimState, dir: VesselAnimDir): string {
  return `${vessel.id}-${state}-${dir}`;
}

export function vesselAnimKey(vessel: VesselTemplate, state: VesselAnimState, dir: VesselAnimDir): string {
  return `${vessel.id}-${state}-${dir}`;
}

/** Pick the direction-sheet + flipX for a cardinal heading. 0=N, 1=E, 2=S, 3=W. */
export function headingToVesselDir(heading: 0 | 1 | 2 | 3): { dir: VesselAnimDir; flipX: boolean } {
  switch (heading) {
    case 0: return { dir: "up", flipX: false };
    case 1: return { dir: "sideways", flipX: false };
    case 2: return { dir: "down", flipX: false };
    case 3: return { dir: "sideways", flipX: true };
  }
}
