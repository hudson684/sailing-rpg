import type { EntityModel } from "./registry";
import type { MapId } from "./mapId";
import type { CfLayer, CfState, Facing } from "./playerAnims";

export const PLAYER_MODEL_ID = "player";

/**
 * Pure-data model for the player. Position/facing/anim state live here so they
 * survive scene swaps (World ↔ Interior) — the per-scene PlayerSprite is a
 * view that reads from this on wake and writes back as the player moves.
 *
 * Wardrobe baseline + tool id are persisted on the model so a freshly-built
 * sprite in a newly-woken scene can reconstruct its layered appearance
 * without re-consulting the equipment store.
 */
export class PlayerModel implements EntityModel {
  readonly id = PLAYER_MODEL_ID;
  readonly kind = "player" as const;
  mapId: MapId;

  x = 0;
  y = 0;
  facing: Facing = "down";
  animState: CfState = "idle";
  actionLock = false;
  frozen = false;
  /** When set, overrides sortY-based depth — used while riding a ship's deck. */
  depthOverride: number | null = null;
  /** Wardrobe override of the boot default outfit, per layer. */
  cfBaseline: Partial<Record<CfLayer, string | null>> = {};
  /** Currently-equipped tool id (CF_TOOLS key) or null. */
  cfToolId: string | null = null;
  /** Currently-active mount id (CF_MOUNTS key) or null. Not persisted — the
   *  player auto-dismounts on reload for the time being. */
  cfMountId: string | null = null;

  constructor(mapId: MapId = { kind: "world" }) {
    this.mapId = mapId;
  }

  serialize(): { x: number; y: number; facing: Facing } {
    return { x: this.x, y: this.y, facing: this.facing };
  }

  hydrate(data: { x: number; y: number; facing: Facing }): void {
    this.x = data.x;
    this.y = data.y;
    this.facing = data.facing;
    this.animState = "idle";
    this.actionLock = false;
  }
}
