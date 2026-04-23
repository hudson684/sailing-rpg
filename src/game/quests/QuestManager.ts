import { z } from "zod";
import type { ZodType } from "zod";
import { bus } from "../bus";
import type { Saveable } from "../save/Saveable";
import type { FlagStore } from "../flags/FlagStore";
import { levelFromXp } from "../jobs/xpTable";
import { useGameStore } from "../store/gameStore";
import type { JobId } from "../jobs/jobs";
import { evaluate, type PredicateContext } from "./predicates";
import { RewardRunner } from "./rewards";
import type {
  QuestDef,
  QuestEvent,
  QuestEventEnvelope,
  Reward,
  StepDef,
} from "./types";

/** Cap re-entrant dispatch depth. If we're more than this many steps
 *  into a cascade (reward sets flag, which triggers quest A step B,
 *  whose onEnter sets another flag, ...), something has looped. */
const MAX_TRANSITION_DEPTH = 16;

export type QuestStatus = "notStarted" | "active" | "completed";

export interface QuestCursor {
  questId: string;
  stepId: string;
  /** Subgoal id → satisfied. Empty if step has no subgoals. */
  subgoals: Record<string, boolean>;
  startedAt: number;
  enteredStepAt: number;
}

// ─── Saveable schema ──────────────────────────────────────────────

const QuestCursorSchema = z.object({
  questId: z.string(),
  stepId: z.string(),
  subgoals: z.record(z.string(), z.boolean()),
  startedAt: z.number(),
  enteredStepAt: z.number(),
});

const QuestStatusEntrySchema = z.object({
  status: z.enum(["notStarted", "active", "completed"]),
  cursor: QuestCursorSchema.nullable(),
  completedAt: z.number().optional(),
});

export const QuestsSaveStateSchema = z.object({
  statuses: z.record(z.string(), QuestStatusEntrySchema),
  unlocked: z.array(z.string()),
});

export type QuestsSaveState = z.infer<typeof QuestsSaveStateSchema>;

// ─── QuestManager ─────────────────────────────────────────────────

export interface QuestManagerOptions {
  flags: FlagStore;
}

export class QuestManager implements Saveable<QuestsSaveState> {
  readonly id = "quests";
  readonly version = 1;
  readonly schema: ZodType<QuestsSaveState> = QuestsSaveStateSchema;

  private defs = new Map<string, QuestDef>();
  private statuses = new Map<string, QuestStatus>();
  private cursors = new Map<string, QuestCursor>();
  private completedAt = new Map<string, number>();
  private unlocked = new Set<string>();

  private readonly flags: FlagStore;
  private readonly rewards: RewardRunner;

  private dispatchDepth = 0;
  private boundCleanup: Array<() => void> = [];
  private bound = false;

  constructor(opts: QuestManagerOptions) {
    this.flags = opts.flags;
    this.rewards = new RewardRunner({
      flags: this.flags,
      startQuest: (id) => this.forceStart(id),
      unlockQuest: (id) => this.unlockQuest(id),
      completeQuest: (id) => this.forceComplete(id),
    });
  }

  // ── Registration + lifecycle ────────────────────────────────────

  register(defs: readonly QuestDef[]): void {
    for (const d of defs) {
      if (this.defs.has(d.id)) {
        throw new Error(`[quests] duplicate quest id '${d.id}'`);
      }
      validateDef(d);
      this.defs.set(d.id, d);
      if (!this.statuses.has(d.id)) this.statuses.set(d.id, "notStarted");
    }
  }

