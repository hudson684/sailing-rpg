import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import {
  CF_ANIMS,
  CF_FRAME_SIZE,
  CF_LAYERS,
  cfAnimKey,
  cfTextureKey,
  type CfDir,
  type CfLayer,
  type CfState,
} from "./playerAnims";
import { CF_TOOLS, cfToolAnimKey, type CfToolDef } from "./playerTools";

export const PLAYER_SPEED = 199; // pixels / sec
// Collision footprint at the feet. Wider than tall and offset down from
// `player.y` (the sprite origin, which sits around the waist) so the hitbox
// hugs the shoes. Tune in this file, not in the sampler.
export const PLAYER_FEET_WIDTH = 12;
export const PLAYER_FEET_HEIGHT = 4;
// Offset from `player.y` (sprite origin, at the bottom of the shoes) to the
// rect CENTER. Negative so the rect's bottom edge lands at the origin.
export const PLAYER_FEET_OFFSET_Y = -PLAYER_FEET_HEIGHT / 2;

// Cute_Fantasy 64×64 frame: character pixels live in y=23..40, so feet sit
// near y=40, expressed as a normalized origin so the sprite anchors at the
// feet for depth sorting.
const CF_ORIGIN_Y = 40 / CF_FRAME_SIZE;
const CF_SPRITE_SCALE = 1.5;

export type Facing =
  | "up"
  | "up-right"
  | "right"
  | "down-right"
  | "down"
  | "down-left"
  | "left"
  | "up-left";

export const FACING_VALUES: readonly Facing[] = [
  "up",
  "up-right",
  "right",
  "down-right",
  "down",
  "down-left",
  "left",
  "up-left",
];

// CF sheets ship 3 facings (forward/right/back). Left-facing = right row
// played with each child sprite flipped horizontally (Containers don't have
// setFlipX, so the flip must be applied per child).
function facingToCfDir(f: Facing): { dir: CfDir; flipX: boolean } {
  switch (f) {
    case "up":
      return { dir: "back", flipX: false };
    case "down":
      return { dir: "forward", flipX: false };
    case "right":
    case "up-right":
    case "down-right":
      return { dir: "right", flipX: false };
    case "left":
    case "up-left":
    case "down-left":
      return { dir: "right", flipX: true };
  }
}

// Pick an 8-way facing from raw (dx, dy). Uses a ~22.5° dead-zone on each
// axis so near-cardinal input snaps cardinal instead of flickering to
// diagonal. Returns null if the input has no direction.
function facingFromDelta(dx: number, dy: number): Facing | null {
  if (dx === 0 && dy === 0) return null;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const diagonalRatio = 0.4; // tan(~22°) — below this the minor axis is ignored
  const horizontal = ax > 0 && ay / ax < diagonalRatio;
  const vertical = ay > 0 && ax / ay < diagonalRatio;
  if (horizontal) return dx > 0 ? "right" : "left";
  if (vertical) return dy > 0 ? "down" : "up";
  // Diagonal: both axes meaningful.
  if (dx > 0 && dy > 0) return "down-right";
  if (dx > 0 && dy < 0) return "up-right";
  if (dx < 0 && dy > 0) return "down-left";
  return "up-left";
}

// Default outfit at boot. Each entry's variant must have been pre-loaded in
// BootScene (or lazy-loaded before the layer is set). `tool` and `accessory`
// start unset. Acts as the FALLBACK baseline — the runtime cfBaseline (which
// reflects the player's wardrobe choices) overrides it per-layer.
const DEFAULT_CF_OUTFIT: Partial<Record<CfLayer, string>> = {
  base: "default",
  feet: "brown",
  legs: "og-brown",
  chest: "og-blue",
  hands: "bare",
  hair: "1-brown",
};

