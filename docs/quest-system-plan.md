# Quest System Plan

Design document for a data-driven, observer-based quest system with an
authoring toolchain. Implementation happens in phases; Phase 1 is the
runtime foundation, Phases 2–6 build authoring tools, Phase 7 extends
world state to react to quest flags.

**This document is systems/tools design only. No quest content, no
dialogue text, no specific flag values. Act 1 appears only in the
appendix as a validation lens for the schema.**

---

## Guiding principles

1. **Central observer, zero coupling to gameplay systems.** Combat,
   crafting, gathering, fishing, scene transitions, and dialogue emit
   events they would emit anyway. `QuestManager` subscribes. Gameplay
   modules never import anything from `src/game/quests/`.
2. **Graphs, not arrays.** A quest is a directed graph of steps. Each
   step declares `next: [{ when?, goto }]`. Branching, early-outs, and
   parallel sub-objectives fall out of this one primitive.
3. **One predicate vocabulary.** The same `Predicate` type is used for
   quest start triggers, step-completion tests, branch `when` clauses,
   dialogue-choice gating, and (Phase 7) world-entity spawn gating. One
   evaluator, one editor widget, one mental model.
4. **Flags are the shared state layer.** A namespaced global
   `FlagStore` replaces the transient per-cutscene flags in
   `CutsceneDirector`. Quests, dialogue, cutscenes, and world state all
   read/write the same store.
5. **Dialogue leaves cutscenes.** Dialogue trees become first-class
   content in `src/game/data/dialogue.json`, driven by a
   `DialogueDirector`. Cutscenes reference dialogue by id. A dual-shape
   migration window keeps inline `say` working; then the inline path is
   removed.
6. **Phaser 4 first.** Timers use `scene.time`, animations use
   `scene.tweens`, scene transitions use Phaser's scene manager. Any
   new runtime behavior that could be bolted onto a GameObject or
   plugin should be. Predicate evaluation and the event bus are
   framework-free so they can be unit tested without Phaser.
7. **Dev tooling is dev-only.** The `/editor` React route is gated on
   `import.meta.env.DEV`. A Vite plugin exposes a JSON write-back
   endpoint only in dev. Nothing ships to players.

---

## Architecture overview

```
 ┌──────────────┐      ┌──────────────┐     ┌──────────────┐
 │ Combat       │      │ Crafting     │     │ Gathering    │
 │ Fishing      │      │ Shops        │     │ SceneChange  │
 │ TileEnter    │      │ Dialogue     │     │ NpcInteract  │
 └──────┬───────┘      └──────┬───────┘     └──────┬───────┘
        │                     │                    │
        └──────────── bus (src/game/bus.ts) ───────┘
                              │
                              ▼
       ┌────────────────────────────────────────────┐
       │              QuestManager                  │
       │  registry  │  active cursors  │  Saveable  │
       └──────┬───────────────┬──────────────┬──────┘
              │               │              │
              ▼               ▼              ▼
         FlagStore      predicates.ts    Rewards
         (Saveable,     (pure eval;      (grantItem,
          emits         shared with      grantXp,
          flags:changed) dialogue,        setFlag,
                         spawns)          playCutscene,
                                          unlockQuest)
```

The `QuestManager` never calls into Phaser and never writes to a
scene. Rewards that affect the world (e.g. `playCutscene`) go back out
through the bus. The `QuestManager` is owned by `SystemsScene` so it
lives across scene restarts.

---

# Phase 1 — Runtime engine, dialogue extraction, event gaps

Goal: ship the entire runtime substrate. After this phase, a quest
authored by hand in `quests.json` against hand-authored
`dialogue.json` can be started, advanced, branched, completed, and
saved/loaded. No authoring UI yet — just the engine.

## 1.1 Scope

**In scope**

- New types: `QuestDef`, `StepDef`, `Predicate`, `Reward`,
  `DialogueTree`, `DialogueNode`.
- New modules: `src/game/quests/`, `src/game/dialogue/`,
  `src/game/flags/`.
- New data files: `src/game/data/quests.json`,
  `src/game/data/dialogue.json` (schema only; no content beyond a
  single smoke-test quest + tree used by the test file).
- `QuestManager` subscriptions, `FlagStore`, `DialogueDirector`,
  predicates evaluator, reward runner.
- Cutscene `say` migration: accept `{ dialogueId, nodeId? }` in
  addition to the existing inline `pages`/`choices` shape.
- New cutscene step: `changeMap` for mid-cutscene forced scene
  transitions.
- Event bus additions (see §1.8) — emit from the systems that already
  have the information and aren't emitting it yet.
- Saveables: `quests`, `flags`. `cutscenes` is not saveable (cutscene
  state is not persisted; quests persist the effect).

**Non-goals (Phase 1)**

- No React UI. The existing dialogue modal is fine.
- No authoring tools. Editor is Phases 2–6.
- No spawn-gating (Phase 7).
- No quest log UI for players. A minimal debug inspector may be
  exposed but only behind a dev flag.

## 1.2 New files