  /** Subscribe to the bus. Call once after construction. Idempotent. */
  bindBus(): void {
    if (this.bound) return;
    this.bound = true;

    const wire = <P>(
      name: QuestEvent,
      on: (fn: (p: P) => void) => void,
      off: (fn: (p: P) => void) => void,
    ) => {
      const handler = (payload: P) => {
        this.dispatch({
          name,
          payload: payload as unknown as Record<string, unknown>,
        });
      };
      on(handler);
      this.boundCleanup.push(() => off(handler));
    };

    wire("combat:enemyKilled",
      (fn) => bus.onTyped("combat:enemyKilled", fn),
      (fn) => bus.offTyped("combat:enemyKilled", fn));
    wire("gathering:nodeHit",
      (fn) => bus.onTyped("gathering:nodeHit", fn),
      (fn) => bus.offTyped("gathering:nodeHit", fn));
    wire("gathering:nodeHarvested",
      (fn) => bus.onTyped("gathering:nodeHarvested", fn),
      (fn) => bus.offTyped("gathering:nodeHarvested", fn));
    wire("fishing:caught",
      (fn) => bus.onTyped("fishing:caught", fn),
      (fn) => bus.offTyped("fishing:caught", fn));
    wire("crafting:complete",
      (fn) => bus.onTyped("crafting:complete", fn),
      (fn) => bus.offTyped("crafting:complete", fn));
    wire("jobs:xpGained",
      (fn) => bus.onTyped("jobs:xpGained", fn),
      (fn) => bus.offTyped("jobs:xpGained", fn));
    wire("world:mapEntered",
      (fn) => bus.onTyped("world:mapEntered", fn),
      (fn) => bus.offTyped("world:mapEntered", fn));
    wire("player:tileEntered",
      (fn) => bus.onTyped("player:tileEntered", fn),
      (fn) => bus.offTyped("player:tileEntered", fn));
    wire("npc:interacted",
      (fn) => bus.onTyped("npc:interacted", fn),
      (fn) => bus.offTyped("npc:interacted", fn));
    wire("dialogue:ended",
      (fn) => bus.onTyped("dialogue:ended", fn),
      (fn) => bus.offTyped("dialogue:ended", fn));
    wire("shop:purchased",
      (fn) => bus.onTyped("shop:purchased", fn),
      (fn) => bus.offTyped("shop:purchased", fn));
    wire("flags:changed",
      (fn) => bus.onTyped("flags:changed", fn),
      (fn) => bus.offTyped("flags:changed", fn));

    // Keep activeMapId in sync with scene transitions.
    const mapEnterHandler = (p: { mapId: string }) => {
      this.setActiveMap(p.mapId);
    };
    bus.onTyped("world:mapEntered", mapEnterHandler);
    this.boundCleanup.push(() => bus.offTyped("world:mapEntered", mapEnterHandler));
  }

  unbindBus(): void {
    if (!this.bound) return;
    for (const off of this.boundCleanup) off();
    this.boundCleanup = [];
    this.bound = false;
  }

  // ── Queries ─────────────────────────────────────────────────────

  getStatus(questId: string): QuestStatus {
    return this.statuses.get(questId) ?? "notStarted";
  }

  getCursor(questId: string): QuestCursor | null {
    return this.cursors.get(questId) ?? null;
  }

  isUnlocked(questId: string): boolean {
    return this.unlocked.has(questId);
  }

  // ── Manual overrides (editor + debug) ───────────────────────────

  forceStart(questId: string): void {
    const def = this.requireDef(questId);
    if (this.getStatus(questId) !== "notStarted") return;
    this.startQuestInternal(def);
    this.cascade();
  }

  jumpTo(questId: string, stepId: string): void {
    const def = this.requireDef(questId);
    const step = def.steps[stepId];
    if (!step) throw new Error(`[quests] unknown step '${stepId}' in '${questId}'`);
    if (this.getStatus(questId) !== "active") this.startQuestInternal(def);
    this.enterStep(def, step, /*skipLeaveRewards=*/ true);
    this.cascade();
  }

  forceComplete(questId: string): void {
    const def = this.requireDef(questId);
    if (this.getStatus(questId) === "completed") return;
    this.statuses.set(questId, "completed");
    this.cursors.delete(questId);
    this.completedAt.set(questId, Date.now());
    if (def.onComplete) this.rewards.run(def.onComplete);
    bus.emitTyped("quest:completed", { questId });
    this.cascade();
  }

  reset(questId: string): void {
    this.statuses.set(questId, "notStarted");
    this.cursors.delete(questId);
    this.completedAt.delete(questId);
  }

  // ── Saveable ────────────────────────────────────────────────────

