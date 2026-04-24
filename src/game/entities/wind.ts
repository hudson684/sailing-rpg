/** Global wind field. One instance lives on WorldScene; it updates every
 *  frame while sailing and exposes a force vector for `Ship.updateSailing`.
 *
 *  Physical model is intentionally simple: the wind has a current angle and
 *  strength (0..1), plus a slowly-shifting target pair. Every few dozen
 *  seconds the target is re-rolled and the current values ease toward it.
 *  No gusts, no prevailing direction, no map-region variation — those are
 *  easy to layer on later but this is enough to give sailing a readable
 *  "with the wind / against the wind" dimension.
 *
 *  The force returned by `vector()` is already scaled by `maxAccel`, so the
 *  ship doesn't need to know about `strength`. When the player has the helm
 *  we also emit the angle/strength to the HUD for the compass indicator. */

/** Max wind acceleration (px/s²) at strength=1. With exponential drag of
 *  0.55/s this saturates at ~80 px/s of passive drift — noticeable but well
 *  under a ship's active top speed, so a player can still make headway
 *  against a headwind, just slower. */
export const WIND_MAX_ACCEL = 45;

/** Re-roll bounds for the wind's next target pose (seconds). */
const SHIFT_MIN_SEC = 18;
const SHIFT_MAX_SEC = 42;

/** Exponential chase rates (1/s) for angle and strength toward their
 *  targets. Low enough that the wind moves on the order of tens of seconds,
 *  not instantaneously, which keeps it a navigational consideration rather
 *  than a reflex test. */
const ANGLE_CHASE = 0.35;
const STRENGTH_CHASE = 0.25;

/** Strength range the target re-roll picks from. Never goes fully calm —
 *  dead air would make the wind HUD misleading and players would wait for
 *  it to return instead of sailing. */
const STRENGTH_MIN = 0.35;
const STRENGTH_MAX = 1.0;

export class Wind {
  /** Current wind direction in radians. 0 = east, +π/2 = south, matching
   *  `Math.atan2(y, x)` / screen-space. */
  angle: number;
  /** Current wind strength, 0..1. Scaled by `WIND_MAX_ACCEL` at use. */
  strength: number;

  private targetAngle: number;
  private targetStrength: number;
  private secsUntilShift: number;

  constructor() {
    this.angle = Math.random() * Math.PI * 2;
    this.strength = STRENGTH_MIN + Math.random() * (STRENGTH_MAX - STRENGTH_MIN);
    this.targetAngle = this.angle;
    this.targetStrength = this.strength;
    this.secsUntilShift = Wind.rollShiftDelay();
  }

  private static rollShiftDelay(): number {
    return SHIFT_MIN_SEC + Math.random() * (SHIFT_MAX_SEC - SHIFT_MIN_SEC);
  }

  update(dtSec: number): void {
    this.secsUntilShift -= dtSec;
    if (this.secsUntilShift <= 0) {
      // New random direction and strength. Any direction is fair game; the
      // chase rate below smooths the transition so the player sees the wind
      // turn gradually on the HUD rather than teleport.
      this.targetAngle = Math.random() * Math.PI * 2;
      this.targetStrength = STRENGTH_MIN + Math.random() * (STRENGTH_MAX - STRENGTH_MIN);
      this.secsUntilShift = Wind.rollShiftDelay();
    }

    // Shortest-path angular approach: wrap diff into (-π, π] before easing.
    let diff = this.targetAngle - this.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const angleStep = Math.min(1, ANGLE_CHASE * dtSec);
    this.angle += diff * angleStep;
    // Keep angle in [0, 2π) for a clean HUD value.
    if (this.angle < 0) this.angle += Math.PI * 2;
    else if (this.angle >= Math.PI * 2) this.angle -= Math.PI * 2;

    const strStep = Math.min(1, STRENGTH_CHASE * dtSec);
    this.strength += (this.targetStrength - this.strength) * strStep;
  }

  /** Current wind acceleration vector (px/s²). */
  vector(): { x: number; y: number } {
    const a = this.strength * WIND_MAX_ACCEL;
    return { x: Math.cos(this.angle) * a, y: Math.sin(this.angle) * a };
  }
}