```
src/game/quests/
  QuestManager.ts          // registry + cursors + Saveable
  predicates.ts            // evaluator (Phaser-free, pure)
  rewards.ts               // reward runner (emits bus events; no Phaser)
  types.ts                 // QuestDef / StepDef / Predicate / Reward
  questsData.ts            // loader: JSON → typed defs, Zod-validated
  questsSaveable.ts        // Saveable<QuestsSaveState>
  QuestManager.test.ts     // unit tests (predicates, graph advance, saves)

src/game/dialogue/
  DialogueDirector.ts      // presents trees via existing dialogue:update bus event
  types.ts                 // DialogueTree / DialogueNode
  dialogueData.ts          // loader: JSON → typed defs, Zod-validated
  DialogueDirector.test.ts

src/game/flags/
  FlagStore.ts             // namespaced global flags; Saveable; emits flags:changed
  flagsSaveable.ts
  FlagStore.test.ts

src/game/data/
  quests.json              // { quests: QuestDef[] }
  dialogue.json            // { trees: DialogueTree[] }
```

## 1.3 Modified files

- `src/game/bus.ts` — add event vocabulary (§1.8).
- `src/game/cutscenes/types.ts` — `say` gets a dual shape; add
  `changeMap` step.
- `src/game/cutscenes/CutsceneDirector.ts` — `say` dispatches to
  `DialogueDirector` when `dialogueId` is set; otherwise legacy path.
  Handles `changeMap` by emitting a bus event (see §1.8) and awaiting
  a `world:mapEntered` response before continuing.
- `src/game/entities/Enemy.ts` — emit `combat:enemyKilled` in `die()`.
- `src/game/world/GatheringNode.ts` — emit `gathering:nodeHit` on
  each strike and `gathering:nodeHarvested` on depletion.
- `src/game/fishing/fishingSession.ts` — emit `fishing:caught` on
  successful catch.
- `src/game/scenes/WorldScene.ts` — emit `world:mapEntered` on
  create/resume; emit `npc:interacted` on E-press dialogue;
  register tile-entry triggers with a new `TileTriggerRegistry`
  (quest manager registers desired triggers, scene fires
  `player:tileEntered` only on enter of a registered tile).
- `src/game/scenes/InteriorScene.ts` — same `world:mapEntered` +
  `npc:interacted` + tile-entry plumbing.
- `src/game/scenes/SystemsScene.ts` — construct `FlagStore`,
  `QuestManager`, `DialogueDirector`; register saveables.
- `src/game/save/index.ts` (or wherever saveables are assembled) —
  register `flagsSaveable` and `questsSaveable`.

## 1.4 Core types (full signatures)

```ts
// src/game/quests/types.ts

export type FlagKey = string; // e.g. "act1.mainline.bridgeBuilt"
export type FlagValue = boolean | number | string;

export type Predicate =
  | { kind: "event"; event: QuestEvent; match?: EventMatch }
  | { kind: "flag"; key: FlagKey; equals?: FlagValue; exists?: boolean }
  | { kind: "quest"; questId: string; status: "started" | "completed" | "notStarted" | "active" }
  | { kind: "step"; questId: string; stepId: string; status: "entered" | "completed" }
  | { kind: "hasItem"; itemId: string; min?: number }
  | { kind: "jobLevel"; jobId: string; min: number }
  | { kind: "sceneMap"; mapId: string }
  | { kind: "and"; all: Predicate[] }
  | { kind: "or"; any: Predicate[] }
  | { kind: "not"; predicate: Predicate };

/** A subset of the bus event names that quests care about.
 *  Kept narrow on purpose — expanding this is a deliberate editor
 *  surface change, not a quiet string-type drift. */
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
 *  fields match anything. Numeric fields accept ranges. */
export type EventMatch = {
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
};

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
  /** Optional human label for editor + debug. */
  title?: string;
  /** Optional body text shown in a future quest log. */
  description?: string;
  /** Rewards granted on entering this step. */
  onEnter?: Reward[];
  /** Rewards granted on completing this step (i.e. leaving via `next`). */
  onComplete?: Reward[];
  /** This step auto-completes when `completeWhen` evaluates true.
   *  Evaluation is re-run on any relevant bus event. */
  completeWhen?: Predicate;
  /** Outgoing transitions. First edge whose `when` matches wins.
   *  An edge with no `when` is the default (always taken once the step
   *  is completable). Terminal steps have `next: []`. */
  next: Array<{ when?: Predicate; goto: string }>;
  /** Optional: parallel subgoals. Each must independently satisfy
   *  before `completeWhen` is re-checked. Useful for "talk to N
   *  townspeople" without authoring a fan-out graph. */
  subgoals?: Array<{ id: string; completeWhen: Predicate; optional?: boolean }>;
}

export interface QuestDef {
  id: string;
  title: string;
  /** Non-player visible; editor-only. */
  summary?: string;
  /** Auto-starts when this predicate goes true, unless the quest is
   *  already started/completed. Omit for quests started purely via
   *  `Reward.startQuest` or `forceStart`. */
  startWhen?: Predicate;
  /** If set, the quest cannot auto-start until these quests are completed. */
  prerequisites?: string[];
  /** Steps keyed by id; `entry` names the starting step. */
  entry: string;
  steps: Record<string, StepDef>;
  /** Rewards granted when a terminal step with no outgoing edges is
   *  entered. May be empty — all interesting payoffs are usually on
   *  steps themselves. */
  onComplete?: Reward[];
  /** If true, quest is hidden from player UI until unlocked. */
  hidden?: boolean;
}

export interface QuestsFile {
  quests: QuestDef[];
}
```

