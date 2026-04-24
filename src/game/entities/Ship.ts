import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { type VesselTemplate } from "./vessels";
import { createShipVisual, type HelmRect, type HitboxRect, type ShipVisualLayers } from "./shipTilemap";

export type Heading = 0 | 1 | 2 | 3; // 0=N, 1=E, 2=S, 3=W

export type ShipMode = "docked" | "sailing" | "anchoring";

/** Sail state — a discrete "how much canvas is up" setting the player
 *  manages while sailing. More sail = more speed and wind, but also less
 *  maneuverability and risk of being overpowered in a gale. Furled is the
 *  "just drifting" state; trim is the default cruising state. */
export type SailState = "furled" | "reefed" | "trim" | "full";

/** Ordered list used when stepping sail state with the reef / ease keys. */
export const SAIL_STATES: readonly SailState[] = ["furled", "reefed", "trim", "full"];

export interface DockedPose {
  tx: number;
  ty: number;
  heading: Heading;
}

/** Tile dimensions used by footprint / bbox math. tilesLong is the bow-to-stern axis. */
export interface VesselDims {
  tilesLong: number;
  tilesWide: number;
}

/** Max velocity magnitude before the cap kicks in. Tailwind can lift a ship
 *  toward this faster than dead calm, but it's always the ceiling. */
export const SHIP_MAX_SPEED = 140;
/** Thrust acceleration (px/s^2) applied in the heading's direction while a
 *  movement key is held. Tuned higher than drag so held keys feel responsive. */
const SHIP_ACCEL = 110;
/** Exponential drag coefficients (1/s), split by axis relative to the
 *  ship's heading. Velocity is decomposed into an `along` component (down
 *  the keel) and a `lateral` component (beam-wise); each decays as
 *  `v *= exp(-k * dt)` with its own rate. Along-heading drag is low so the
 *  ship glides nicely when steering is released. Lateral drag is much
 *  higher because a hull moving sideways presents its whole broadside to
 *  the water. Two consequences:
 *    1. Yaw inertia. A turn doesn't rotate momentum — it reclassifies the
 *       old direction of travel as *lateral* velocity, which then bleeds
 *       off over ~1 s. The ship visibly carries drift through the arc.
 *    2. Leeway cap. Wind pushing sideways still builds lateral velocity,
 *       but the higher lateral drag pins its steady-state well below what
 *       a tailwind could drive forward. */
const SHIP_DRAG_ALONG_COEF = 0.55;
const SHIP_DRAG_LATERAL_COEF = 1.5;
/** Speeds below this (px/s) snap to zero once the ship is idle (no thrust,
 *  no wind). Prevents asymptotic crawling that never quite stops. */
const SHIP_IDLE_SNAP = 2;
/** Duration of the visual crossfade (ms) between cardinal sprites when
 *  the continuous heading rotates across a 45° boundary. Purely cosmetic
 *  now that rotation itself is a physics quantity (headingRad); the
 *  crossfade just keeps the sprite swap smooth instead of popping. */
const SHIP_SPRITE_CROSSFADE_MS = 260;
/** Baseline rotation rate (rad/s) at sail = trim. ~69°/s, so a 90° turn
 *  takes about 1.3 s — quick enough to be responsive, slow enough to feel
 *  like a boat. Per-sail multipliers in SAIL_MULTS scale this: a rowed
 *  (furled) ship pivots fastest, full canvas fights the rudder. */
const SHIP_TURN_RATE = 1.2;
/** Fraction of the wind's perpendicular-to-heading component that still
 *  reaches the ship as force. Tuned together with SHIP_DRAG_LATERAL_COEF:
 *  steady-state leeway ≈ windPerp · LEEWAY_FRAC / LATERAL_DRAG, so raising
 *  lateral drag means raising this fraction to keep leeway visible on the
 *  HUD. The along-heading component always applies in full — sails catch
 *  it directly — but a beam wind fights the hull's lateral resistance. */
