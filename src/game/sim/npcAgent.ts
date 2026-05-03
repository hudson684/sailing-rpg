import type { Slot } from "../inventory/types";
import type { Facing, WorldLocation } from "./location";
import type { Activity } from "./activities/activity";

export type ItemStack = Slot;

/** Body presentation state. Public surface is read-only — mutation only via
 *  a `BodyHandle` claimed through the registry. */
export interface ReadonlyBody {
  readonly px: number;
  readonly py: number;
  readonly facing: Facing;
  readonly anim: string;
  readonly spriteKey: string;
}

/** Plain-data record for one NPC. The registry owns the canonical copy.
 *  Activities receive references and may mutate fields *other than* `body`,
 *  which goes through `BodyHandle`. Serializable; no Phaser deps. */
export interface NpcAgent {
  readonly id: string;
  readonly archetypeId: string;
  /** Mutated only via a BodyHandle claimed from the registry. */
  body: ReadonlyBody;
  location: WorldLocation;
  dayPlan: Activity[];
  currentActivityIndex: number;
  currentActivity: Activity | null;
  traits: Record<string, unknown>;
  flags: Record<string, boolean>;
  inventory: ItemStack[];
}