```ts
// src/game/dialogue/types.ts

export interface DialogueChoice {
  label: string;
  /** Gate: hide choice entirely if predicate is false. */
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
  /** If present, final page shows choices. If absent, dialogue either
   *  auto-advances via `auto` or ends on close. */
  choices?: DialogueChoice[];
  /** For linear flows: after the last page, jump to this node or end
   *  if null. Ignored if `choices` is non-empty. */
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
```

## 1.5 `QuestManager` API

```ts
// src/game/quests/QuestManager.ts

export interface QuestCursor {
  questId: string;
  stepId: string;
  /** Subgoal id → satisfied boolean. Empty if step has no subgoals. */
  subgoals: Record<string, boolean>;
  startedAt: number; // Date.now() at quest start
  enteredStepAt: number; // Date.now() at entering current step
}

export type QuestStatus = "notStarted" | "active" | "completed";

export interface QuestManagerOptions {
  bus: TypedEmitter;
  flags: FlagStore;
  /** Provides read-only views the predicate evaluator needs. */
  ctx: PredicateContext;
}

export interface PredicateContext {
  hasItem(itemId: string, min: number): boolean;
  jobLevel(jobId: string): number;
  activeMapId(): string;
  isQuestStatus(questId: string, status: "started" | "completed" | "notStarted" | "active"): boolean;
  stepStatus(questId: string, stepId: string): "notEntered" | "entered" | "completed";
  flags: FlagStore;
}

export class QuestManager implements Saveable<QuestsSaveState> {
  readonly id = "quests";
  readonly version = 1;
  readonly schema: ZodType<QuestsSaveState>;

  constructor(opts: QuestManagerOptions);

  /** Load quest definitions once at boot. Throws on id collisions /
   *  dangling gotos. */
  register(defs: QuestDef[]): void;

  /** Returns snapshot of all quest statuses (for UI + save). */
  snapshot(): QuestsSaveState;

  getCursor(questId: string): QuestCursor | null;
  getStatus(questId: string): QuestStatus;

  /** Manual overrides, used by editor + debug console. */
  forceStart(questId: string): void;
  jumpTo(questId: string, stepId: string): void;
  forceComplete(questId: string): void;
  reset(questId: string): void;

  /** Saveable. */
  serialize(): QuestsSaveState;
  hydrate(data: QuestsSaveState): void;
}

export interface QuestsSaveState {
  /** Every quest's status. Absent ids are assumed notStarted on load. */
  statuses: Record<string, {
    status: QuestStatus;
    cursor: QuestCursor | null;
    completedAt?: number;
  }>;
  /** Quests explicitly unlocked via `Reward.unlockQuest`, regardless
   *  of whether their `startWhen` has fired. */
  unlocked: string[];
}
```

### Event handling

`QuestManager` subscribes in its constructor to every event listed in
`QuestEvent`. On each event:

1. Collect all `(questId, stepId)` pairs that could advance:
   - The current step of any active quest.
   - Any quest whose `startWhen` could be satisfied by this event.
2. For each candidate, run the predicates against the event payload
   and current world state.
3. Apply transitions:
   - Start the quest if `startWhen` is now true and prerequisites pass.
   - Tick subgoals.
   - If `completeWhen` is satisfied and all required subgoals done,
     pick the first matching `next` edge and move the cursor.
   - Fire rewards for `onComplete` of the old step and `onEnter` of
     the new step.
   - If the new step has no outgoing edges, run `onComplete` of the
     quest and mark it completed.
4. Emit lifecycle events on the bus:
   `quest:started`, `quest:stepEntered`, `quest:stepCompleted`,
   `quest:completed`, `quest:unlocked`.