const LEEWAY_FRAC = 0.7;
/** Point-of-sail thrust multiplier. `dot` = heading · windDirection (unit
 *  vectors), so +1 = running dead downwind, 0 = beam reach, -1 = dead into
 *  the wind. A sail can't generate drive pointed straight into the wind, so
 *  close-hauled and in-irons points lose thrust sharply. Running and
 *  reaching keep full thrust — the wind is filling the sail. */
function pointOfSailThrustMult(dot: number): number {
  if (dot > 0) return 1;                  // running / reaching
  if (dot > -Math.SQRT1_2) return 0.55;   // close-hauled (90°–135° off wind)
  return 0.15;                            // in irons (nearly head-to-wind)
}

/** Per-sail-state multipliers. `thrust` scales player input thrust, `speed`
 *  scales the max-speed cap, `wind` scales both the along-heading drive
 *  and the leeway force, `turn` scales the base rotation rate (higher =
 *  faster turn: oars pivot on a dime; full canvas fights the rudder).
 *  `furled` ignores the wind entirely but still lets the player row at a
 *  slow, steady pace — useful for docking maneuvers and fighting out of a
 *  bad anchorage when the wind is unhelpful. */
interface SailMultipliers {
  thrust: number;
  speed: number;
  wind: number;
  turn: number;
}
const SAIL_MULTS: Record<SailState, SailMultipliers> = {
  furled: { thrust: 0.25, speed: 0.25, wind: 0,    turn: 1.5 },
  reefed: { thrust: 0.5,  speed: 0.6,  wind: 0.4,  turn: 1.2 },
  trim:   { thrust: 0.8,  speed: 0.85, wind: 0.75, turn: 1.0 },
  full:   { thrust: 1.0,  speed: 1.0,  wind: 1.0,  turn: 0.7 },
};

/** Wind strength above which carrying full sails is "over-canvassed" —
 *  exposed on the Ship so the HUD can flash a warning. No direct hull
 *  damage for now; the thrust/wind math already makes it hard to handle. */
export const OVER_CANVAS_WIND = 0.85;

export type ShipTileState = "water" | "beach" | "blocked";

export interface SailingStepResult {
  beached: boolean;
  blocked: boolean;
}

export class Ship {
  /** Stable instance id (matches ships.json instance id). */
  public readonly id: string;
  public mode: ShipMode = "docked";
  public docked: DockedPose;
  public readonly vessel: VesselTemplate;
  public readonly dims: VesselDims;

  /** Continuous position. Velocity is a 2D vector with momentum; thrust
   *  accelerates it along the bow and drag slows it. */
  public x: number;
  public y: number;
  public vx = 0;
  public vy = 0;

  /** The ship's *continuous* heading in radians (0 = east, +π/2 = south —
   *  screen space). This is the authoritative rotation used by all physics
   *  (keel axis, thrust direction, wind point-of-sail). It turns gradually
   *  in response to `targetHeadingRad`, never snaps. The cardinal `heading`
   *  below is derived from it and only drives the sprite/hitbox/helm, which
   *  remain authored in four quarter-turn orientations. */
  public headingRad: number;
  /** The cardinal orientation currently showing on screen and used for
   *  hitbox / helm geometry. Derived from `headingRad` via nearest-quadrant
   *  rounding; changes snap at 45° crossings and trigger a sprite crossfade. */
  public heading: Heading;
  /** Angle the player has asked the ship to turn toward, or null if no
   *  steering input is active. `updateSailing` rotates `headingRad` toward
   *  this at `SHIP_TURN_RATE * SAIL_MULTS[sail].turn` rad/s. */
  public targetHeadingRad: number | null = null;

  /** The cardinal heading the sprite is crossfading *away from*, or null
   *  when not mid-fade. Set by `beginTurn` whenever the derived cardinal
   *  flips; cleared when `turnElapsedMs` reaches the crossfade duration.
   *  Purely visual — physics runs on `headingRad`. */
  public turnFromHeading: Heading | null = null;
  public turnElapsedMs = 0;

