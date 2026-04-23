import { QuestManager, validateCrossReferences } from "./QuestManager";
import { FlagStore } from "../flags/FlagStore";
import { DialogueDirector } from "../dialogue/DialogueDirector";
import { RewardRunner } from "./rewards";
import { useGameStore } from "../store/gameStore";
import { levelFromXp } from "../jobs/xpTable";
import type { JobId } from "../jobs/jobs";
import type { PredicateContext } from "./predicates";
import questsDataRaw from "../data/quests.json";
import dialogueDataRaw from "../data/dialogue.json";
import cutsceneDataRaw from "../data/cutscenes.json";
import type { CutsceneData } from "../cutscenes/types";
import { loadQuestDefs } from "./questsData";
import { loadDialogueTrees } from "../dialogue/dialogueData";

/** Module-scoped singletons for the quest subsystem. These outlive
 *  scene restarts — WorldScene ↔ InteriorScene swaps must not
 *  recreate them. Registered with SaveManager once from WorldScene's
 *  initSave(). */
let flags: FlagStore | null = null;
let quests: QuestManager | null = null;
let dialogues: DialogueDirector | null = null;
let initialized = false;

export interface QuestSubsystem {
  flags: FlagStore;
  quests: QuestManager;
  dialogues: DialogueDirector;
}

/** Construct the subsystem once. Idempotent. */
export function ensureQuestSubsystem(): QuestSubsystem {
  if (initialized && flags && quests && dialogues) {
    return { flags, quests, dialogues };
  }
  flags = new FlagStore();
  quests = new QuestManager({ flags });

  const questDefs = loadQuestDefs(questsDataRaw);
  const dialogueTrees = loadDialogueTrees(dialogueDataRaw);
  const cutsceneIds = new Set(
    (cutsceneDataRaw as CutsceneData).cutscenes.map((c) => c.id),
  );
  validateCrossReferences(questDefs, cutsceneIds);
  quests.register(questDefs);
  quests.bindBus();

  const ctx = buildCtx(quests, flags);
  dialogues = new DialogueDirector({
    ctx,
    rewards: new RewardRunner({
      flags,
      // Dialogue-driven startQuest/forceComplete flow through the
      // same QuestManager surface quests.json would. Unlock in Phase
      // 1 lacks a public manager method — logging a warn keeps the
      // sharp edge obvious until Phase 6 exposes one.
      startQuest: (id) => quests!.forceStart(id),
      unlockQuest: (id) => {
        console.warn(
          `[dialogue-rewards] unlockQuest('${id}') from a dialogue tree; no public method in Phase 1`,
        );
      },
      completeQuest: (id) => quests!.forceComplete(id),
    }),
  });
  dialogues.register(dialogueTrees);

  initialized = true;
  applyDevQueryParams(flags, quests);
  return { flags, quests, dialogues };
}

/** Phase 4/5/6 playtest hooks: apply ?setFlag / ?questJump / ?emitEvent
 *  / ?playDialogue / ?playCutscene URL parameters once the subsystem
 *  is up. Strictly dev-only — no-op in prod builds. */
function applyDevQueryParams(flags: FlagStore, quests: QuestManager): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === "undefined") return;
  try {
    const params = new URLSearchParams(window.location.search);
    const setFlag = params.get("setFlag");
    if (setFlag) {
      const eq = setFlag.indexOf("=");
      const k = eq >= 0 ? setFlag.slice(0, eq) : setFlag;
      const rawV = eq >= 0 ? setFlag.slice(eq + 1) : "true";
      const v =
        rawV === "true" ? true :
        rawV === "false" ? false :
        !Number.isNaN(Number(rawV)) && rawV.trim() !== "" ? Number(rawV) :
        rawV;
      flags.set(k, v);
      console.log(`[dev] setFlag ${k}=${String(v)}`);
    }
    const jump = params.get("questJump");
    if (jump) {
      const [qid, sid] = jump.split(":");
      if (qid && sid) {
        quests.forceStart(qid);
        quests.jumpTo(qid, sid);
        console.log(`[dev] questJump ${qid}:${sid}`);
      }
    }
    const dlg = params.get("playDialogue");
    if (dlg && dialogues) {
      const nodeId = params.get("node") ?? undefined;
      // Defer one tick so the game has a chance to boot the scene.
      setTimeout(() => {
        dialogues!.play(dlg, nodeId).catch((err) => console.warn("[dev] playDialogue failed", err));
      }, 500);
    }
    const cs = params.get("playCutscene");
    if (cs) {
      // `group` is logged but the bus payload only supports `id` today;
      // jumping mid-cutscene needs a CutsceneDirector extension, tracked
      // as a follow-up. For now we just play the cutscene from its entry.
      const group = params.get("group");
      if (group) console.log(`[dev] playCutscene ${cs} (ignoring ?group=${group})`);
      setTimeout(() => {
        import("../bus").then(({ bus }) => {
          bus.emitTyped("cutscene:play", { id: cs });
        });
      }, 500);
    }
    const emit = params.get("emitEvent");
    if (emit) {
      setTimeout(() => {
        import("../bus").then(({ bus }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (bus as any).emitTyped(emit, {});
          console.log(`[dev] emitted ${emit}`);
        });
      }, 500);
    }
  } catch (err) {
    console.warn("[dev] query-param apply failed", err);
  }
}

function buildCtx(qm: QuestManager, fs: FlagStore): PredicateContext {
  return {
    flags: { get: (k) => fs.get(k) },
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
    activeMapId: () => "world",
    isQuestStatus: (id, s) => {
      const actual = qm.getStatus(id);
      if (s === "started") return actual === "active" || actual === "completed";
      if (s === "active") return actual === "active";
      if (s === "completed") return actual === "completed";
      return actual === "notStarted";
    },
    stepStatus: (id, stepId) => {
      const cursor = qm.getCursor(id);
      if (cursor && cursor.stepId === stepId) return "entered";
      return qm.getStatus(id) === "completed" ? "completed" : "notEntered";
    },
  };
}

export function getFlagStore(): FlagStore {
  if (!flags) throw new Error("[quests] subsystem not initialized");
  return flags;
}

/** The shared PredicateContext — exposed so the spawn-gating code
 *  (Phase 7) can evaluate `when` clauses without constructing its
 *  own copy. Depends on the subsystem being initialized. */
export function getPredicateContext(): PredicateContext {
  if (!quests || !flags) throw new Error("[quests] subsystem not initialized");
  return buildCtx(quests, flags);
}
export function getQuestManager(): QuestManager {
  if (!quests) throw new Error("[quests] subsystem not initialized");
  return quests;
}
export function getDialogueDirector(): DialogueDirector {
  if (!dialogues) throw new Error("[quests] subsystem not initialized");
  return dialogues;
}
