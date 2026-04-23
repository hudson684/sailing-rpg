import { bus, type DialogueAction, type DialogueChoiceOption } from "../bus";
import type { RewardRunner } from "../quests/rewards";
import { evaluate, type PredicateContext } from "../quests/predicates";
import type { DialogueChoice, DialogueNode, DialogueTree } from "./types";

export interface DialogueDirectorOptions {
  ctx: PredicateContext;
  rewards: RewardRunner;
}

/** Presents dialogue trees via the existing `dialogue:update` bus
 *  channel. Replaces the bespoke showDialogue() loop in
 *  CutsceneDirector — cutscene `say` steps that reference a
 *  `dialogueId` delegate here. Resolves when the player closes the
 *  dialogue (either by selecting a choice with `goto: null`, by
 *  advancing off the end of a linear tree, or by pressing close). */
export class DialogueDirector {
  private trees = new Map<string, DialogueTree>();
  private resolver: ((action: DialogueAction) => void) | null = null;
  private boundAction = (action: DialogueAction) => this.resolver?.(action);
  private listenerOn = false;
  private playing = false;

  constructor(private readonly opts: DialogueDirectorOptions) {}

  register(trees: readonly DialogueTree[]): void {
    for (const t of trees) {
      if (this.trees.has(t.id)) {
        throw new Error(`[dialogue] duplicate tree id '${t.id}'`);
      }
      if (!t.nodes[t.entry]) {
        throw new Error(
          `[dialogue] tree '${t.id}' entry '${t.entry}' is not a defined node`,
        );
      }
      // Per-tree goto validation.
      for (const node of Object.values(t.nodes)) {
        if (node.auto && !t.nodes[node.auto]) {
          throw new Error(
            `[dialogue] tree '${t.id}' node '${node.id}' auto→'${node.auto}' is not a defined node`,
          );
        }
        for (const c of node.choices ?? []) {
          if (c.goto !== null && !t.nodes[c.goto]) {
            throw new Error(
              `[dialogue] tree '${t.id}' node '${node.id}' choice→'${c.goto}' is not a defined node`,
            );
          }
        }
      }
      this.trees.set(t.id, t);
    }
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getTree(id: string): DialogueTree | undefined {
    return this.trees.get(id);
  }

  /** Play a tree. Resolves with the last node id shown (or null if
   *  nothing shown). Emits `dialogue:ended` on resolve. */
  async play(
    treeId: string,
    nodeId?: string,
  ): Promise<{ endNodeId: string | null }> {
    const tree = this.trees.get(treeId);
    if (!tree) {
      console.warn(`[dialogue] unknown tree '${treeId}'`);
      return { endNodeId: null };
    }
    if (this.playing) {
      console.warn(`[dialogue] '${treeId}' ignored — already playing`);
      return { endNodeId: null };
    }
    this.playing = true;
    this.addListener();

    let currentId: string | null = nodeId ?? tree.entry;
    let lastShown: string | null = null;
    try {
      while (currentId) {
        const node: DialogueNode | undefined = tree.nodes[currentId];
        if (!node) {
          console.warn(
            `[dialogue] tree '${treeId}' has no node '${currentId}'`,
          );
          break;
        }
        if (node.onEnter) this.opts.rewards.run(node.onEnter);
        lastShown = node.id;
        const outcome = await this.presentNode(node);
        if (outcome.kind === "close") break;
        if (outcome.kind === "chose") {
          const choice = outcome.choice;
          if (choice.onPick) this.opts.rewards.run(choice.onPick);
          currentId = choice.goto;
          continue;
        }
        // Advanced off the last page of a no-choice node.
        currentId = node.auto ?? null;
      }
    } finally {
      this.removeListener();
      this.closeModal();
      this.playing = false;
      bus.emitTyped("dialogue:ended", {
        treeId,
        endNodeId: lastShown,
      });
    }
    return { endNodeId: lastShown };
  }

  stop(): void {
    if (!this.playing) return;
    this.resolver?.({ type: "close" });
  }

  // ── Internal ────────────────────────────────────────────────────

  private addListener(): void {
    if (this.listenerOn) return;
    bus.onTyped("dialogue:action", this.boundAction);
    this.listenerOn = true;
  }

  private removeListener(): void {
    if (!this.listenerOn) return;
    bus.offTyped("dialogue:action", this.boundAction);
    this.listenerOn = false;
  }

  private closeModal(): void {
    bus.emitTyped("dialogue:update", {
      visible: false,
      speaker: "",
      pages: [],
      page: 0,
    });
  }

  private presentNode(
    node: DialogueNode,
  ): Promise<
    | { kind: "close" }
    | { kind: "advanced" }
    | { kind: "chose"; choice: DialogueChoice }
  > {
    return new Promise((resolve) => {
      let page = 0;
      const visibleChoices = (node.choices ?? []).filter((c) =>
        c.when ? evaluate(c.when, this.opts.ctx) : true,
      );
      const hasChoices = visibleChoices.length > 0;

      const emit = () => {
        const choices: DialogueChoiceOption[] | undefined =
          hasChoices && page >= node.pages.length - 1
            ? visibleChoices.map((c, i) => ({
                label: c.label,
                // `goto` is the index into the filtered choices array;
                // the dialogue modal echoes back `{type: "select", index}`,
                // which we translate back below.
                goto: String(i),
              }))
            : undefined;
        bus.emitTyped("dialogue:update", {
          visible: true,
          speaker: node.speaker,
          pages: node.pages,
          page,
          choices,
        });
      };

      this.resolver = (action: DialogueAction) => {
        if (action.type === "close") {
          this.resolver = null;
          resolve({ kind: "close" });
          return;
        }
        if (action.type === "select" && hasChoices) {
          const choice = visibleChoices[action.index];
          this.resolver = null;
          resolve(
            choice
              ? { kind: "chose", choice }
              : { kind: "close" },
          );
          return;
        }
        // Advance.
        if (page < node.pages.length - 1) {
          page += 1;
          emit();
          return;
        }
        // Last page with pending choices: the modal blocks advance.
        if (hasChoices) return;
        this.resolver = null;
        resolve({ kind: "advanced" });
      };

      emit();
    });
  }
}
