import * as Phaser from "phaser";
import { Player, PLAYER_SPEED } from "../entities/Player";
import { stamina } from "./stamina";
import type { Slope } from "../world/tileRegistry";

const SPRINT_SPEED_MULT = 1.35;

export interface MovementKeys {
  up: Phaser.Input.Keyboard.Key;
  down: Phaser.Input.Keyboard.Key;
  left: Phaser.Input.Keyboard.Key;
  right: Phaser.Input.Keyboard.Key;
  w: Phaser.Input.Keyboard.Key;
  a: Phaser.Input.Keyboard.Key;
  s: Phaser.Input.Keyboard.Key;
  d: Phaser.Input.Keyboard.Key;
  sprint: Phaser.Input.Keyboard.Key;
}

export interface MovementOptions {
  keys: MovementKeys;
  player: Player;
  isWalkablePx: (px: number, py: number) => boolean;
  slopeAtPx?: (px: number, py: number) => Slope | null;
  /** Optional mount hook. When `isMounted()` returns true, sprint is disabled
   *  (mounts cruise at their own speed without burning stamina) and
   *  `mountSpeedMult` is used as the speed multiplier. WorldScene wires this;
   *  InteriorScene leaves both undefined. */
  isMounted?: () => boolean;
  mountSpeedMult?: number;
}

/** Reads movement keys, normalizes diagonals, applies sprint/mount speed
 *  multipliers, and forwards to `Player.tryMove`. Both WorldScene and
 *  InteriorScene's on-foot updates were running this same loop with only
 *  walkability/slope/mount differences. */
export class MovementController {
  private readonly opts: MovementOptions;

  constructor(opts: MovementOptions) {
    this.opts = opts;
  }

  update(dt: number): void {
    const { keys, player, isWalkablePx, slopeAtPx, isMounted, mountSpeedMult } = this.opts;
    let dx = 0;
    let dy = 0;
    if (keys.left.isDown || keys.a.isDown) dx -= 1;
    if (keys.right.isDown || keys.d.isDown) dx += 1;
    if (keys.up.isDown || keys.w.isDown) dy -= 1;
    if (keys.down.isDown || keys.s.isDown) dy += 1;
    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.SQRT2;
      dx *= inv;
      dy *= inv;
    }
    const moving = dx !== 0 || dy !== 0;
    const mounted = isMounted?.() ?? false;
    const sprinting = !mounted && moving && keys.sprint.isDown && stamina.current > 0;
    if (sprinting) stamina.drain(dt);
    let mult = 1;
    if (mounted) mult = mountSpeedMult ?? 1;
    else if (sprinting) mult = SPRINT_SPEED_MULT;
    const speed = PLAYER_SPEED * mult;
    player.tryMove(dx * speed * dt, dy * speed * dt, isWalkablePx, slopeAtPx);
  }
}
