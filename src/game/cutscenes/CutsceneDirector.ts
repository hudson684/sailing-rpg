import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { bus, type DialogueAction } from "../bus";
import type { DialogueDirector } from "../dialogue/DialogueDirector";
import type {
  ActorRef,
  CutsceneDef,
  CutsceneFacing,
  CutsceneStep,
} from "./types";

/** Minimal contract a cutscene actor has to satisfy. NpcModel already
 *  matches; Player is wrapped by the host. */
export interface CutsceneActor {
  readonly x: number;
  readonly y: number;
  setPositionPx(x: number, y: number): void;
  setFacing?(dir: CutsceneFacing): void;
  setAnimState?(state: "idle" | "walk"): void;
  /** Pause / resume autonomous behavior (NPC AI ticks, player input) while
   *  the cutscene drives the actor. */
  setScripted?(scripted: boolean): void;
}

export interface CutsceneHost {
  /** Resolve an actor reference to a live actor in the current scene.
   *  Return undefined if the ref doesn't match anything — the director
   *  will warn and skip the step. */
  getActor(ref: ActorRef): CutsceneActor | undefined;
}

const DEFAULT_WALK_SPEED = 80; // px/sec — NPC default cruising speed.

export class CutsceneDirector {
  private playing = false;
  private active: { def: CutsceneDef; actorsTouched: Set<CutsceneActor> } | null = null;
  private cancelToken = 0;
  /** Resolves the current dialogue wait, if any. */
  private dialogueResolver: ((action: DialogueAction) => void) | null = null;
  private boundDialogueAction = (action: DialogueAction) => {
    this.dialogueResolver?.(action);
  };

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly host: CutsceneHost,
    /** Optional — when provided, `say` steps with a `dialogueId` route
     *  to the shared DialogueDirector instead of the legacy inline
     *  dialogue loop. Absent during unit tests that only exercise
     *  movement/flag steps. */
    private readonly dialogues?: DialogueDirector,
  ) {}

  isPlaying(): boolean {
    return this.playing;
  }

  /** Run a cutscene to completion. Resolves when the script ends (either by
   *  running off the entry group, hitting an `end` step, or being stopped). */
  async play(def: CutsceneDef): Promise<void> {
    if (this.playing) {
      console.warn(`[cutscene] '${def.id}' ignored — '${this.active?.def.id}' is already playing.`);
      return;
    }
    this.playing = true;
    this.active = { def, actorsTouched: new Set() };
    const myToken = ++this.cancelToken;
    bus.onTyped("dialogue:action", this.boundDialogueAction);

    const flags = new Map<string, string | number | boolean>();

    try {
      let label = def.entry;
      while (label && this.cancelToken === myToken) {
        const group = def.steps[label];
        if (!group) {
          console.warn(`[cutscene] '${def.id}' references unknown label '${label}'.`);
          break;
        }
        let nextLabel: string | null = null;
        for (const step of group) {
          if (this.cancelToken !== myToken) break;
          const result = await this.runStep(step, flags);
          if (result.kind === "end") {
            nextLabel = null;
            break;
          }
          if (result.kind === "goto") {
            nextLabel = result.label;
            break;
          }
        }
        label = nextLabel ?? "";
      }
    } finally {
      this.cleanup();
    }
  }

  /** Cancel any in-flight cutscene. Restores actor scripted flags and
   *  closes any open dialogue. */
  stop(): void {
    if (!this.playing) return;
    this.cancelToken++;
    this.cleanup();
  }

  private cleanup() {
    bus.offTyped("dialogue:action", this.boundDialogueAction);
    if (this.dialogueResolver) {
      // Force the awaiting `say` to unblock with a synthetic close.
      const resolve = this.dialogueResolver;
      this.dialogueResolver = null;
      resolve({ type: "close" });
    }
    if (this.active) {
      for (const actor of this.active.actorsTouched) actor.setScripted?.(false);
    }
    bus.emitTyped("dialogue:update", { visible: false, speaker: "", pages: [], page: 0 });
    this.active = null;
    this.playing = false;
  }

  private markScripted(actor: CutsceneActor) {
    if (!this.active) return;
    if (this.active.actorsTouched.has(actor)) return;
    this.active.actorsTouched.add(actor);
    actor.setScripted?.(true);
  }

  private async runStep(
    step: CutsceneStep,
    flags: Map<string, string | number | boolean>,
  ): Promise<{ kind: "next" } | { kind: "goto"; label: string } | { kind: "end" }> {
    switch (step.kind) {
      case "wait":
        await this.delay(step.ms);
        return { kind: "next" };

      case "walkTo": {
        const actor = this.resolve(step.actor);
        if (!actor) return { kind: "next" };
        this.markScripted(actor);
        const targetX = (step.tileX + 0.5) * TILE_SIZE;
        const targetY = (step.tileY + 0.5) * TILE_SIZE;
        const dx = targetX - actor.x;
        const dy = targetY - actor.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) return { kind: "next" };
        const speed = step.speed ?? DEFAULT_WALK_SPEED;
        const ms = (dist / speed) * 1000;
        if (Math.abs(dx) > 1) actor.setFacing?.(dx < 0 ? "left" : "right");
        actor.setAnimState?.("walk");
        await this.tweenPosition(actor, targetX, targetY, ms);
        actor.setAnimState?.("idle");
        return { kind: "next" };
      }

      case "face": {
        const actor = this.resolve(step.actor);
        if (!actor) return { kind: "next" };
        this.markScripted(actor);
        actor.setFacing?.(step.dir);
        return { kind: "next" };
      }

      case "anim": {
        const actor = this.resolve(step.actor);
        if (!actor) return { kind: "next" };
        this.markScripted(actor);
        actor.setAnimState?.(step.state);
        return { kind: "next" };
      }

      case "say": {
        if (step.dialogueId) {
          if (step.pages || step.choices) {
            console.warn(
              `[cutscene] say step has both dialogueId='${step.dialogueId}' and inline pages — dialogueId wins`,
            );
          }
          if (!this.dialogues) {
            console.warn(
              `[cutscene] say step references dialogueId='${step.dialogueId}' but no DialogueDirector was provided`,
            );
            return { kind: "next" };
          }
          await this.dialogues.play(step.dialogueId, step.nodeId);
          // Branching by dialogue end-node is expressed through quest
          // predicates, not cutscene gotos — the say step just returns.
          return { kind: "next" };
        }
        const choice = await this.showDialogue(
          step.speaker ?? "",
          step.pages ?? [],
          step.choices,
        );
        if (choice) return { kind: "goto", label: choice };
        return { kind: "next" };
      }

      case "changeMap": {
        await this.awaitChangeMap(step);
        return { kind: "next" };
      }

      case "goto":
        return { kind: "goto", label: step.label };

      case "setFlag":
        flags.set(step.name, step.value);
        return { kind: "next" };

      case "if": {
        const have = flags.get(step.flag);
        if (have === step.equals) return { kind: "goto", label: step.then };
        if (step.else) return { kind: "goto", label: step.else };
        return { kind: "next" };
      }

      case "end":
        return { kind: "end" };
    }
  }

  /** Fires the change-map request and awaits `world:mapEntered` with a
   *  matching mapId. Falls back after 3s if the scene never reports
   *  arrival — a warning is logged and the cutscene continues rather
   *  than wedging mid-script. */
  private awaitChangeMap(step: {
    mapId: string;
    tileX: number;
    tileY: number;
    facing?: CutsceneFacing;
  }): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const handler = (p: { mapId: string }) => {
        if (p.mapId !== step.mapId || done) return;
        done = true;
        bus.offTyped("world:mapEntered", handler);
        resolve();
      };
      bus.onTyped("world:mapEntered", handler);
      bus.emitTyped("cutscene:changeMapRequest", {
        mapId: step.mapId,
        tileX: step.tileX,
        tileY: step.tileY,
        facing: step.facing,
      });
      this.scene.time.delayedCall(3000, () => {
        if (done) return;
        done = true;
        bus.offTyped("world:mapEntered", handler);
        console.warn(
          `[cutscene] changeMap to '${step.mapId}' timed out after 3s`,
        );
        resolve();
      });
    });
  }

  private resolve(ref: ActorRef): CutsceneActor | undefined {
    const a = this.host.getActor(ref);
    if (!a) console.warn(`[cutscene] unknown actor ref '${ref}'.`);
    return a;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.scene.time.delayedCall(ms, () => resolve());
    });
  }

  /** Tween an actor's position via setPositionPx so both NpcModel-backed
   *  actors and Player (which mirrors model→sprite) stay in sync. */
  private tweenPosition(
    actor: CutsceneActor,
    toX: number,
    toY: number,
    ms: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      const fromX = actor.x;
      const fromY = actor.y;
      const proxy = { t: 0 };
      this.scene.tweens.add({
        targets: proxy,
        t: 1,
        duration: Math.max(1, ms),
        onUpdate: () => {
          const t = proxy.t;
          actor.setPositionPx(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t);
        },
        onComplete: () => {
          actor.setPositionPx(toX, toY);
          resolve();
        },
      });
    });
  }

  /** Display a dialogue page, page through it on `advance`, optionally show
   *  choices on the last page. Resolves with the chosen `goto` label, or
   *  `null` if the player just advances/closes through a no-choice dialogue. */
  private showDialogue(
    speaker: string,
    pages: string[],
    choices?: { label: string; goto: string }[],
  ): Promise<string | null> {
    return new Promise((resolve) => {
      let page = 0;
      const showChoices = choices && choices.length > 0;

      const emit = () => {
        bus.emitTyped("dialogue:update", {
          visible: true,
          speaker,
          pages,
          page,
          // Only attach choices on the final page so earlier pages still
          // advance normally with E/Space.
          choices: showChoices && page >= pages.length - 1 ? choices : undefined,
        });
      };

      this.dialogueResolver = (action: DialogueAction) => {
        if (action.type === "close") {
          this.dialogueResolver = null;
          bus.emitTyped("dialogue:update", { visible: false, speaker: "", pages: [], page: 0 });
          resolve(null);
          return;
        }
        if (action.type === "select" && showChoices) {
          const picked = choices![action.index];
          this.dialogueResolver = null;
          bus.emitTyped("dialogue:update", { visible: false, speaker: "", pages: [], page: 0 });
          resolve(picked?.goto ?? null);
          return;
        }
        // advance
        if (page < pages.length - 1) {
          page += 1;
          emit();
          return;
        }
        // Last page: if choices are pending, advance is a no-op — player must
        // click a choice or hit Escape. Otherwise the dialogue closes.
        if (showChoices) return;
        this.dialogueResolver = null;
        bus.emitTyped("dialogue:update", { visible: false, speaker: "", pages: [], page: 0 });
        resolve(null);
      };

      emit();
    });
  }
}
