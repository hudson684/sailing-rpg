// Player sprite animation config. Each state has its own sheet; the base
// idle/walk sheets are 79×79 3-row (side/down/up). The attack sheet is
// 80×80 with a 4-row (up/side-left/down/side-right) layout — we pick one
// side row and flip for the other.

export const PLAYER_ANIM_STATES = ["idle", "walk", "attack"] as const;
export const PLAYER_ANIM_DIRS = ["down", "side", "up"] as const;

export type PlayerAnimState = (typeof PLAYER_ANIM_STATES)[number];
export type PlayerAnimDir = (typeof PLAYER_ANIM_DIRS)[number];

// Frame size of the idle/walk sheets — used for on-screen scaling / origin.
export const PLAYER_FRAME_SIZE = 79;

export interface PlayerSheetConfig {
  frameSize: number;
  cols: number;
  rows: Record<PlayerAnimDir, number>;
  frameRate: number;
  repeat: number;
}

export const PLAYER_ANIM_SHEETS: Record<PlayerAnimState, PlayerSheetConfig> = {
  idle:   { frameSize: 79, cols: 4, rows: { side: 0, down: 1, up: 2 }, frameRate: 4,  repeat: -1 },
  walk:   { frameSize: 79, cols: 8, rows: { side: 0, down: 1, up: 2 }, frameRate: 8,  repeat: -1 },
  attack: { frameSize: 79, cols: 6, rows: { side: 0, down: 1, up: 2 }, frameRate: 14, repeat:  0 },
};

export function playerTextureKey(state: PlayerAnimState): string {
  return `player-${state}`;
}

export function playerAnimKey(state: PlayerAnimState, dir: PlayerAnimDir): string {
  return `player-${state}-${dir}`;
}