  serialize(): QuestsSaveState {
    const statuses: QuestsSaveState["statuses"] = {};
    for (const [id, status] of this.statuses) {
      statuses[id] = {
        status,
        cursor: this.cursors.get(id) ?? null,
        completedAt: this.completedAt.get(id),
      };
    }
    return { statuses, unlocked: [...this.unlocked].sort() };
  }

  hydrate(data: QuestsSaveState): void {
    this.statuses.clear();
    this.cursors.clear();
    this.completedAt.clear();
    this.unlocked = new Set(data.unlocked);
    for (const [id, entry] of Object.entries(data.statuses)) {
      // Unknown quest in save — future-compat: skip silently.
      if (!this.defs.has(id)) continue;
      this.statuses.set(id, entry.status);
      if (entry.completedAt !== undefined) {
        this.completedAt.set(id, entry.completedAt);
      }
      if (entry.cursor && entry.status === "active") {
        const def = this.defs.get(id)!;
        const cursor = entry.cursor;
        if (!def.steps[cursor.stepId]) {
          // Step was removed since save. Reset to entry so the quest
          // doesn't soft-lock. Warn so the designer notices.
          console.warn(
            `[quests] '${id}' cursor pointed at missing step '${cursor.stepId}' — rewound to entry '${def.entry}'`,
          );
          this.cursors.set(id, {
            questId: id,
            stepId: def.entry,
            subgoals: {},
            startedAt: cursor.startedAt,
            enteredStepAt: Date.now(),
          });
        } else {
          this.cursors.set(id, { ...cursor });
        }
      }
    }
    // Ensure every known def has at least a notStarted status entry.
    for (const id of this.defs.keys()) {
      if (!this.statuses.has(id)) this.statuses.set(id, "notStarted");
    }
  }

  // ── Core dispatch ───────────────────────────────────────────────

  /** Public for tests — gameplay goes through bindBus(). */
  dispatch(env: QuestEventEnvelope): void {
    if (this.dispatchDepth >= MAX_TRANSITION_DEPTH) {
      console.warn(
        `[quests] transition depth cap (${MAX_TRANSITION_DEPTH}) exceeded — breaking cycle`,
      );
      return;
    }
    this.dispatchDepth += 1;
    try {
      // 1. Try to start any not-yet-started quest whose startWhen matches.
      for (const def of this.defs.values()) {
        if (this.getStatus(def.id) !== "notStarted") continue;
        if (!this.prerequisitesMet(def)) continue;
        if (!def.startWhen) continue;
        if (evaluate(def.startWhen, this.ctx, env)) {
          this.startQuestInternal(def);
        }
      }
      // 2. Advance any active quest on this event.
      for (const questId of [...this.cursors.keys()]) {
        const def = this.defs.get(questId);
        if (!def) continue;
        const cursor = this.cursors.get(questId);
        if (!cursor) continue;
        const step = def.steps[cursor.stepId];
        if (!step) continue;
        this.advanceStep(def, step, cursor, env);
      }
    } finally {
      this.dispatchDepth -= 1;
    }
  }

  /** After manual overrides, re-run dispatch with an empty envelope so
   *  that predicates that only depend on state (flag/step/quest) can
   *  settle. */
  private cascade(): void {
    this.dispatch({ name: "flags:changed", payload: {} });
  }

  private advanceStep(
    def: QuestDef,
    step: StepDef,
    cursor: QuestCursor,
    env: QuestEventEnvelope,
  ): void {
    // Update subgoals first.
    if (step.subgoals) {
      for (const sg of step.subgoals) {
        if (cursor.subgoals[sg.id]) continue;
        if (evaluate(sg.completeWhen, this.ctx, env)) {
          cursor.subgoals[sg.id] = true;
        }
      }
      // Block completion until all non-optional subgoals are satisfied.
      for (const sg of step.subgoals) {
        if (sg.optional) continue;
        if (!cursor.subgoals[sg.id]) return;
      }
    }
    // Check completion predicate. If there's no completeWhen AND no
    // subgoals, the step never auto-completes — it must be advanced
    // via jumpTo or next-edge triggers from other events. If subgoals
    // alone are used (no completeWhen), they act as completion.
    const passesCompleteWhen = step.completeWhen
      ? evaluate(step.completeWhen, this.ctx, env)
      : step.subgoals !== undefined && step.subgoals.length > 0;
    if (!passesCompleteWhen) return;

    // Pick the first matching outgoing edge.
    const edge = step.next.find((e) =>
      e.when ? evaluate(e.when, this.ctx, env) : true,
    );

    // Run onComplete rewards for the leaving step.
    if (step.onComplete) this.rewards.run(step.onComplete);
    bus.emitTyped("quest:stepCompleted", {
      questId: def.id,
      stepId: step.id,
    });

    // Terminal step (no outgoing edges that match) → complete the quest.
    if (!edge) {
      this.completeQuestInternal(def);
      return;
    }

    const nextStep = def.steps[edge.goto];
    if (!nextStep) {
      console.warn(
        `[quests] '${def.id}' step '${step.id}' → unknown step '${edge.goto}'`,
      );
      this.completeQuestInternal(def);
      return;
    }
    this.enterStep(def, nextStep, /*skipLeaveRewards=*/ true);
  }

