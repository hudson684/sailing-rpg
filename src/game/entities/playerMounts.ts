import type { CfDir } from "./playerAnims";
import { CF_FRAME_SIZE } from "./playerAnims";
import horseBrownSheet from "../../assets/sprites/character/cf/mounts/horse-brown.png";

/**
 * Cute_Fantasy player mounts.
 *
 * Mount sheets render as a sprite behind every player layer in the player
 * Container. They animate independently of the wearable layer grid (the
 * player's own rider pose lives on rows 50–55 of every 9×56 layer sheet and
 * plays in lockstep off the `ride-idle` / `ride-gallop` CF states).
 */

export type CfMountState = "idle" | "gallop";

interface CfMountAnimRange {
  row: number;
  cols: number;
  fps: number;
}

export interface CfMountDef {
  id: string;
  textureKey: string;
  /** Sheet columns — used as the row stride when computing frame indices. */
  sheetCols: number;
  states: Record<CfMountState, Record<CfDir, CfMountAnimRange>>;
}

export interface CfMountSheet {
  textureKey: string;
  file: string;
  frameWidth: number;
  frameHeight: number;
}

export const CF_MOUNT_SHEETS: Record<string, CfMountSheet> = {
  horseBrown: {
    textureKey: "cf-mount-horse-brown",
    file: horseBrownSheet,
    frameWidth: CF_FRAME_SIZE,
    frameHeight: CF_FRAME_SIZE,
  },
};

// 384×384 → 6 cols × 6 rows. Rows 0-2 horse idle (2 frames each),
// rows 3-5 horse gallop (6 frames each).
export const CF_MOUNTS: Record<string, CfMountDef> = {
  "horse-brown": {
    id: "horse-brown",
    textureKey: CF_MOUNT_SHEETS.horseBrown.textureKey,
    sheetCols: 6,
    states: {
      idle: {
        forward: { row: 0, cols: 2, fps: 4 },
        right:   { row: 1, cols: 2, fps: 4 },
        back:    { row: 2, cols: 2, fps: 4 },
      },
      gallop: {
        forward: { row: 3, cols: 6, fps: 12 },
        right:   { row: 4, cols: 6, fps: 12 },
        back:    { row: 5, cols: 6, fps: 12 },
      },
    },
  },
};

export function cfMountAnimKey(id: string, state: CfMountState, dir: CfDir): string {
  return `cf-mount-${id}-${state}-${dir}`;
}
