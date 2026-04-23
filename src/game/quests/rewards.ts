import { bus } from "../bus";
import { useGameStore } from "../store/gameStore";
import type { JobId } from "../jobs/jobs";
import type { FlagStore } from "../flags/FlagStore";
import type { Reward } from "./types";

/** Hooks the RewardRunner needs. `QuestManager` implements these by
 *  wrapping its own internals — `rewards.ts` never imports the
 *  manager, which keeps the dependency arrow one-way (quests →
 *  rewards). Testable against a plain fake. */
export interface RewardHooks {
  flags: FlagStore;
  startQuest(questId: string): void;
  unlockQuest(questId: string): void;
  completeQuest(questId: string): void;
}

/** Executes reward lists on behalf of the quest + dialogue systems.
 *  For each kind, it prefers an existing bus event so side effects
 *  flow through the same channels gameplay already uses. Inventory
 *  grants fall back to the game store directly — there is no
 *  pre-existing "grant N of X" bus event, and inventing one only for
 *  this code path would be pure overhead. */
export class RewardRunner {
  constructor(private readonly hooks: RewardHooks) {}

  run(rewards: readonly Reward[] | undefined): void {
    if (!rewards || rewards.length === 0) return;
    for (const r of rewards) this.runOne(r);
  }

  private runOne(r: Reward): void {
    switch (r.kind) {
      case "grantItem": {
        const leftover = useGameStore
          .getState()
          .inventoryAdd(r.itemId, r.quantity);
        if (leftover > 0) {
          console.warn(
            `[rewards] inventory full — lost ${leftover}× ${r.itemId}`,
          );
        }
        return;
      }
      case "grantXp": {
        // jobsAddXp already emits `jobs:xpGained` via the store action.
        useGameStore.getState().jobsAddXp(r.jobId as JobId, r.amount);
        return;
      }
      case "setFlag":
        this.hooks.flags.set(r.key, r.value);
        return;
      case "clearFlag":
        this.hooks.flags.clear(r.key);
        return;
      case "playCutscene":
        bus.emitTyped("cutscene:play", { id: r.id });
        return;
      case "unlockQuest":
        this.hooks.unlockQuest(r.questId);
        return;
      case "startQuest":
        this.hooks.startQuest(r.questId);
        return;
      case "completeQuest":
        this.hooks.completeQuest(r.questId);
        return;
    }
  }
}
