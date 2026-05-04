# Phase 2 — Chat data format + compile-time index

## Goal

Lock the chat JSON shape and build a compile-time index keyed by the
most-selective participant field, so runtime eligibility checks for a
candidate pair are two map lookups + a small intersection — not a
linear scan over every authored chat.

## Why second

Predicates (phase 3) and the director (phase 4) both consume the
index. Defining the data shape and loader first means later phases
import a typed `chatIndex` module without re-deriving keys or
re-parsing JSON.

## Background

The plan overview specifies the JSON shape. This phase is just
formalizing the TypeScript types, the loader, and the index build.

NPCs have two stable identifiers we can match on:

- `npcId` — specific NPC instance, e.g. `blacksmith_brom`.
- `archetype` — class of NPC, e.g. `tourist`. From
  `src/game/sim/data/npcArchetypes.json`.

`npcId` is strictly more selective than `archetype`. The index uses
that as the bucketing priority.

## Deliverables

### 1. Types

New file: `src/game/sim/chat/chatTypes.ts`.

```ts
export type ParticipantMatch =
  | { npcId: string }
  | { archetype: string };

export interface ParticipantSpec {
  match: ParticipantMatch;
  /** Predicate object. Phase 3 defines the full vocabulary; phase 2
   *  treats it as opaque and stores it on the def for later. */
  requires?: Record<string, unknown>;
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
```

### 2. Loader

New file: `src/game/sim/chat/chatIndex.ts`.

- Vite `import.meta.glob('../data/chats/*.json', { eager: true })`,
  matching the pattern used by `npcArchetypes` / schedule loaders.
- For each module: validate (see below), then index.

Validation (throws at startup; these are author errors, not runtime
failures):

- `id` non-empty, unique across all chats.
- `participants` has exactly two entries.
- Every `lines[].by` matches a participant slot key.
- `proximityTiles >= 1`, `cooldownDays >= 0`.
- `lines` non-empty.

### 3. Index shape

```ts
interface IndexEntry {
  def: ChatDef;
  /** Which slot this entry's key matched. The other slot is the
   *  "partner" the matcher needs to satisfy. */
  matchedSlot: string;
}

interface ChatIndex {
  byNpcId: Map<string, IndexEntry[]>;
  byArchetype: Map<string, IndexEntry[]>;
  /** Pre-narrowed by scene. Chats with no `where` go in `null` bucket. */
  byScene: Map<string | null, ChatDef[]>;
  all: readonly ChatDef[];
}

export const chatIndex: ChatIndex = build();
```

For each chat, for each of its two participants, insert one
`IndexEntry` under the appropriate map (`npcId` if the match is by
id, otherwise `archetype`). A chat ends up in two buckets total —
one per participant slot.

### 4. Lookup helper (used in phase 4)

```ts
export function candidatesFor(
  npcId: string,
  archetype: string,
  sceneKey: string,
): IndexEntry[];
```

Concatenates `byNpcId.get(npcId) ?? []` and
`byArchetype.get(archetype) ?? []`, filtered to chats whose `where`
either is absent or matches `sceneKey`. The filter also uses
`byScene` to early-out when neither map has any candidate for the
scene at all.

The director (phase 4) iterates pairs (A, B) and calls
`candidatesFor(A.id, A.archetype, scene)`, then for each entry
verifies B satisfies the partner slot. That's the "small
intersection" — usually 0–3 entries per A.

### 5. First chat file

Drop `src/game/sim/data/chats/brom_tourist_umbrella.json` from the
overview spec into the data directory. Loader picks it up
automatically.

### 6. Folder

Create `src/game/sim/chat/` and `src/game/sim/data/chats/`. README
for the data folder lands in phase 7.

## Out of scope

- Predicate evaluation. `requires` is parsed and stored opaquely;
  phase 3 adds the evaluator.
- Runtime cooldown lookup. Stored on the def, consumed in phase 6.
- Hot-reload / dev-time editing. Eager import + page reload is fine.

## Definition of done

- `chatIndex` exports a populated `ChatIndex` at module load.
- `candidatesFor("blacksmith_brom", "blacksmith", "interior:blacksmiths")`
  returns the umbrella chat's `IndexEntry` for the `shopkeeper` slot.
- Author errors (duplicate id, missing slot, etc.) throw at startup
  with a message naming the offending file and field.
- `npx tsc --noEmit` passes.
