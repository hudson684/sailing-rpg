// Chat data shape for ambient NPC chats. Predicate vocabulary lives
// in `chatPredicates.ts`; this module just re-exports the shape so
// data files don't import the evaluator.

import type { ChatPredicate } from "./chatPredicates";

export type ParticipantMatch =
  | { npcId: string }
  | { archetype: string };

export interface ParticipantSpec {
  match: ParticipantMatch;
  /** AND-combined predicate list. Empty/undefined = always satisfied. */
  requires?: ChatPredicate[];
}

export interface ChatLine {
  /** Slot key from `participants` ("shopkeeper", "customer", …). */
  by: string;
  text: string;
}

export interface ChatDef {
  id: string;
  /** Map of slot name → participant spec. Exactly two slots in v1. */
  participants: Record<string, ParticipantSpec>;
  /** Optional scene gate. Omit for "any scene". */
  where?: { scene: string };
  /** Manhattan or Chebyshev — settle in phase 4. Default 5. */
  proximityTiles: number;
  cooldownDays: number;
  /** Weighted random tiebreak among eligible chats. Default 1. */
  weight?: number;
  lines: ChatLine[];
}

export interface IndexEntry {
  def: ChatDef;
  /** Which slot this entry's key matched. The other slot is the
   *  "partner" the matcher needs to satisfy. */
  matchedSlot: string;
}

export interface ChatIndex {
  byNpcId: Map<string, IndexEntry[]>;
  byArchetype: Map<string, IndexEntry[]>;
  /** Pre-narrowed by scene. Chats with no `where` go in `null` bucket. */
  byScene: Map<string | null, ChatDef[]>;
  all: readonly ChatDef[];
}