  /** How much sail is set. Defaults to `furled` when a ship starts sailing
   *  — the player rows out under control, then eases canvas when clear of
   *  the dock. Stepped up/down with [ and ]. */
  public sail: SailState = "furled";

  /** Lightweight anchor for camera follow and global visibility. Tilemap layers
   *  cannot be Container children, so they live at scene level and are
   *  repositioned to track this container each time pose changes. */
  public readonly container: Phaser.GameObjects.Container;
  /** One visual per heading (moving + idle layers). Only the active heading's
   *  pair is visible at a time; within that pair, `mode === "sailing"` chooses
   *  moving, otherwise idle. */
  private readonly visuals: ShipVisualLayers[];

  constructor(scene: Phaser.Scene, id: string, vessel: VesselTemplate, docked: DockedPose) {
    this.id = id;
    this.vessel = vessel;
    this.dims = { tilesLong: vessel.tilesLong, tilesWide: vessel.tilesWide };
    this.docked = { ...docked };
    this.heading = docked.heading;
    this.headingRad = headingToRotation(docked.heading);
    const c = Ship.bboxCenterPx(docked, this.dims);
    this.x = c.x;
    this.y = c.y;

    this.container = scene.add.container(this.x, this.y);
    this.container.setDepth(this.sortY());

    this.visuals = [0, 1, 2, 3].map((h) => createShipVisual(scene, vessel, h as Heading));
    this.updateVisual();
  }

  /** Derived angle — some callers (player sprite, debug) still want a radian value. */
  get rotation(): number {
    return headingToRotation(this.heading);
  }

  /** Y-value used for depth sorting — bottom of the footprint in world pixels.
   *  Chosen over the visual sprite bottom because vessel art frames include tall
   *  masts/sails extending well above the hull; sorting by the footprint keeps
   *  the player drawing correctly relative to the hull (the walkable reference). */
  sortY(): number {
    const eastWest = this.heading === 1 || this.heading === 3;
    const hTiles = eastWest ? this.dims.tilesWide : this.dims.tilesLong;
    return this.y + (hTiles / 2) * TILE_SIZE;
  }

  private applyLayerTransforms(): void {
    const depth = this.sortY();
    for (let h = 0; h < 4; h++) {
      const v = this.visuals[h];
      const topLeftX = this.x - v.widthPx / 2;
      const topLeftY = this.y - v.heightPx / 2;
      v.moving.setPosition(topLeftX, topLeftY);
      v.idle.setPosition(topLeftX, topLeftY);
      v.moving.setDepth(depth);
      v.idle.setDepth(depth);
    }
  }

  private updateVisual() {
    const sailing = this.mode === "sailing";
    // Crossfade progress for heading transitions: 0 = just started, 1 = done.
    // When not turning the new heading renders at full alpha.
    const turning = this.turnFromHeading !== null;
    const p = turning ? Math.min(1, this.turnElapsedMs / SHIP_SPRITE_CROSSFADE_MS) : 1;
    for (let h = 0; h < 4; h++) {
      const v = this.visuals[h];
      let alpha = 0;
      let visible = false;
      if (h === this.heading) {
        alpha = p;
        visible = true;
      } else if (turning && h === this.turnFromHeading) {
        alpha = 1 - p;
        visible = true;
      }
      v.moving.setVisible(visible && sailing);
      v.idle.setVisible(visible && !sailing);
      v.moving.setAlpha(alpha);
      v.idle.setAlpha(alpha);
    }
    this.applyLayerTransforms();
  }

  /** Toggle ship visibility (used when changing scenes / entering interiors). */
  setVisible(visible: boolean): void {
    this.container.setVisible(visible);
    if (!visible) {
      for (const v of this.visuals) {
        v.moving.setVisible(false);
        v.idle.setVisible(false);
      }
    } else {
      this.updateVisual();
    }
  }