  private startQuestInternal(def: QuestDef): void {
    this.statuses.set(def.id, "active");
    const entryStep = def.steps[def.entry];
    if (!entryStep) {
      throw new Error(`[quests] '${def.id}' has no entry step '${def.entry}'`);
    }
    const now = Date.now();
    this.cursors.set(def.id, {
      questId: def.id,
      stepId: entryStep.id,
      subgoals: {},
      startedAt: now,
      enteredStepAt: now,
    });
    bus.emitTyped("quest:started", { questId: def.id });
    // onEnter rewards for the entry step.
    if (entryStep.onEnter) this.rewards.run(entryStep.onEnter);
    bus.emitTyped("quest:stepEntered", {
      questId: def.id,
      stepId: entryStep.id,
    });
  }

  private enterStep(def: QuestDef, step: StepDef, _skipLeaveRewards: boolean): void {
    const now = Date.now();
    const cursor = this.cursors.get(def.id);
    if (cursor) {
      cursor.stepId = step.id;
      cursor.subgoals = {};
      cursor.enteredStepAt = now;
    } else {
      this.cursors.set(def.id, {
        questId: def.id,
        stepId: step.id,
        subgoals: {},
        startedAt: now,
        enteredStepAt: now,
      });
      this.statuses.set(def.id, "active");
    }
    if (step.onEnter) this.rewards.run(step.onEnter);
    bus.emitTyped("quest:stepEntered", {
      questId: def.id,
      stepId: step.id,
    });
  }

  private completeQuestInternal(def: QuestDef): void {
    this.statuses.set(def.id, "completed");
    this.cursors.delete(def.id);
    this.completedAt.set(def.id, Date.now());
    if (def.onComplete) this.rewards.run(def.onComplete);
    bus.emitTyped("quest:completed", { questId: def.id });
  }

  private unlockQuest(questId: string): void {
    if (!this.defs.has(questId)) return;
    if (this.unlocked.has(questId)) return;
    this.unlocked.add(questId);
    bus.emitTyped("quest:unlocked", { questId });
  }

  private prerequisitesMet(def: QuestDef): boolean {
    if (!def.prerequisites || def.prerequisites.length === 0) return true;
    return def.prerequisites.every((id) => this.getStatus(id) === "completed");
  }

  private requireDef(questId: string): QuestDef {
    const def = this.defs.get(questId);
    if (!def) throw new Error(`[quests] unknown quest '${questId}'`);
    return def;
  }

  // ── PredicateContext adapter ────────────────────────────────────
  //
  // Reaches into the zustand game store + flag store. Kept as a class
  // field so it's allocated once and reused.
  private ctx: PredicateContext = {
    flags: { get: (k) => this.flags.get(k) },
    hasItem: (itemId, min) => {
      const slots = useGameStore.getState().inventory.slots;
      let total = 0;
      for (const s of slots) if (s && s.itemId === itemId) total += s.quantity;
      return total >= min;
    },
    jobLevel: (jobId) => {
      const xp = useGameStore.getState().jobs.xp[jobId as JobId] ?? 0;
      return levelFromXp(xp);
    },
    activeMapId: () => this.activeMapId,
    isQuestStatus: (questId, status) => {
      const actual = this.getStatus(questId);
      if (status === "started") return actual === "active" || actual === "completed";
      if (status === "active") return actual === "active";
      if (status === "completed") return actual === "completed";
      return actual === "notStarted";
    },
    stepStatus: (questId, stepId) => {
      const cursor = this.cursors.get(questId);
      if (cursor && cursor.stepId === stepId) return "entered";
      const status = this.statuses.get(questId);
      // If the quest is completed, every step it once entered is
      // effectively completed. We don't log per-step history, so
      // approximate by treating any completed quest's steps as
      // completed — good enough for predicate gating.
      if (status === "completed") return "completed";
      return "notEntered";
    },
  };