export class Player {
  // Container of layered child sprites (base + clothing + tool overlay) so
  // they move/scale/depth-sort as a single paper-doll. External callers use
  // it for camera follow + direct rotation tweaks.
  public readonly sprite: Phaser.GameObjects.Container;
  private readonly cfLayers: Map<CfLayer, Phaser.GameObjects.Sprite>;
  // The active tool overlay. Null when no tool is equipped or when the
  // equipped item has no `visualLayer.layer === "tool"` mapping. The sprite
  // is created lazily on first setTool and reused (texture swapped) on
  // subsequent calls. Hidden during idle/walk; shown only while the matching
  // action state is animating.
  private cfTool: { def: CfToolDef; sprite: Phaser.GameObjects.Sprite } | null = null;
  // Per-layer override of DEFAULT_CF_OUTFIT, populated from the wardrobe
  // (settingsStore). Equipment overlays still take precedence; this only
  // controls what an "unequipped" or never-equipped slot displays.
  private cfBaseline: Partial<Record<CfLayer, string | null>> = {};
  private _facing: Facing = "down";
  private _animState: CfState = "idle";
  private _actionLock = false;
  public frozen = false;

  get attacking(): boolean {
    return this._actionLock;
  }

  /** Back-compat alias: play the sword attack one-shot. */
  attack(): boolean {
    return this.playAction("attack");
  }

  /** Play the pickaxe mining one-shot. */
  mine(): boolean {
    return this.playAction("mine");
  }