  /** Kick off the sprite crossfade when the derived cardinal flips. No-op
   *  if nothing changed. Chaining turns mid-fade restarts the crossfade
   *  from the new pair — acceptable because the ship only pops through
   *  cardinals during a continuous rotation, and the 260 ms fade fits
   *  inside the ~0.5 s it takes to sweep another 45°. */
  private beginTurn(next: Heading): void {
    if (next === this.heading) return;
    this.turnFromHeading = this.heading;
    this.turnElapsedMs = 0;
    this.heading = next;
    this.updateVisual();
  }

  /** Step the sail one notch in the given direction (+1 = ease out, more
   *  canvas; -1 = reef in, less canvas). Clamps at the ends of the list.
   *  Returns the new state so callers can gate toasts on an actual change. */
  adjustSail(dir: -1 | 1): SailState {
    const idx = SAIL_STATES.indexOf(this.sail);
    const next = Math.max(0, Math.min(SAIL_STATES.length - 1, idx + dir));
    this.sail = SAIL_STATES[next];
    return this.sail;
  }

  /** True when full sails are set in a wind that's really too strong for
   *  them. HUD uses this to flash the sail gauge red. */
  isOverCanvassed(windStrength: number): boolean {
    return this.sail === "full" && windStrength >= OVER_CANVAS_WIND;
  }

  /** Set or clear the heading the ship is trying to turn toward. The
   *  caller (usually the scene) passes `atan2(dy, dx)` when any steering
   *  key is held, or `null` otherwise. Actual rotation happens frame-by-
   *  frame in `updateSailing` so the rate is tied to sail/physics, not to
   *  how fast the input event fires. */
  setTargetHeading(rad: number | null): void {
    this.targetHeadingRad = rad;
  }

