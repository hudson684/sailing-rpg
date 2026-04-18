// Player sprite animation config. Sheets are 79×79 frames laid out 3 rows
// deep — one row per facing direction. The visible character occupies a
// small region near the centre of each cell; feet sit at ~y=40.
//
//   row 0: side (E; W via flipX)
//   row 1: down (S — face visible)
//   row 2: up   (N — back of head)

export const PLAYER_ANIM_STATES = ["idle", "walk"] as const;
export const PLAYER_ANIM_DIRS = ["down", "side", "up"] as const;

export type PlayerAnimState = (typeof PLAYER_ANIM_STATES)[number];
export type PlayerAnimDir = (typeof PLAYER_ANIM_DIRS)[number];

export const PLAYER_FRAME_SIZE = 79;

// Frames per row (columns) for each state's sheet.
export const PLAYER_ANIM_COLS: Record<PlayerAnimState, number> = {
  idle: 4,
  walk: 8,
};

// Row index within the sheet for each direction.
export const PLAYER_ROW_FOR_DIR: Record<PlayerAnimDir, number> = {
  side: 0,
  down: 1,
  up: 2,
};

export const PLAYER_FRAME_RATE = 8;

export function playerTextureKey(state: PlayerAnimState): string {
  return `player-${state}`;
}

export function playerAnimKey(state: PlayerAnimState, dir: PlayerAnimDir): string {
  return `player-${state}-${dir}`;
}
