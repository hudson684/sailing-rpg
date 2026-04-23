import { z } from "zod";
import { QuestsFileSchema } from "../quests/questsData";
import type { DialogueFile, DialogueTree } from "./types";

// Reuse the predicate + reward schemas baked into QuestsFileSchema by
// extracting them from a shared builder. To keep this loader
// standalone and not circular, we duplicate the shapes we need.
// (Both files validate independently; a breaking drift in either
// is caught by tsc since they share the underlying Predicate / Reward
// types.)
const FlagValueSchema = z.union([z.boolean(), z.number(), z.string()]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PredicateSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("event"), event: z.string(), match: z.any().optional() }),
    z.object({ kind: z.literal("flag"), key: z.string(), equals: FlagValueSchema.optional(), exists: z.boolean().optional() }),
    z.object({ kind: z.literal("quest"), questId: z.string(), status: z.enum(["started", "completed", "notStarted", "active"]) }),
    z.object({ kind: z.literal("step"), questId: z.string(), stepId: z.string(), status: z.enum(["entered", "completed"]) }),
    z.object({ kind: z.literal("hasItem"), itemId: z.string(), min: z.number().optional() }),
    z.object({ kind: z.literal("jobLevel"), jobId: z.string(), min: z.number() }),
    z.object({ kind: z.literal("sceneMap"), mapId: z.string() }),
    z.object({ kind: z.literal("and"), all: z.array(PredicateSchema) }),
    z.object({ kind: z.literal("or"), any: z.array(PredicateSchema) }),
    z.object({ kind: z.literal("not"), predicate: PredicateSchema }),
  ]),
);

const RewardSchema = z.union([
  z.object({ kind: z.literal("grantItem"), itemId: z.string(), quantity: z.number() }),
  z.object({ kind: z.literal("grantXp"), jobId: z.string(), amount: z.number() }),
  z.object({ kind: z.literal("setFlag"), key: z.string(), value: FlagValueSchema }),
  z.object({ kind: z.literal("clearFlag"), key: z.string() }),
  z.object({ kind: z.literal("playCutscene"), id: z.string() }),
  z.object({ kind: z.literal("unlockQuest"), questId: z.string() }),
  z.object({ kind: z.literal("startQuest"), questId: z.string() }),
  z.object({ kind: z.literal("completeQuest"), questId: z.string() }),
]);

const DialogueChoiceSchema = z.object({
  label: z.string(),
  when: PredicateSchema.optional(),
  onPick: z.array(RewardSchema).optional(),
  goto: z.string().nullable(),
});

const DialogueNodeSchema = z.object({
  id: z.string(),
  speaker: z.string(),
  portrait: z.string().optional(),
  pages: z.array(z.string()),
  choices: z.array(DialogueChoiceSchema).optional(),
  auto: z.string().nullable().optional(),
  onEnter: z.array(RewardSchema).optional(),
});

const DialogueTreeSchema = z.object({
  id: z.string(),
  entry: z.string(),
  nodes: z.record(z.string(), DialogueNodeSchema),
});

export const DialogueFileSchema = z.object({
  trees: z.array(DialogueTreeSchema),
});

// Tie-in reference so an unused import warning doesn't fire on the
// quests schema re-export above. Kept near the top of the file where
// the coupling is most visible.
void QuestsFileSchema;

export function loadDialogueFile(raw: unknown): DialogueFile {
  const parsed = DialogueFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `[dialogue] invalid dialogue.json: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data as DialogueFile;
}

export function loadDialogueTrees(raw: unknown): DialogueTree[] {
  return loadDialogueFile(raw).trees;
}