Advancement is **synchronous** within one bus event, but events that
trigger other events (e.g. a reward that sets a flag, which then
satisfies another quest's `startWhen`) are processed by re-entering
the dispatch loop with a cycle guard. Declare
`const MAX_TRANSITION_DEPTH = 16` at module scope; warn + bail on
overflow.

### Validation at `register()`

- Unique `quest.id` and `step.id` within each quest.
- Every `goto` references a defined step.
- `entry` references a defined step.
- Every `unlockQuest` / `startQuest` / `completeQuest` /
  `prerequisites` id resolves.
- Every `Reward.grantItem.itemId` is a known `ItemId`.
- Every `Reward.grantXp.jobId` is a known `JobId`.
- Every `Reward.playCutscene.id` is a known cutscene id.
- Dialogue references (from trees or cutscene migration) all
  resolve — validated in `dialogueData.ts`, not the quest manager.

Failed validation **throws at boot**; the game refuses to start with a
broken quest graph. This is the right trade in dev and the failure is
caught immediately in CI by `npx tsc --noEmit && npx vite build`.

## 1.6 `FlagStore`

```ts
// src/game/flags/FlagStore.ts

export class FlagStore implements Saveable<FlagsSaveState> {
  readonly id = "flags";
  readonly version = 1;
  readonly schema: ZodType<FlagsSaveState>;

  constructor(bus: TypedEmitter);

  get(key: FlagKey): FlagValue | undefined;
  getBool(key: FlagKey): boolean; // missing = false
  set(key: FlagKey, value: FlagValue): void; // emits flags:changed
  clear(key: FlagKey): void;
  /** Read-only snapshot for the editor. */
  entries(): ReadonlyArray<[FlagKey, FlagValue]>;

  serialize(): FlagsSaveState;
  hydrate(data: FlagsSaveState): void;
}

export interface FlagsSaveState {
  flags: Record<FlagKey, FlagValue>;
}
```

Key format is `namespace.subnamespace.name` — free-form string, no
runtime validation. Convention only: the editor's autocomplete reads
existing keys from the store and from the currently loaded quest /
dialogue data to suggest completions.

`FlagStore.set` emits `flags:changed` with `{ key, value, prev }`.
`QuestManager` listens and re-evaluates step completion.

## 1.7 `DialogueDirector`

```ts
// src/game/dialogue/DialogueDirector.ts

export interface DialogueDirectorOptions {
  bus: TypedEmitter;
  scene: Phaser.Scene; // for wait/cleanup only; no rendering
  ctx: PredicateContext;
  rewards: RewardRunner;
}

export class DialogueDirector {
  constructor(opts: DialogueDirectorOptions);

  register(trees: DialogueTree[]): void;

  /** Present a tree. Resolves when the player closes the dialogue.
   *  Handles `dialogue:action` from the existing UI, evaluates choice
   *  predicates, runs `onEnter` and `onPick` rewards, and emits
   *  `dialogue:ended` with the final node id. */
  play(treeId: string, nodeId?: string): Promise<{ endNodeId: string | null }>;

  isPlaying(): boolean;
  stop(): void;
}
```

The director emits to the existing `dialogue:update` bus channel
using the same `DialogueState` shape — no new UI is required. It
replaces the bespoke `showDialogue()` implementation in
`CutsceneDirector`.

### Cutscene `say` migration (dual shape)

```ts
// src/game/cutscenes/types.ts  (modified)
export type CutsceneStep =
  // …existing…
  | {
      kind: "say";
      // Legacy inline shape. At least one of { pages } or
      // { dialogueId } must be set. Authoring tools emit the new
      // shape; existing data keeps working until migration.
      speaker?: string;
      pages?: string[];
      choices?: DialogueChoice[];
      dialogueId?: string;
      nodeId?: string;
    }
  | { kind: "changeMap"; mapId: string; tileX: number; tileY: number; facing?: CutsceneFacing };
```

In `CutsceneDirector`, `say` dispatches on presence of `dialogueId`.
When both are present, `dialogueId` wins and a dev warning is logged.

**Migration order:**

1. Ship dual shape in Phase 1. All existing cutscenes keep working
   unchanged.
2. After the dialogue editor lands (Phase 4), migrate
   `src/game/data/cutscenes.json` by hand or via a one-off script.
3. Remove the inline branch once no `say` in the repo uses it. This
   removal is deferred out of Phase 1 but tracked in the plan.

### `changeMap` step

Cutscene fires `cutscene:changeMapRequest` with `{ mapId, tileX,
tileY, facing }`. `WorldScene` and `InteriorScene` listen; the
active one performs the scene transition using the existing scene
launch paths (§1.3) and emits `world:mapEntered` on the target side.
The cutscene step `await`s `world:mapEntered` with a matching
`mapId` before continuing, with a 3s fallback timeout that logs a
warning and proceeds.

## 1.8 Bus events — additions

All events are added to the `Events` type in `src/game/bus.ts`. They
are **emitted from the systems that own the information**, not from
the quest module.

| Event | Payload | Emitter (Phase 1) | Consumer |
|---|---|---|---|
| `combat:enemyKilled` | `{ defId: string; instanceId: string; mapId: string; x: number; y: number }` | `Enemy.die()` | QuestManager |
| `gathering:nodeHit` | `{ defId: string; mapId: string }` | `GatheringNode.onHit()` | QuestManager |
| `gathering:nodeHarvested` | `{ defId: string; mapId: string; yieldedItemId: string; yieldedQuantity: number }` | `GatheringNode` when depleted | QuestManager |
| `fishing:caught` | `{ itemId: string; mapId: string; tier: CraftOutcomeTier \| null }` | `fishingSession` on catch | QuestManager |
| `shop:purchased` | `{ shopId: string; itemId: string; quantity: number }` | shop transact flow (existing shop store) — **verify a clean emit point exists before Phase 1 starts**; if not, add one | QuestManager |
| `crafting:complete` | `{ stationDefId: string; recipeId: string; tier: CraftOutcomeTier; movesUsed: number }` | **already emitted today** by the crafting flow — do not re-emit | QuestManager |
| `world:mapEntered` | `{ mapId: string; fromMapId: string \| null; reason: "load" \| "transition" \| "cutscene" }` | WorldScene, InteriorScene on create/resume | QuestManager, CutsceneDirector |
| `player:tileEntered` | `{ mapId: string; tileX: number; tileY: number }` | scene per-frame **only** when a listener is registered via `TileTriggerRegistry` | QuestManager |
| `npc:interacted` | `{ npcId: string; mapId: string }` | scenes' interact handler | QuestManager |

> **Known limitation.** `npc:interacted` does not distinguish between
> opening a shop, opening a dialogue, or triggering a cutscene. Quests
> can match on `npcId` only. If content ever needs "talked to X without
> buying," add an `interactionKind: "shop" \| "dialogue" \| "cutscene"`
> field later — additive change, no migration.
| `dialogue:ended` | `{ treeId: string; endNodeId: string \| null }` | DialogueDirector | QuestManager |
| `flags:changed` | `{ key: FlagKey; value: FlagValue \| undefined; prev: FlagValue \| undefined }` | FlagStore | QuestManager |
| `quest:started` | `{ questId: string }` | QuestManager | UI, telemetry |
| `quest:stepEntered` | `{ questId: string; stepId: string }` | QuestManager | UI |
| `quest:stepCompleted` | `{ questId: string; stepId: string }` | QuestManager | UI |
| `quest:completed` | `{ questId: string }` | QuestManager | UI |
| `quest:unlocked` | `{ questId: string }` | QuestManager | UI |
| `cutscene:changeMapRequest` | `{ mapId: string; tileX: number; tileY: number; facing?: CutsceneFacing }` | CutsceneDirector | WorldScene / InteriorScene |

### Tile-trigger design (avoid per-frame spam)

Tile triggers are the easiest place to accidentally emit 60 events/sec.

- `TileTriggerRegistry` (in `src/game/quests/tileTriggers.ts`): quest
  manager registers `{ mapId, tileX, tileY }` triples when a step with
  a `player:tileEntered` predicate becomes active, and deregisters on
  step exit.
- Scenes check the player's integer tile each frame; when it changes
  AND the new tile is in the registry, emit
  `player:tileEntered`. Nothing is emitted otherwise.
- Radius triggers expand to a set of tiles at registration time — the
  runtime check is always O(1) lookup.

## 1.9 Save integration

Two new saveables, registered in `SystemsScene`:

- `flagsSaveable` — id `"flags"`, v1. Schema:
  ```ts
  z.object({ flags: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])) })
  ```
- `questsSaveable` — id `"quests"`, v1. Schema:
  ```ts
  const QuestCursorSchema = z.object({
    questId: z.string(),
    stepId: z.string(),
    subgoals: z.record(z.string(), z.boolean()),
    startedAt: z.number(),
    enteredStepAt: z.number(),
  });
  const QuestsSaveStateSchema = z.object({
    statuses: z.record(z.string(), z.object({
      status: z.enum(["notStarted", "active", "completed"]),
      cursor: QuestCursorSchema.nullable(),
      completedAt: z.number().optional(),
    })),
    unlocked: z.array(z.string()),
  });
  ```

On load, `QuestManager.hydrate()` restores cursors and then does a
**reconciliation pass**: any active quest whose cursor's `stepId` is
no longer defined (because a designer edited the quest) is reset to
`entry`. Completed quests stay completed regardless. This prevents
content edits from soft-locking old saves. **Log a dev warning**
(`console.warn`) per reset so designers notice when their edits
silently rewound someone's progress.

Flags hydrate first (alphabetic saveable order is not guaranteed —
`SystemsScene` registers flags before quests explicitly).

## 1.10 Acceptance criteria

A fresh session can claim this phase done when:

- `npx tsc --noEmit` passes.
- `npx vite build` passes.
- `npm test` passes, with at least:
  - `FlagStore.test.ts`: set/get/clear round-trips, save/hydrate,
    `flags:changed` emitted with prev values.
  - `QuestManager.test.ts`: start via event, advance via
    `completeWhen`, branch via edge `when`, subgoals (parallel),
    `forceStart`/`jumpTo`, reward dispatch, save/hydrate,
    reconciliation after removing a step.
  - `predicates.test.ts`: every predicate kind, `and`/`or`/`not`.
  - `DialogueDirector.test.ts`: linear tree via `auto`, choice tree
    with a gated option, `onEnter`/`onPick` rewards, `dialogue:ended`
    payload.
- The existing `demo_blacksmith_chat` cutscene still works
  (dual-shape `say` path).
- A hand-authored smoke quest in `quests.json` completes end-to-end
  in the running game. (The smoke quest exists only in this phase's
  PR as a manual test; designer-authored content is a separate
  session.)

## 1.11 Phaser 4 notes for the implementer

- `QuestManager`, `FlagStore`, predicates, and rewards must **not**
  import Phaser. They run in plain TS so they're trivially testable
  and could later run in a worker if needed.
- `DialogueDirector` takes a `Phaser.Scene` only for `scene.time`
  fallbacks. Do not reach into rendering.
- Cutscene changes use `scene.tweens` / `scene.time` — same as
  today. The `changeMap` step must go through Phaser's scene
  manager transitions already used by the interior launch in
  `WorldScene`; don't roll a custom scene switcher.
- `SystemsScene` is the right owner for singletons (it already owns
  save orchestration). Do not construct `QuestManager` inside
  `WorldScene` — it would die on scene restart.

---

# Phase 2 — `/editor` React route scaffold

Goal: put a dev-only second route in place that Phases 3–6 fill in.
Ship nothing a player can see.

## Scope

- New top-level React route `/editor`, rendered only when
  `import.meta.env.DEV`. In prod builds the route does not exist —
  gate both at router level and at file-tree level so the editor's
  code is tree-shaken from the player bundle.
- Shared layout: left sidebar with tool list, main canvas/graph area,
  right inspector pane. Tools register themselves with a minimal
  interface.
- Vite plugin `tools/editor-write-plugin.mjs`: exposes
  `POST /__editor/write` accepting `{ path: string, content: string }`,
  restricts `path` to `src/game/data/*.json` and rejects traversal.
  Registered in `vite.config.ts` only when `mode === "development"`.
- Read-only JSON loading via the existing data imports (no new
  endpoint needed for reads).

## New files

```
src/editor/
  index.tsx              // route entry; no-op in prod
  EditorShell.tsx        // sidebar + inspector layout
  useJsonFile.ts         // load + save JSON via the write endpoint
  tools/registry.ts      // tool metadata (later phases register)
tools/
  editor-write-plugin.mjs
```

## Modified files

- `vite.config.ts` — conditionally add the plugin.
- `src/main.tsx` (or existing router entry) — mount `/editor` behind
  `import.meta.env.DEV`.

## Acceptance

- In dev, navigating to `/editor` renders the shell.
- In prod (`npx vite build`), `/editor` is absent from the bundle
  (confirm by grepping dist for a unique editor string).
- Writing a dummy JSON round-trips through the plugin and lands on
  disk with the exact content returned.

## Dependencies

Phase 1 not strictly required, but the editor is only useful once
data systems exist. Ship Phase 2 behind Phase 1.

---

# Phase 3 — Spatial NPC / spawn editor

Goal: replace the in-scene edit overlay pattern with a real React
tool at `/editor/spawns`. Proves the editor infrastructure end-to-end
against a feature the team already has a working mental model for.

## Scope

- A pane that renders a selected map (world or any interior) as a
  tile grid + sprite overlay. Uses a headless Phaser instance or a
  plain canvas reading the same TMJ + sprite pipeline — prefer the
  headless Phaser path so tile rendering stays consistent with the
  game.
- Click-to-place using the existing def registry (`npcs.json`,
  `enemies.json`, `nodes.json`, `stations.json`, `ships.json`,
  `itemInstances.json`).
- Drag-to-move. Property inspector for the selected entity. Undo
  via a simple command stack.
- Save writes back to the appropriate JSON file via the Phase 2
  plugin endpoint.

## Design notes

- The existing `EditSnapshot` / `edit:*` bus pattern stays for the
  in-game debug overlay; Phase 3 does **not** delete it. It just
  stops being the authoring surface — it remains useful as a
  "playtest nudge" tool. Mark the in-game overlay as "debug only"
  in its UI.
- The editor tool must **not** run in the game's scene. It embeds its
  own Phaser instance. Sharing a `Phaser.Scene` with the running game
  would cause lifecycle issues.

## Acceptance

- Placing, moving, deleting entities in `/editor/spawns` updates the
  JSON on disk; the running game picks up the change on refresh.
- The in-scene edit overlay still works for designers who want fast
  tweaks while playing.

---

# Phase 4 — Dialogue tree editor

Goal: let a designer author `dialogue.json` visually.

## Scope

- Route `/editor/dialogue`.
- Node-graph UI. **Recommend React Flow (xyflow)** — it's the de
  facto choice, has good TS types, and handles pan/zoom, edges,
  minimap, and custom nodes out of the box.
- Node types: Say (pages + speaker + portrait), Choice (choices with
  per-choice predicate gate + onPick rewards), End.
- Sidebar: tree list, node inspector, speaker palette, predicate
  builder widget (stubbed — it's the Phase 6 centerpiece, but a
  minimal flag/quest form is enough here).
- Live preview: "Play from here" button launches the game in a new
  tab with a query param that triggers `DialogueDirector.play(id,
  nodeId)` on boot. Existing game unchanged otherwise.

## Migration

After Phase 4, hand-migrate the one existing cutscene
(`demo_blacksmith_chat`) from inline `say` to a dialogue tree
reference. Deprecate the inline `say` path; remove it in a follow-up
PR once the repo is clean.

## Acceptance

- A tree authored in the UI saves, reloads in the UI, and plays in
  the running game.
- Predicate gate on a choice hides the option when the predicate is
  false (verified by flipping a flag in the dev console).

---

# Phase 5 — Cutscene editor

Goal: replace hand-edited `cutscenes.json` with a visual tool.

## Scope

- Route `/editor/cutscenes`.
- Hybrid: a node graph of step groups (top-level labels like `start`,
  `accept`, `decline`), each node expanding to a step timeline in the
  inspector.
- Actor reference picker resolves against the current map's spawn
  data (Phase 3) — so `brom_blacksmith` is a dropdown, not a typed
  string.
- Playtest-from-step: launches the game with a query param that runs
  `CutsceneDirector.play` starting at a chosen step group.

## Dependencies

- Phase 3 (actor picker needs spawn data).
- Phase 4 (dialogue refs need the tree editor to author targets).

## Acceptance

- `demo_blacksmith_chat` round-trips through the editor without
  content loss.
- `changeMap` step is authorable and plays correctly in-game.

---

# Phase 6 — Quest graph editor

Goal: the headline feature — visual authoring for `quests.json`.

## Scope

- Route `/editor/quests`.
- Graph of steps with edges labeled by their `when` predicate.
- **Predicate builder widget** — the single highest-leverage piece of
  UI in the whole plan:
  - Kind dropdown, then kind-specific fields.
  - Autocomplete for `itemId`, `jobId`, `mapId`, `npcId`, `enemyDefId`,
    `nodeDefId`, `dialogueId`, cutscene ids, flag keys.
  - `and` / `or` / `not` render as nested folding groups.
  - Validates on blur; red-border invalid nodes.
  - **Used everywhere**: quest `startWhen`, step `completeWhen`,
    edge `when`, subgoal `completeWhen`, dialogue choice `when`,
    Phase 7 spawn `when`. Build once, reuse five times.
- Reward builder: similar, kind dropdown + fields.
- Quest log preview: renders the graph as it would appear to the
  player if a log UI existed.
- Playtest controls:
  - Jump quest to any step.
  - Pre-set flags.
  - Force-emit any supported bus event with a payload form.
- Validation pass runs on save (every goto, every id reference)
  before hitting disk.

## Acceptance

- A quest authored entirely in the UI starts, branches, and completes
  in-game.
- A broken quest (dangling goto, unknown item id) is rejected at
  save-time with a clear error.
- Predicate widget is reused by the dialogue editor (Phase 4) —
  refactor it in during Phase 6 and replace the Phase 4 stub.

---

# Phase 7 — World-state mutation from flags

Goal: let the world itself change based on quest flags. A town can
evacuate; a bridge can appear; an enemy can despawn after a quest.

## Scope

- Optional `when?: Predicate` added to spawn entries:
  - `npcs.json` entries
  - `enemies.json` spawn definitions
  - `nodes.json` spawn definitions
  - `stations.json` entries
  - `ships.json` entries
- `interiorInstances.json`: optional `when` gating an entire interior
  instance.
- Scene spawn path (`src/game/world/spawns.ts` + callers) evaluates
  `when` via the same `predicates.ts` evaluator on:
  - Every `world:mapEntered`.
  - Every `flags:changed` — but only if at least one spawn on the
    currently-active map references the changed flag. Precompute a
    flag→spawn index at map load time to avoid O(N) scans.
- When a spawn transitions false → true, spawn it live. When true →
  false, despawn it gracefully (same path as enemy death cleanup,
  but without loot or XP).

## Schema change

```ts
interface NpcSpawn {
  // …existing…
  when?: Predicate;
}
```

Backwards-compatible: missing `when` means always present. No
migrations needed for existing data.

## Non-goals

- No tile-layer swaps (e.g. painting a bridge into the tilemap).
  That's a bigger feature and out of scope here. Designers can fake
  bridges with placed static objects.
- No authored "scripted day/night" world states — `when` is strictly
  flag/quest/predicate-driven.

## Acceptance

- An NPC with `when: { kind: "flag", key: "demo.town.evacuated",
  equals: true }` disappears when the flag is set via the debug
  console and reappears when it's cleared, without a scene reload.
- No measurable perf regression on map enter (flag→spawn index keeps
  evaluation under 1ms for maps with <100 spawns).

---

# Breaking changes summary

| Change | Phase | Migration |
|---|---|---|
| Cutscene `say` dual shape | 1 | Automatic — inline still works. Deprecated after Phase 4; removed in a cleanup PR. |
| Per-cutscene `setFlag`/`if` | 1 | Still works locally within a cutscene run, but new content should prefer global `FlagStore` via a reward. A followup can migrate and remove. Track but don't do in Phase 1. |
| New saveables (`flags`, `quests`) | 1 | Absent from old saves → defaults. No breakage. |
| Spawn `when` field | 7 | Additive; optional. |

---

# Appendix A — Act 1 validation walkthrough

This section proves the schema is sufficient. **No ids, text, or
flag values here are authoritative.** The designer will make those
calls in a later session. The names below are placeholders only.

## What the schema needs to cover

- **Map transitions** (house interior → town overworld → island
  interior → volcano interior → docked ship → open ocean)
- **Cutscene triggering** from flag sets, dialogue choices, and
  tile-entry
- **Dialogue choices that set flags** and that branch quests
- **Parallel sub-objectives** ("talk to N townspeople")
- **Skill / craft milestones** (reach woodcutting L1, craft one
  plank)
- **Combat kills** (pirates in the volcano cave)
- **Tile-entry triggers** ("spot heroes' boat" when player stands in
  a range of shore tiles)
- **Forced map changes during cutscenes** (evac cutscene
  teleports player to ship)
- **World state changes based on flags** (bridge appears, town
  empties)
- **Minor dialogue choices → different paths** without forking the
  mainline

## Walkthrough

Given (placeholder only) the following beats:

1. `wake_up`: starts on load if flag `intro.seen` is false.
   - Entry step has `completeWhen: npc:interacted(mom)`.
   - `onEnter` reward: `playCutscene intro_wake`.
2. `find_work`: unlocked by `wake_up.completed`.
   - Step `talk_to_folks` has **subgoals**: one per townsperson,
     each `completeWhen: npc:interacted(<id>)`.
   - Next edge: default `goto: pick_job`.
   - Step `pick_job` has `completeWhen: dialogue:ended` with
     `match.dialogueId = choose_job_tree` and branches on
     `match.dialogueEndNodeId` — each outcome `goto`s a different
     tutorial step.
3. `woodcut_tutorial`:
   - Step has `completeWhen: gathering:nodeHarvested(wood_log,
     minQuantity: 5)`.
   - Followed by `craft_tutorial` with `completeWhen:
     crafting:complete(plank)`.
4. `build_bridge`: completion reward
   `setFlag act1.bridgeBuilt true`.
   - Phase 7: the bridge tileset / prop is a spawn with
     `when: { kind: "flag", key: "act1.bridgeBuilt", equals: true }`.
5. `spot_heroes`: runs **parallel** with the mainline.
   - `startWhen: player:tileEntered` with a tile radius on the
     south shore.
   - Completes immediately; its reward plays a brief cutscene and
     sets `act1.heroesSpotted`.
6. `rescue_goblin`: standard combat + interact chain.
   - Step `clear_pirates` uses `completeWhen: combat:enemyKilled`
     with `match.enemyDefId = pirate`, `minQuantity: 3` (subgoal
     pattern, one per pirate).
7. `volcano_trail` → `villain_encounter`:
   - Entry to the villain map is a cutscene with `changeMap` into
     the volcano interior.
   - Cutscene ends by setting a flag that completes the step.
8. `evacuate_town`:
   - Triggered by the encounter completing. Cutscene does the
     heroes' rescue, then a final `changeMap` to the ship deck.
   - Sets `act1.townEvacuated true`; all town NPC spawns carry
     `when: not flag(act1.townEvacuated)`.
9. `volcano_explodes` (act-closing cutscene): plays on
   `world:mapEntered { mapId: "ship_deck" }` after `act1.townEvacuated`
   is set.

Every beat above composes from the schema. No beat required adding a
new predicate kind, reward kind, or step field — good sign the
vocabulary is sized right.

## Minor choice paths

A dialogue tree with three choices on page 2 sets one of three flags
(`act1.mom.tone = {stern, warm, funny}`). Two downstream dialogue
trees read that flag via `choices[n].when`. Mainline quest graph is
untouched — choice consequences live in dialogue data only.

## Gaps this exercise surfaced

- **Counters.** "Kill 3 pirates" is expressible via subgoals, but
  subgoals-as-counter scales poorly past ~5. Consider a `counter`
  predicate / step field in a later phase if content needs it.
  **Not Phase 1.**
- **Timers.** "Escape the volcano in 60s" has no primitive. Out of
  scope.

---

# Phase 1 implementation checklist (for a fresh session)

Work in this order. Do not start on later items until earlier ones
typecheck and have tests.

1. **Types.** Create `src/game/quests/types.ts` and
   `src/game/dialogue/types.ts`. Copy signatures from §1.4 verbatim.
   Run `npx tsc --noEmit`.
2. **Predicate evaluator.** `src/game/quests/predicates.ts` —
   pure function `evaluate(p: Predicate, ctx: PredicateContext,
   event?: { name: QuestEvent; payload: unknown }): boolean`. Unit
   tests for every kind and combinator.
3. **FlagStore.** `src/game/flags/FlagStore.ts` with Saveable
   implementation and `flags:changed` emission. Add
   `flags:changed` to `bus.ts`. Tests.
4. **Reward runner.** `src/game/quests/rewards.ts`. For each reward
   kind, emit to the existing bus events where possible
   (`jobs:xpGained`, `cutscene:play`, `inventory:action`-like grant);
   fall back to direct store access only where no bus event exists
   yet. Do **not** import `QuestManager` from here — instead export:

   ```ts
   export interface RewardHooks {
     flags: FlagStore;
     startQuest(questId: string): void;
     unlockQuest(questId: string): void;
     completeQuest(questId: string): void;
   }
   export class RewardRunner {
     constructor(bus: TypedEmitter, hooks: RewardHooks);
     run(rewards: readonly Reward[]): void;
   }
   ```

   `QuestManager` constructs the runner in its own constructor,
   passing itself as the hook source. This keeps rewards free of any
   direct dep on quests — the runner could be unit-tested against a
   fake hook bag.
5. **QuestManager.** `src/game/quests/QuestManager.ts`. Registry,
   cursor state, event handler, transition loop with cycle guard,
   Saveable. Emit quest lifecycle events on bus. Tests: start via
   event, branching, subgoals, save/hydrate, reconciliation.
6. **Bus additions.** Extend `Events` in `src/game/bus.ts` per §1.8.
   Add quest lifecycle + `cutscene:changeMapRequest`.
7. **Emit gaps.** Wire the six existing gameplay systems to emit the
   events they should already have been emitting
   (`Enemy.die`, `GatheringNode`, `fishingSession`, shop purchase
   flow, scene `create`/`resume` for `world:mapEntered`,
   `npc:interacted` in both scenes' E-press handler). One commit per
   system for reviewability.
8. **Tile-trigger registry.** `src/game/quests/tileTriggers.ts` +
   per-frame check in `WorldScene` and `InteriorScene` update().
9. **DialogueDirector.** Implements the Promise-based API; emits
   through the existing `dialogue:update` channel. Tests.
10. **Cutscene integration.** Extend `say` to dual shape; add
    `changeMap`. Update `CutsceneDirector.runStep` accordingly.
    Verify `demo_blacksmith_chat` still works (manual test + a new
    unit test that runs the director against a scripted tree).
11. **Data loaders.** `questsData.ts` and `dialogueData.ts` — load
    the JSON via the existing data registry pattern, Zod-validate,
    call `register()`.
12. **SystemsScene wiring.** Construct FlagStore, QuestManager,
    DialogueDirector in the correct order. Register both saveables
    in SaveManager (flags before quests).
13. **Smoke quest + dialogue.** Author a trivial quest and tree in
    `quests.json` / `dialogue.json` purely to exercise the pipeline.
    Delete before opening the PR — the Phase 1 PR ships the
    engine, not content.
14. **Verify.** `npx tsc --noEmit`, `npx vite build`, `npm test`,
    and a manual playthrough of the demo cutscene. Ask the user
    to reload their dev server and confirm nothing has regressed.