  /** Current velocity magnitude (px/s). */
  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  /** Footprint tiles occupied by the ship in a given docked pose. */
  static footprint(pose: DockedPose, dims: VesselDims): Array<{ x: number; y: number }> {
    const { tx, ty, heading } = pose;
    const eastWest = heading === 1 || heading === 3;
    const w = eastWest ? dims.tilesLong : dims.tilesWide;
    const h = eastWest ? dims.tilesWide : dims.tilesLong;
    const tiles: Array<{ x: number; y: number }> = [];
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) tiles.push({ x: tx + dx, y: ty + dy });
    }
    return tiles;
  }

  /** Pixel center of the bbox for a given docked pose. */
  static bboxCenterPx(pose: DockedPose, dims: VesselDims): { x: number; y: number } {
    const { tx, ty, heading } = pose;
    const eastWest = heading === 1 || heading === 3;
    const w = eastWest ? dims.tilesLong : dims.tilesWide;
    const h = eastWest ? dims.tilesWide : dims.tilesLong;
    return { x: (tx + w / 2) * TILE_SIZE, y: (ty + h / 2) * TILE_SIZE };
  }

  /** Tile containing the helm interaction point for a given docked pose. */
  helmTileForPose(pose: DockedPose): { x: number; y: number } {
    const center = Ship.bboxCenterPx(pose, this.dims);
    const h = this.visuals[pose.heading].helm;
    const wx = center.x + h.offX + h.w / 2;
    const wy = center.y + h.offY + h.h / 2;
    return { x: Math.floor(wx / TILE_SIZE), y: Math.floor(wy / TILE_SIZE) };
  }

  /** World-pixel position of the helm (center of the helm object), for parking
   *  the player while sailing/anchoring. Per-heading, authored in each tmj's
   *  `helm` object layer. */
  helmWorldPx(): { x: number; y: number } {
    const h = this.visuals[this.heading].helm;
    return { x: this.x + h.offX + h.w / 2, y: this.y + h.offY + h.h / 2 };
  }

  /** Current helm rect (ship-center-relative world px) for the active heading. */
  helm(): HelmRect {
    return this.visuals[this.heading].helm;
  }

  /** Whether a player-center pixel is on a deck tile of this ship (docked only). */
  isOnDeck(px: number, py: number): boolean {
    if (this.mode !== "docked") return false;
    const tx = Math.floor(px / TILE_SIZE);
    const ty = Math.floor(py / TILE_SIZE);
    return Ship.footprint(this.docked, this.dims).some((t) => t.x === tx && t.y === ty);
  }

  startSailing(): void {
    this.mode = "sailing";
    this.vx = 0;
    this.vy = 0;
    this.turnFromHeading = null;
    this.turnElapsedMs = 0;
    this.targetHeadingRad = null;
    this.headingRad = headingToRotation(this.heading);
    this.sail = "furled";
    this.updateVisual();
  }

  /** Tiles overlapped by the hitbox rect at a continuous ship center (x, y). */
  static hitboxTilesAt(
    x: number,
    y: number,
    hb: HitboxRect,
  ): Array<{ x: number; y: number }> {
    const eps = 0.001;
    const tx0 = Math.floor((x + hb.offX) / TILE_SIZE);
    const ty0 = Math.floor((y + hb.offY) / TILE_SIZE);
    const tx1 = Math.floor((x + hb.offX + hb.w - eps) / TILE_SIZE);
    const ty1 = Math.floor((y + hb.offY + hb.h - eps) / TILE_SIZE);
    const tiles: Array<{ x: number; y: number }> = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) tiles.push({ x: tx, y: ty });
    }
    return tiles;
  }

  /** Current hitbox rect (ship-center-relative world px) for the active heading. */
  hitbox(): HitboxRect {
    return this.visuals[this.heading].hitbox;
  }

  /** Axis-aligned bounding box of the ship's hitbox in world pixels, at
   *  the ship's current pose. Used by other ships' collision checks and
   *  by the scene to build the "other hulls" list each frame. Derived
   *  from the cardinal hitbox so it's consistent with the hull's own
   *  obstacle-avoidance behavior. */
  hitboxAABB(): { x: number; y: number; w: number; h: number } {
    const hb = this.hitbox();
    return { x: this.x + hb.offX, y: this.y + hb.offY, w: hb.w, h: hb.h };
  }

  /** Advance physics while sailing. `thrust` is a signed scalar: +1 =
   *  forward along the bow, -1 = reverse, 0 = neutral (drag + wind only).
   *  Direction comes from the ship's own `headingRad`, not from the caller
   *  — steering input is a separate `setTargetHeading()` call because
   *  rotation is a physical quantity that unrolls over several frames.
   *  `wind` is an acceleration vector in px/s² applied every frame; pass
   *  null (or {x:0,y:0}) for dead calm.
   *
   *  Collision is axis-separated so that grazing a beach on one axis
   *  doesn't kill motion on the other — you can slide along a shore. A
   *  beach tile only blocks the axis if traversing it would raise the
   *  ship's beach-tile count (i.e. you are being pushed *further* into
   *  the beach); parallel or outward motion along the same beach is
   *  allowed. */
  updateSailing(
    dtSec: number,
    thrust: number,
    classify: (tx: number, ty: number) => ShipTileState,
    wind: { x: number; y: number } | null = null,
    otherHulls: ReadonlyArray<{ x: number; y: number; w: number; h: number }> = [],
  ): SailingStepResult {
    const mult = SAIL_MULTS[this.sail];

    // Rotate headingRad toward targetHeadingRad at the sail-scaled turn
    // rate, taking the shortest path. When the derived cardinal crosses a
    // 45° boundary, kick off a sprite crossfade via beginTurn.
    if (this.targetHeadingRad !== null) {
      this.headingRad = rotateToward(
        this.headingRad,
        this.targetHeadingRad,
        SHIP_TURN_RATE * mult.turn * dtSec,
      );
      const nextCardinal = cardinalFromRad(this.headingRad);
      if (nextCardinal !== this.heading) this.beginTurn(nextCardinal);
    }

    // Advance the visual crossfade timer — purely cosmetic; physics uses
    // headingRad regardless of whether the sprite is mid-swap.
    if (this.turnFromHeading !== null) {
      this.turnElapsedMs += dtSec * 1000;
      if (this.turnElapsedMs >= SHIP_SPRITE_CROSSFADE_MS) {
        this.turnFromHeading = null;
        this.turnElapsedMs = 0;
      }
      this.updateVisual();
    }

    // Keel axis and its +90° rotation (forward vs. beam). Based on the
    // continuous heading so thrust and drag react in real time during a
    // turn, not in the 45°-quantized cardinal steps of the sprite.
    const hX = Math.cos(this.headingRad);
    const hY = Math.sin(this.headingRad);
    const pX = -hY;
    const pY = hX;

    // Directional drag: decompose velocity into along-keel and beam-wise
    // components, decay each at its own rate, recompose. This is what
    // produces yaw inertia: immediately after a heading change, the ship's
    // prior forward motion reclassifies as beam-wise drift (because the
    // keel vector rotated) and bleeds off over ~1 s under the higher
    // lateral drag, so the hull visibly carries through the arc instead
    // of pivoting cleanly.
    const vAlong = this.vx * hX + this.vy * hY;
    const vLat = this.vx * pX + this.vy * pY;
    const alongDecay = Math.exp(-SHIP_DRAG_ALONG_COEF * dtSec);
    const latDecay = Math.exp(-SHIP_DRAG_LATERAL_COEF * dtSec);
    const vAlongDecayed = vAlong * alongDecay;
    const vLatDecayed = vLat * latDecay;
    this.vx = vAlongDecayed * hX + vLatDecayed * pX;
    this.vy = vAlongDecayed * hY + vLatDecayed * pY;

    // Split wind into along-heading and perpendicular (leeway) components,
    // and derive a point-of-sail thrust multiplier from the same geometry.
    // The along component applies in full — it's what the sails catch — so
    // a tailwind drives you forward, a headwind decelerates you. The perp
    // component is attenuated (LEEWAY_FRAC): a beam wind still nudges you
    // sideways, but the hull resists. Meanwhile thrust is scaled by
    // point-of-sail so driving directly into the wind is nearly hopeless
    // and the player must tack. Zero-wind branch short-circuits so dead
    // calm behaves exactly as before.
    let pointOfSail = 1;
    let windAccelX = 0;
    let windAccelY = 0;
    if (wind && (wind.x !== 0 || wind.y !== 0)) {
      const windMag = Math.hypot(wind.x, wind.y);
      const alignDot = (wind.x * hX + wind.y * hY) / windMag; // cos(angle)
      // Oars don't care which way the wind blows — skip the point-of-sail
      // penalty when furled so rowing upwind is the same speed as rowing
      // downwind. Only sails suffer from wind direction.
      if (this.sail !== "furled") pointOfSail = pointOfSailThrustMult(alignDot);
      const alongScalar = wind.x * hX + wind.y * hY; // projection onto heading
      const alongX = alongScalar * hX;
      const alongY = alongScalar * hY;
      const perpX = wind.x - alongX;
      const perpY = wind.y - alongY;
      // Sail multiplier gates how much wind actually reaches the hull.
      // Furled sails catch nothing (0) — the player rows manually. Reefed
      // / trim / full scale up from there.
      windAccelX = (alongX + perpX * LEEWAY_FRAC) * mult.wind;
      windAccelY = (alongY + perpY * LEEWAY_FRAC) * mult.wind;
    }

    // Thrust is applied along the bow (headingRad), not along the input
    // vector — you can steer the target wherever you want but the ship
    // only drives in the direction it's pointing. Reverse (thrust < 0)
    // pushes backward along -bow.
    if (thrust !== 0) {
      const scale = pointOfSail * mult.thrust * thrust;
      this.vx += hX * SHIP_ACCEL * scale * dtSec;
      this.vy += hY * SHIP_ACCEL * scale * dtSec;
    }
    if (wind) {
      this.vx += windAccelX * dtSec;
      this.vy += windAccelY * dtSec;
    }

    // Max speed is scaled by sail state. Furled uses a low cap (rowing
    // pace); full canvas runs to the baseline cap.
    const effectiveMax = SHIP_MAX_SPEED * mult.speed;
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > effectiveMax) {
      const k = effectiveMax / sp;
      this.vx *= k;
      this.vy *= k;
    }
    // Snap to zero at very low speed when nothing is pushing. Checks the
    // effective wind acceleration (not just whether a wind vector was
    // passed) so a furled ship — which zeroes the wind multiplier —
    // actually comes to rest instead of crawling asymptotically.
    const effectiveWindZero = windAccelX === 0 && windAccelY === 0;
    if (sp < SHIP_IDLE_SNAP && thrust === 0 && effectiveWindZero) {
      this.vx = 0;
      this.vy = 0;
    }

    const hb = this.hitbox();
    const curBeach = Ship.beachCount(this.x, this.y, hb, classify);

    // X axis first.
    let nx = this.x + this.vx * dtSec;
    const xRes = Ship.classifyAt(nx, this.y, hb, classify);
    const xHullHit = Ship.overlapsAny(nx, this.y, hb, otherHulls);
    if (
      xRes.worst === "blocked" ||
      (xRes.worst === "beach" && xRes.beachCount > curBeach) ||
      xHullHit
    ) {
      this.vx = 0;
      nx = this.x;
    }
    // Y axis from the (possibly updated) x.
    const beachAfterX = Ship.beachCount(nx, this.y, hb, classify);
    let ny = this.y + this.vy * dtSec;
    const yRes = Ship.classifyAt(nx, ny, hb, classify);
    const yHullHit = Ship.overlapsAny(nx, ny, hb, otherHulls);
    if (
      yRes.worst === "blocked" ||
      (yRes.worst === "beach" && yRes.beachCount > beachAfterX) ||
      yHullHit
    ) {
      this.vy = 0;
      ny = this.y;
    }

    this.x = nx;
    this.y = ny;
    this.syncTransform();

    const finalRes = Ship.classifyAt(this.x, this.y, hb, classify);
    return {
      beached: finalRes.worst === "beach",
      blocked: finalRes.worst === "blocked",
    };
  }

  /** True iff the hitbox, placed at (x, y), would overlap any AABB in
   *  `others`. Used to keep ships from sailing through each other. Other
   *  hulls are assumed pre-filtered to exclude self, so no identity check. */
  private static overlapsAny(
    x: number,
    y: number,
    hb: HitboxRect,
    others: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
  ): boolean {
    if (others.length === 0) return false;
    const ax0 = x + hb.offX;
    const ay0 = y + hb.offY;
    const ax1 = ax0 + hb.w;
    const ay1 = ay0 + hb.h;
    for (const o of others) {
      if (ax0 < o.x + o.w && ax1 > o.x && ay0 < o.y + o.h && ay1 > o.y) return true;
    }
    return false;
  }

  private static classifyAt(
    x: number,
    y: number,
    hb: HitboxRect,
    classify: (tx: number, ty: number) => ShipTileState,
  ): { worst: ShipTileState; beachCount: number } {
    const tiles = Ship.hitboxTilesAt(x, y, hb);
    let worst: ShipTileState = "water";
    let beachCount = 0;
    for (const t of tiles) {
      const s = classify(t.x, t.y);
      if (s === "blocked") { worst = "blocked"; }
      else if (s === "beach") { beachCount++; if (worst !== "blocked") worst = "beach"; }
    }
    return { worst, beachCount };
  }

  private static beachCount(
    x: number,
    y: number,
    hb: HitboxRect,
    classify: (tx: number, ty: number) => ShipTileState,
  ): number {
    let n = 0;
    for (const t of Ship.hitboxTilesAt(x, y, hb)) {
      if (classify(t.x, t.y) === "beach") n++;
    }
    return n;
  }

  private syncTransform(): void {
    this.container.setPosition(this.x, this.y);
    this.container.setDepth(this.sortY());
    this.applyLayerTransforms();
  }

  /** Set position (and optionally heading) — used by anchoring drift tween. */
  setPose(x: number, y: number, heading?: Heading): void {
    this.x = x;
    this.y = y;
    if (heading !== undefined && heading !== this.heading) {
      this.heading = heading;
      this.headingRad = headingToRotation(heading);
      this.updateVisual();
    } else {
      this.syncTransform();
    }
  }

  finalizeDock(pose: DockedPose): void {
    this.docked = { ...pose };
    const c = Ship.bboxCenterPx(pose, this.dims);
    this.mode = "docked";
    this.vx = 0;
    this.vy = 0;
    this.turnFromHeading = null;
    this.turnElapsedMs = 0;
    this.targetHeadingRad = null;
    this.headingRad = headingToRotation(pose.heading);
    this.setPose(c.x, c.y, pose.heading);
    // setPose only updateVisuals if heading changed; force in case it didn't.
    this.updateVisual();
  }

  serialize(): ShipSavedState {
    return {
      id: this.id,
      defId: this.vessel.id,
      x: this.x,
      y: this.y,
      heading: this.heading,
      headingRad: this.headingRad,
      mode: this.mode,
      vx: this.vx,
      vy: this.vy,
      sail: this.sail,
      docked: { ...this.docked },
    };
  }

  hydrate(data: ShipSavedState): void {
    this.docked = { ...data.docked };
    this.mode = data.mode;
    this.vx = data.vx;
    this.vy = data.vy;
    this.heading = data.heading;
    this.headingRad = data.headingRad ?? headingToRotation(data.heading);
    this.x = data.x;
    this.y = data.y;
    this.sail = data.sail ?? "trim";
    this.turnFromHeading = null;
    this.turnElapsedMs = 0;
    this.targetHeadingRad = null;
    this.updateVisual();
    this.container.setPosition(this.x, this.y);
    this.container.setDepth(this.sortY());
  }

  destroy(): void {
    for (const v of this.visuals) {
      v.moving.destroy();
      v.idle.destroy();
      v.tilemap.destroy();
    }
    this.container.destroy();
  }
}

