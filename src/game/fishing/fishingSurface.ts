import type { Facing } from "../entities/playerAnims";

/**
 * Categories of water-like tile the player can fish from. Extensible: new
 * tiles can opt in via a Tiled `fishingSurface` custom property that matches
 * one of these ids (or introduces a brand-new one). Unknown strings returned
 * by the registry are passed through so catch tables can key off them
 * without a code change.
 */
export type FishingSurface =
  | "ocean"
  | "shallow"
  | "river"
  | "void"
  | "lava"
  | string;

/** 4-way facing offsets in tile coordinates. Diagonals collapse to their
 *  vertical component to match the existing adjacent-tile ergonomics (the
 *  player casts straight ahead, not diagonally). */
export function facingStep(facing: Facing): { dx: number; dy: number } {
  switch (facing) {
    case "up":
    case "up-left":
    case "up-right":
      return { dx: 0, dy: -1 };
    case "down":
    case "down-left":
    case "down-right":
      return { dx: 0, dy: 1 };
    case "left":
      return { dx: -1, dy: 0 };
    case "right":
      return { dx: 1, dy: 0 };
  }
}

/**
 * Pixel offset from the player's anchor (feet) to where the fishing line's
 * bobber lands, per facing. Tuned to the CF `fish` animation (rows 44/45/46)
 * so the bobber sprite visually attaches to the end of the line instead of
 * floating in the middle of an empty tile.
 */
export function bobberOffsetPx(facing: Facing): { dx: number; dy: number } {
  switch (facing) {
    case "right":
    case "up-right":
    case "down-right":
      return { dx: 40, dy: 22 };
    case "left":
    case "up-left":
    case "down-left":
      return { dx: -40, dy: 22 };
    case "up":
      return { dx: 0, dy: -40 };
    case "down":
      return { dx: 0, dy: 40 };
  }
}
