/**
 * Quest system core types. Data-driven, observer-based. See
 * docs/quest-system-plan.md for the full design. This file is the
 * canonical source for all quest-related shapes — types.ts in sibling
 * modules (dialogue, flags) re-export their own narrower slices.
 */

export type FlagKey = string; // e.g. "act1.mainline.bridgeBuilt"
export type FlagValue = boolean | number | string;

/** A subset of the bus event names that quests care about. Expanding
 *  this is a deliberate editor surface change — not a silent drift. */
export type QuestEvent =
  | "combat:enemyKilled"
  | "gathering:nodeHarvested"
  | "gathering:nodeHit"
  | "fishing:caught"
  | "crafting:complete"
  | "jobs:xpGained"
  | "world:mapEntered"
  | "player:tileEntered"
  | "npc:interacted"
  | "dialogue:ended"
  | "shop:purchased"
  | "flags:changed";

/** Event-specific payload match. Every field is optional — unspecified
 *  fields match anything. Used by `Predicate.kind === "event"`. */
export interface EventMatch {
  enemyDefId?: string;
  nodeDefId?: string;
  itemId?: string;
  jobId?: string;
  mapId?: string;
  npcId?: string;
  dialogueId?: string;
  dialogueEndNodeId?: string;
  tile?: { map: string; x: number; y: number; radius?: number };
  minQuantity?: number;
  tier?: string;
  /** For flags:changed — match on the changed key. */
  flagKey?: string;
}

export type Predicate =
  | { kind: "event"; event: QuestEvent; match?: EventMatch }
  | { kind: "flag"; key: FlagKey; equals?: FlagValue; exists?: boolean }
  | {
      kind: "quest";
      questId: string;
      status: "started" | "completed" | "notStarted" | "active";
    }
  | {
      kind: "step";
      questId: string;
      stepId: string;
      status: "entered" | "completed";
    }
  | { kind: "hasItem"; itemId: string; min?: number }
  | { kind: "jobLevel"; jobId: string; min: number }
  | { kind: "sceneMap"; mapId: string }
  | { kind: "and"; all: Predicate[] }
  | { kind: "or"; any: Predicate[] }
  | { kind: "not"; predicate: Predicate };

export type Reward =
  | { kind: "grantItem"; itemId: string; quantity: number }
  | { kind: "grantXp"; jobId: string; amount: number }
  | { kind: "setFlag"; key: FlagKey; value: FlagValue }
  | { kind: "clearFlag"; key: FlagKey }
  | { kind: "playCutscene"; id: string }
  | { kind: "unlockQuest"; questId: string }
  | { kind: "startQuest"; questId: string }
  | { kind: "completeQuest"; questId: string };

export interface StepDef {
  id: string;
  title?: string;
  description?: string;
  /** Rewards granted on entering this step. */
  onEnter?: Reward[];
  /** Rewards granted on completing this step (i.e. leaving via `next`). */
  onComplete?: Reward[];
  /** This step auto-completes when `completeWhen` evaluates true.
   *  Evaluation is re-run on any relevant bus event. */
  completeWhen?: Predicate;
  /** Outgoing transitions. First edge whose `when` matches wins.
   *  An edge with no `when` is the default. Terminal steps have [].
   *  Evaluation order is array order. */
  next: Array<{ when?: Predicate; goto: string }>;
  /** Parallel subgoals. All non-optional subgoals must be satisfied
   *  before `completeWhen` is (re-)tested. */
  subgoals?: Array<{ id: string; completeWhen: Predicate; optional?: boolean }>;
}

export interface QuestDef {
  id: string;
  title: string;
  summary?: string;
  /** Auto-starts when this predicate goes true, unless already
   *  started/completed. Omit for quests only started via rewards
   *  or forceStart. */
  startWhen?: Predicate;
  /** Ids of quests that must be completed before this one auto-starts. */
  prerequisites?: string[];
  /** Step id to enter on start. */
  entry: string;
  steps: Record<string, StepDef>;
  /** Rewards granted when a terminal step (next: []) is entered. */
  onComplete?: Reward[];
  /** If true, quest is hidden from player UI until unlocked. */
  hidden?: boolean;
}

export interface QuestsFile {
  quests: QuestDef[];
}

/** A live event payload normalized for predicate matching. The
 *  evaluator reads these fields; gameplay systems emit richer
 *  payloads on the bus, and the QuestManager adapter populates this
 *  shape from them. */
export interface QuestEventEnvelope {
  name: QuestEvent;
  payload: Readonly<Record<string, unknown>>;
}
