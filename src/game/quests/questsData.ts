import { z } from "zod";
import type { QuestDef, QuestsFile } from "./types";

/** Zod schemas for quest data validation. The schemas are structural —
 *  they guarantee the shape — but cross-reference validation (goto
 *  targets, item/job ids, cutscene refs, etc.) happens in
 *  QuestManager.register() and validateCrossReferences(). */

const FlagValueSchema = z.union([z.boolean(), z.number(), z.string()]);

const EventMatchSchema = z
  .object({
    enemyDefId: z.string().optional(),
    nodeDefId: z.string().optional(),
    itemId: z.string().optional(),
    jobId: z.string().optional(),
    mapId: z.string().optional(),
    npcId: z.string().optional(),
    dialogueId: z.string().optional(),
    dialogueEndNodeId: z.string().optional(),
    tile: z
      .object({
        map: z.string(),
        x: z.number(),
        y: z.number(),
        radius: z.number().optional(),
      })
      .optional(),
    minQuantity: z.number().optional(),
    tier: z.string().optional(),
    flagKey: z.string().optional(),
  })
  .strict();

// Recursive predicate schema via z.lazy — the and/or/not cases
// reference PredicateSchema itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PredicateSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z
      .object({
        kind: z.literal("event"),
        event: z.string(),
        match: EventMatchSchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("flag"),
        key: z.string(),
        equals: FlagValueSchema.optional(),
        exists: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("quest"),
        questId: z.string(),
        status: z.enum(["started", "completed", "notStarted", "active"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("step"),
        questId: z.string(),
        stepId: z.string(),
        status: z.enum(["entered", "completed"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("hasItem"),
        itemId: z.string(),
        min: z.number().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("jobLevel"),
        jobId: z.string(),
        min: z.number(),
      })
      .strict(),
    z
      .object({ kind: z.literal("sceneMap"), mapId: z.string() })
      .strict(),
    z.object({ kind: z.literal("and"), all: z.array(PredicateSchema) }).strict(),
    z.object({ kind: z.literal("or"), any: z.array(PredicateSchema) }).strict(),
    z.object({ kind: z.literal("not"), predicate: PredicateSchema }).strict(),
  ]),
);

const RewardSchema = z.union([
  z
    .object({
      kind: z.literal("grantItem"),
      itemId: z.string(),
      quantity: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("grantXp"),
      jobId: z.string(),
      amount: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("setFlag"),
      key: z.string(),
      value: FlagValueSchema,
    })
    .strict(),
  z.object({ kind: z.literal("clearFlag"), key: z.string() }).strict(),
  z.object({ kind: z.literal("playCutscene"), id: z.string() }).strict(),
  z.object({ kind: z.literal("unlockQuest"), questId: z.string() }).strict(),
  z.object({ kind: z.literal("startQuest"), questId: z.string() }).strict(),
  z.object({ kind: z.literal("completeQuest"), questId: z.string() }).strict(),
]);

const SubgoalSchema = z
  .object({
    id: z.string(),
    completeWhen: PredicateSchema,
    optional: z.boolean().optional(),
  })
  .strict();

const StepDefSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    onEnter: z.array(RewardSchema).optional(),
    onComplete: z.array(RewardSchema).optional(),
    completeWhen: PredicateSchema.optional(),
    next: z.array(
      z
        .object({ when: PredicateSchema.optional(), goto: z.string() })
        .strict(),
    ),
    subgoals: z.array(SubgoalSchema).optional(),
  })
  .strict();

const QuestDefSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    summary: z.string().optional(),
    startWhen: PredicateSchema.optional(),
    prerequisites: z.array(z.string()).optional(),
    entry: z.string(),
    steps: z.record(z.string(), StepDefSchema),
    onComplete: z.array(RewardSchema).optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

export const QuestsFileSchema = z
  .object({ quests: z.array(QuestDefSchema) })
  .strict();

export function loadQuestsFile(raw: unknown): QuestsFile {
  const parsed = QuestsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `[quests] invalid quests.json: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data as QuestsFile;
}

export function loadQuestDefs(raw: unknown): QuestDef[] {
  return loadQuestsFile(raw).quests;
}
