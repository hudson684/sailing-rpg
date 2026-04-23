import type { Predicate, Reward } from "../quests/types";

export interface DialogueChoice {
  label: string;
  /** Gate: if predicate is false, the choice is hidden. */
  when?: Predicate;
  /** Rewards run when this choice is picked (before navigating). */
  onPick?: Reward[];
  /** Next node id, or null to end the dialogue. */
  goto: string | null;
}

export interface DialogueNode {
  id: string;
  speaker: string;
  /** Optional portrait key for future UI. Ignored by the current modal. */
  portrait?: string;
  pages: string[];
  /** If present, final page shows choices. */
  choices?: DialogueChoice[];
  /** For linear flows: after the last page, jump to this node, or
   *  `null` to end. Ignored if `choices` is non-empty. */
  auto?: string | null;
  /** Rewards run once on entering this node. */
  onEnter?: Reward[];
}

export interface DialogueTree {
  id: string;
  entry: string;
  nodes: Record<string, DialogueNode>;
}

export interface DialogueFile {
  trees: DialogueTree[];
}