  /**
   * Start a one-shot action in the current facing. Plays the matching
   * animation once, then reverts to idle. No-op if another action is already
   * playing or the player is frozen.
   */
  playAction(state: "attack" | "mine" | "chop" | "fish", onComplete?: () => void): boolean {
    if (this._actionLock || this.frozen) return false;
    this._actionLock = true;
    this._animState = state;
    this.applyAnim();
    // Every layer plays the same anim in lockstep — pick the base layer as
    // the driver of the completion callback.
    const driver = this.cfLayers.get("base")!;
    driver.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      this._actionLock = false;
      this._animState = "idle";
      this.applyAnim();
      if (onComplete) onComplete();
    });
    return true;
  }

  get facing(): Facing {
    return this._facing;
  }

  setFacing(f: Facing): void {
    this._facing = f;
    this.applyAnim();
  }

  serialize(): { x: number; y: number; facing: Facing } {
    return { x: this.sprite.x, y: this.sprite.y, facing: this._facing };
  }

  hydrate(data: { x: number; y: number; facing: Facing }): void {
    this.sprite.setPosition(data.x, data.y);
    this.applyDepth();
    this._facing = data.facing;
    this._animState = "idle";
    this.applyAnim();
  }

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.cfLayers = new Map();
    const container = scene.add.container(x, y);
    // Layer order in CF_LAYERS controls draw order (back to front).
    for (const layer of CF_LAYERS) {
      const variant = DEFAULT_CF_OUTFIT[layer];
      if (!variant) continue;
      const key = cfTextureKey(layer, variant);
      if (!scene.textures.exists(key)) continue;
      const child = scene.add.sprite(0, 0, key, 0);
      child.setOrigin(0.5, CF_ORIGIN_Y);
      container.add(child);
      this.cfLayers.set(layer, child);
    }
    container.setScale(CF_SPRITE_SCALE);
    this.sprite = container;
    container.setDepth(this.sortY());
    this.applyAnim();
  }

  get x(): number {
    return this.sprite.x;
  }
  get y(): number {
    return this.sprite.y;
  }

  /** When set, overrides sortY-based depth — used while riding on a ship's
   *  deck so the player renders above the hull sprite regardless of y. */
  public depthOverride: number | null = null;

  /** Y-value used for depth sorting — the container's feet world-y. */
  sortY(): number {
    // Container origin is at (0,0); children sit with feet at child y=0
    // because their own origin is (0.5, CF_ORIGIN_Y).
    return this.sprite.y;
  }

  private applyDepth() {
    this.sprite.setDepth(this.depthOverride ?? this.sortY());
  }

  setPosition(x: number, y: number) {
    this.sprite.setPosition(x, y);
    this.applyDepth();
  }

  setVisible(v: boolean) {
    this.sprite.setVisible(v);
  }

  /** Returns the player's tile coordinates (integer). */
  tile(): { x: number; y: number } {
    return {
      x: Math.floor(this.sprite.x / TILE_SIZE),
      y: Math.floor(this.sprite.y / TILE_SIZE),
    };
  }

  /**
   * Attempt to move by (dx, dy) this frame, respecting a walkability predicate.
   * Uses axis-separated tests so the player can slide along walls.
   */
  tryMove(dx: number, dy: number, isWalkablePx: (x: number, y: number) => boolean) {
    if (this.frozen) {
      this.setAnimState("idle");
      return;
    }
    if (this._actionLock) {
      // Movement locked during the swing; facing/anim already set.
      return;
    }
    let moved = false;
    if (dx !== 0) {
      const nx = this.sprite.x + dx;
      if (isWalkablePx(nx, this.sprite.y)) {
        this.sprite.x = nx;
        moved = true;
      }
    }
    if (dy !== 0) {
      const ny = this.sprite.y + dy;
      if (isWalkablePx(this.sprite.x, ny)) {
        this.sprite.y = ny;
        moved = true;
      }
    }
    const intended = facingFromDelta(dx, dy);
    if (intended) this._facing = intended;
    this.setAnimState(moved ? "walk" : "idle");
    this.applyDepth();
  }

  /**
   * Set a layer that's controlled by the equipment loadout. Pass `null` to
   * "unequip" — the slot reverts to its baseline outfit variant if the slot
   * has one (e.g. removing a chest plate restores the default shirt), or is
   * removed entirely if it has none (e.g. tool/accessory slots).
   */
  setLayerToEquipmentDefault(layer: CfLayer, variant: string | null): void {
    // The tool layer has its own (smaller, per-tool) sheets and doesn't
    // share the standard 9×56 grid — route it to setTool, which knows about
    // tool-specific anims and the show-during-action visibility rule.
    if (layer === "tool") {
      this.setTool(variant);
      return;
    }
    if (variant !== null) {
      this.setLayer(layer, variant);
      return;
    }
    const baseline = this.resolveBaseline(layer);
    this.setLayer(layer, baseline);
  }

  private resolveBaseline(layer: CfLayer): string | null {
    if (layer in this.cfBaseline) return this.cfBaseline[layer] ?? null;
    return DEFAULT_CF_OUTFIT[layer] ?? null;
  }

  /**
   * Update the wardrobe baseline for one layer. Pass `null` to leave the slot
   * empty (e.g. no accessory). Equipment-driven layers should not be set via
   * this method — they're owned by `setLayerToEquipmentDefault` and would be
   * overwritten on the next equipment change.
   */
  setBaselineLayer(layer: CfLayer, variant: string | null): void {
    this.cfBaseline[layer] = variant;
    // Apply immediately. Caller is responsible for re-running equipment sync
    // afterwards if an equipped item should still take precedence on this
    // layer (the bookkeeping lives outside Player so it stays decoupled from
    // the equipment store).
    this.setLayer(layer, variant);
  }

  /**
   * Install (or remove) a tool overlay. Pass a tool id from CF_TOOLS, or
   * null to unequip. The sprite is positioned as the front-most child of
   * the player container so it draws over the body/clothing. Visibility is
   * driven by `applyAnim`: shown only when the current animState matches
   * the tool's actionState.
   */
  setTool(toolId: string | null): void {
    if (toolId === null) {
      if (this.cfTool) {
        this.cfTool.sprite.destroy();
        this.cfTool = null;
      }
      return;
    }
    const def = CF_TOOLS[toolId];
    if (!def) {
      console.warn(`[Player] Unknown CF tool id: ${toolId}`);
      return;
    }
    const scene = this.sprite.scene;
    if (!scene.textures.exists(def.textureKey)) {
      console.warn(`[Player] CF tool texture missing: ${def.textureKey}`);
      return;
    }
    const container = this.sprite;
    if (this.cfTool) {
      this.cfTool.def = def;
      this.cfTool.sprite.setTexture(def.textureKey, 0);
    } else {
      const sprite = scene.add.sprite(0, 0, def.textureKey, 0);
      sprite.setOrigin(0.5, CF_ORIGIN_Y);
      sprite.setVisible(false);
      container.add(sprite); // appended → drawn last → in front of body
      this.cfTool = { def, sprite };
    }
    this.applyAnim();
  }

  setLayer(layer: CfLayer, variant: string | null): void {
    const scene = this.sprite.scene;
    const existing = this.cfLayers.get(layer);
    if (variant === null) {
      if (existing) {
        existing.destroy();
        this.cfLayers.delete(layer);
      }
      return;
    }
    const key = cfTextureKey(layer, variant);
    if (!scene.textures.exists(key)) {
      console.warn(`[Player] CF layer texture missing: ${key}`);
      return;
    }
    if (existing) {
      existing.setTexture(key, 0);
    } else {
      const child = scene.add.sprite(0, 0, key, 0);
      child.setOrigin(0.5, CF_ORIGIN_Y);
      // Insert at the position implied by CF_LAYERS draw order.
      const container = this.sprite;
      const targetIndex = CF_LAYERS.indexOf(layer);
      let insertAt = container.length;
      for (let i = 0; i < container.length; i++) {
        const sibling = container.list[i] as Phaser.GameObjects.Sprite;
        const siblingLayer = this.layerOf(sibling);
        if (siblingLayer && CF_LAYERS.indexOf(siblingLayer) > targetIndex) {
          insertAt = i;
          break;
        }
      }
      container.addAt(child, insertAt);
      this.cfLayers.set(layer, child);
    }
    // Sync this newly-textured layer to the current animation immediately.
    this.applyAnimToLayer(layer);
  }

  private layerOf(sprite: Phaser.GameObjects.Sprite): CfLayer | null {
    for (const [layer, s] of this.cfLayers) if (s === sprite) return layer;
    return null;
  }

  private setAnimState(state: CfState) {
    if (state === this._animState) {
      const driver = this.cfLayers.get("base");
      if (driver && driver.anims.isPlaying) {
        this.applyAnim();
        return;
      }
    }
    this._animState = state;
    this.applyAnim();
  }

  private applyAnim() {
    if (!CF_ANIMS[this._animState]) return;
    for (const layer of this.cfLayers.keys()) this.applyAnimToLayer(layer);
    this.applyToolAnim();
  }

  private applyToolAnim() {
    if (!this.cfTool) return;
    const { def, sprite } = this.cfTool;
    const cfState = this._animState as CfState;
    // Only show + animate the tool while its matching action plays. The base
    // anim and the tool anim share fps / frame counts (see CF_TOOLS), so
    // they advance in lockstep off Phaser's scene clock.
    if (cfState !== def.actionState) {
      if (sprite.visible) sprite.setVisible(false);
      sprite.anims.stop();
      return;
    }
    const { dir, flipX } = facingToCfDir(this._facing);
    sprite.setFlipX(flipX);
    sprite.setVisible(true);
    sprite.anims.play(cfToolAnimKey(def.id, dir), true);
  }

  private applyAnimToLayer(layer: CfLayer) {
    const sprite = this.cfLayers.get(layer);
    if (!sprite) return;
    const cfState = this._animState as CfState;
    if (!CF_ANIMS[cfState]) return;
    const { dir, flipX } = facingToCfDir(this._facing);
    sprite.setFlipX(flipX);
    sprite.anims.play(cfAnimKey(sprite.texture.key, cfState, dir), true);
  }
}