export interface ShipSavedState {
  id: string;
  defId: string;
  x: number;
  y: number;
  heading: Heading;
  /** Optional for backwards compat with pre-continuous-rotation saves.
   *  Hydrate derives it from the cardinal heading when absent. */
  headingRad?: number;
  mode: ShipMode;
  vx: number;
  vy: number;
  /** Optional for backwards compat with pre-sail-state saves. Hydrate
   *  defaults to "trim" when absent. */
  sail?: SailState;
  docked: DockedPose;
}

export function headingToRotation(h: Heading): number {
  return (h - 1) * (Math.PI / 2);
}

/** Normalize an angle to (-PI, PI]. */
export function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** Rotate `current` toward `target` by at most `maxStep` radians, choosing
 *  the shortest direction around the circle. Returns `target` exactly when
 *  within one step to avoid overshooting. */
function rotateToward(current: number, target: number, maxStep: number): number {
  const diff = normalizeAngle(target - current);
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

/** Nearest cardinal heading for a continuous angle. Boundaries at ±45°
 *  from each cardinal, i.e. the sprite flips when the ship rotates past
 *  NE / SE / SW / NW. */
function cardinalFromRad(rad: number): Heading {
  const r = normalizeAngle(rad);
  const idx = Math.round(r / (Math.PI / 2)); // -2..2 (W, N, E, S, W)
  return ((((idx + 1) % 4) + 4) % 4) as Heading;
}
