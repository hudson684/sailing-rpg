/** Reference to a cutscene actor. `"player"` resolves to the local player;
 *  any other string is matched against an NPC model id (`npc:<defId>`) or
 *  the bare def id, which the host expands. Actors must already exist in
 *  the active scene — cutscenes don't spawn yet (v1). */
export type ActorRef = string;

/** A single dialogue choice. `goto` jumps to the named step group when the
 *  player picks this option. */
export interface DialogueChoice {
  label: string;
  goto: string;
}

/** A scripted facing. Internally NpcModel only stores `left` / `right`; the
 *  player supports the full 8-way set, so we accept either form and clamp
 *  per-actor at runtime. */
export type CutsceneFacing = "left" | "right" | "up" | "down";

export type CutsceneStep =
  /** Sleep for `ms` real-time milliseconds. */
  | { kind: "wait"; ms: number }
  /** Tween an actor to a tile position. Speed is px/sec; defaults to 80. */
  | {
      kind: "walkTo";
      actor: ActorRef;
      tileX: number;
      tileY: number;
      speed?: number;
    }
  /** Set an actor's facing. */
  | { kind: "face"; actor: ActorRef; dir: CutsceneFacing }
  /** Force an NPC's animation state. (Player anim is driven by its own
   *  state machine and is left alone.) */
  | { kind: "anim"; actor: ActorRef; state: "idle" | "walk" }
  /** Show a dialogue page (or pages) attributed to `speaker`. If `choices`
   *  are present, the cutscene blocks until the player picks one and then
   *  jumps to the chosen `goto` label. */
  | {
      kind: "say";
      speaker: string;
      pages: string[];
      choices?: DialogueChoice[];
    }
  /** Unconditional jump to a labeled step group. */
  | { kind: "goto"; label: string }
  /** Set a named flag on the cutscene's local state. Flags survive across
   *  steps but die when the cutscene ends. */
  | { kind: "setFlag"; name: string; value: string | number | boolean }
  /** Branch on a flag value. Falls through to the next step if neither
   *  arm matches. */
  | {
      kind: "if";
      flag: string;
      equals: string | number | boolean;
      then: string;
      else?: string;
    }
  /** Stop the cutscene immediately. Useful as the last step of a branch. */
  | { kind: "end" };

export interface CutsceneDef {
  id: string;
  /** Display name for tooling / debug. */
  name?: string;
  /** Label of the step group to start at. */
  entry: string;
  /** Named step groups. The director runs steps in order within a group;
   *  control leaves the group via `goto`, `end`, or running off the end. */
  steps: Record<string, CutsceneStep[]>;
}

export interface CutsceneData {
  cutscenes: CutsceneDef[];
}
