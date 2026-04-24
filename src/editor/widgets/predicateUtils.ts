import type { Predicate, QuestDef, Reward, StepDef } from "../../game/quests/types";

export function predicateSummary(p: Predicate): string {
  switch (p.kind) {
    case "event": return `event:${p.event}`;
    case "flag": return p.exists ? `flag:${p.key}?` : `flag:${p.key}=${p.equals}`;
    case "quest": return `quest:${p.questId}=${p.status}`;
    case "step": return `step:${p.questId}/${p.stepId}=${p.status}`;
    case "hasItem": return `item:${p.itemId}≥${p.min ?? 1}`;
    case "jobLevel": return `${p.jobId}≥L${p.min}`;
    case "sceneMap": return `map:${p.mapId}`;
    case "and": return `and(${p.all.length})`;
    case "or": return `or(${p.any.length})`;
    case "not": return `not(${predicateSummary(p.predicate)})`;
  }
}

/** Return a new predicate with `fn` applied bottom-up. If `fn` returns
 *  undefined, the node is removed (caller handles how). */
export function mapPredicate(
  p: Predicate | undefined,
  fn: (p: Predicate) => Predicate,
): Predicate | undefined {
  if (!p) return p;
  switch (p.kind) {
    case "and": {
      const all = p.all.map((c) => mapPredicate(c, fn)!).filter(Boolean);
      return fn({ kind: "and", all });
    }
    case "or": {
      const any = p.any.map((c) => mapPredicate(c, fn)!).filter(Boolean);
      return fn({ kind: "or", any });
    }
    case "not": {
      const inner = mapPredicate(p.predicate, fn);
      return fn({ kind: "not", predicate: inner ?? { kind: "flag", key: "" } });
    }
    default:
      return fn(p);
  }
}

export interface QuestRefRewrite {
  questId?: { from: string; to: string };
  step?: { questId: string; from: string; to: string };
}

/** Rewrites references to quest/step ids inside a predicate. */
export function rewritePredicateRefs(
  p: Predicate | undefined,
  rw: QuestRefRewrite,
): Predicate | undefined {
  return mapPredicate(p, (node) => {
    if (rw.questId && node.kind === "quest" && node.questId === rw.questId.from) {
      return { ...node, questId: rw.questId.to };
    }
    if (rw.questId && node.kind === "step" && node.questId === rw.questId.from) {
      return { ...node, questId: rw.questId.to };
    }
    if (
      rw.step &&
      node.kind === "step" &&
      node.questId === rw.step.questId &&
      node.stepId === rw.step.from
    ) {
      return { ...node, stepId: rw.step.to };
    }
    return node;
  });
}

/** Rewrites references inside a reward list. */
export function rewriteRewardRefs(
  list: Reward[] | undefined,
  rw: QuestRefRewrite,
): Reward[] | undefined {
  if (!list) return list;
  if (!rw.questId) return list;
  return list.map((r) => {
    if (
      (r.kind === "unlockQuest" || r.kind === "startQuest" || r.kind === "completeQuest") &&
      r.questId === rw.questId!.from
    ) {
      return { ...r, questId: rw.questId!.to };
    }
    return r;
  });
}

/** Apply a rewrite to every predicate/reward inside a step. */
export function rewriteStepRefs(step: StepDef, rw: QuestRefRewrite): StepDef {
  return {
    ...step,
    completeWhen: rewritePredicateRefs(step.completeWhen, rw),
    onEnter: rewriteRewardRefs(step.onEnter, rw),
    onComplete: rewriteRewardRefs(step.onComplete, rw),
    next: step.next.map((e) => ({ ...e, when: rewritePredicateRefs(e.when, rw) })),
    subgoals: step.subgoals?.map((sg) => ({
      ...sg,
      completeWhen: rewritePredicateRefs(sg.completeWhen, rw) ?? { kind: "flag", key: "" },
    })),
  };
}

/** Apply a rewrite to every predicate/reward inside a whole quest. */
export function rewriteQuestRefs<Q extends QuestDef>(quest: Q, rw: QuestRefRewrite): Q {
  const steps: Record<string, StepDef> = {};
  for (const [key, s] of Object.entries(quest.steps)) {
    steps[key] = rewriteStepRefs(s, rw);
  }
  return {
    ...quest,
    startWhen: rewritePredicateRefs(quest.startWhen, rw),
    onComplete: rewriteRewardRefs(quest.onComplete, rw),
    steps,
  };
}
