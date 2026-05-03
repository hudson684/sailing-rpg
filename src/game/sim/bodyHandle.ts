import type { Facing } from "./location";
import type { ReadonlyBody } from "./npcAgent";

/** Internal hooks the registry exposes so a `BodyHandle` can validate itself
 *  and apply body mutations. Not part of the public registry surface — only
 *  this module imports it.
 *
 *  Kept as a structural interface (rather than reaching into `NpcRegistry`
 *  directly) so this module has no import cycle with the registry. */
export interface BodyHandleRegistry {
  _isActiveDriver(npcId: string, handle: BodyHandle): boolean;
  _writeBody(npcId: string, mutate: (b: ReadonlyBody) => ReadonlyBody): void;
  _transferDriver(npcId: string, from: BodyHandle, toClaimant: object): BodyHandle;
  _releaseDriver(npcId: string, handle: BodyHandle): void;
}

const DEV =
  typeof import.meta !== "undefined" &&
  (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;

/** Exclusive write-token for an `NpcAgent`'s body. Construction is restricted
 *  to the registry (see `createBodyHandle`). The runtime active-driver check
 *  in dev catches stale-handle writes; production keeps the check too because
 *  the cost is one map lookup per write — body writes are not a hot path. */
export class BodyHandle {
  /** @internal */
  constructor(
    private readonly registry: BodyHandleRegistry,
    /** @internal */ readonly npcId: string,
    /** @internal */ readonly claimant: object,
  ) {}

  setPosition(px: number, py: number): void {
    this.assertActive();
    this.registry._writeBody(this.npcId, (b) => ({ ...b, px, py }));
  }

  setFacing(facing: Facing): void {
    this.assertActive();
    this.registry._writeBody(this.npcId, (b) => ({ ...b, facing }));
  }

  setAnim(anim: string): void {
    this.assertActive();
    this.registry._writeBody(this.npcId, (b) => ({ ...b, anim }));
  }

  setSpriteKey(spriteKey: string): void {
    this.assertActive();
    this.registry._writeBody(this.npcId, (b) => ({ ...b, spriteKey }));
  }

  /** Hand off to a subsystem. This handle is invalidated; only the returned
   *  handle may write to the body until *it* is released or transferred. */
  transfer(toClaimant: object): BodyHandle {
    this.assertActive();
    return this.registry._transferDriver(this.npcId, this, toClaimant);
  }

  release(): void {
    this.assertActive();
    this.registry._releaseDriver(this.npcId, this);
  }

  private assertActive(): void {
    if (!this.registry._isActiveDriver(this.npcId, this)) {
      const msg = `BodyHandle for npc '${this.npcId}' is no longer the active driver (released or transferred)`;
      if (DEV) throw new Error(msg);
      // Prod: silent no-op rather than crashing the player out of the game.
      // eslint-disable-next-line no-console
      console.warn(msg);
    }
  }
}

/** Registry-only factory. Any module other than the registry calling this
 *  is a bug — body ownership must always flow through claim/transfer. */
export function createBodyHandle(
  registry: BodyHandleRegistry,
  npcId: string,
  claimant: object,
): BodyHandle {
  return new BodyHandle(registry, npcId, claimant);
}