  private activeMapId = "world";

  /** Scenes call this on `world:mapEntered` so the predicate
   *  `sceneMap` returns the current map without needing per-frame
   *  lookups. The bus event is also forwarded through dispatch so
   *  event-kind predicates fire. */
  setActiveMap(mapId: string): void {
    this.activeMapId = mapId;
  }
}

// ─── Validation ───────────────────────────────────────────────────

function validateDef(def: QuestDef): void {
  const stepIds = new Set<string>();
  for (const id of Object.keys(def.steps)) {
    if (stepIds.has(id)) {
      throw new Error(`[quests] '${def.id}' has duplicate step id '${id}'`);
    }
    stepIds.add(id);
  }
  if (!stepIds.has(def.entry)) {
    throw new Error(
      `[quests] '${def.id}' entry '${def.entry}' is not a defined step`,
    );
  }
  for (const [stepId, step] of Object.entries(def.steps)) {
    if (step.id !== stepId) {
      throw new Error(
        `[quests] '${def.id}' step key '${stepId}' does not match step.id '${step.id}'`,
      );
    }
    for (const edge of step.next) {
      if (!stepIds.has(edge.goto)) {
        throw new Error(
          `[quests] '${def.id}' step '${stepId}' goto '${edge.goto}' is not a defined step`,
        );
      }
    }
    if (step.subgoals) {
      const seen = new Set<string>();
      for (const sg of step.subgoals) {
        if (seen.has(sg.id)) {
          throw new Error(
            `[quests] '${def.id}' step '${stepId}' has duplicate subgoal id '${sg.id}'`,
          );
        }
        seen.add(sg.id);
      }
    }
  }
  walkRewards(def, (r) => {
    if (r.kind === "unlockQuest" || r.kind === "startQuest" || r.kind === "completeQuest") {
      // Cross-quest id validation happens at the manager level after
      // all defs register — see `validateAllRewards()` below.
    }
  });
}

function walkRewards(def: QuestDef, fn: (r: Reward) => void): void {
  if (def.onComplete) for (const r of def.onComplete) fn(r);
  for (const step of Object.values(def.steps)) {
    if (step.onEnter) for (const r of step.onEnter) fn(r);
    if (step.onComplete) for (const r of step.onComplete) fn(r);
  }
}

/** Cross-quest reward reference validation. Call after all defs are
 *  registered. Separated from per-def validation so a
 *  `playCutscene` / `unlockQuest` reference to a not-yet-registered
 *  quest is still catchable. */
export function validateCrossReferences(
  defs: readonly QuestDef[],
  cutsceneIds: ReadonlySet<string>,
): void {
  const questIds = new Set(defs.map((d) => d.id));
  for (const def of defs) {
    walkRewards(def, (r) => {
      if (
        (r.kind === "unlockQuest" ||
          r.kind === "startQuest" ||
          r.kind === "completeQuest") &&
        !questIds.has(r.questId)
      ) {
        throw new Error(
          `[quests] '${def.id}' references unknown quest '${r.questId}'`,
        );
      }
      if (r.kind === "playCutscene" && !cutsceneIds.has(r.id)) {
        throw new Error(
          `[quests] '${def.id}' references unknown cutscene '${r.id}'`,
        );
      }
    });
    for (const q of def.prerequisites ?? []) {
      if (!questIds.has(q)) {
        throw new Error(
          `[quests] '${def.id}' prerequisite '${q}' is unknown`,
        );
      }
    }
  }
}

