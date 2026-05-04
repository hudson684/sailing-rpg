import * as Phaser from "phaser";
import { bus } from "../../bus";
import { TILE_SIZE } from "../../constants";
import type { NpcProxy } from "../../entities/npcProxy";
import type { NpcFacing } from "../../entities/npcTypes";
import type { ChatDef } from "./chatTypes";

// Pacing constants. Chosen so a typical 30-char line reads in ~2.5s
// and the longest authored line still clears in <5s.
const READ_BASE_MS = 1200;
const READ_PER_CHAR_MS = 45;
const MIN_LINE_MS = 1500;
const MAX_LINE_MS = 5000;
const GAP_MS = 250;
/** Hysteresis on the proximity check so a participant who jitters across
 *  the boundary doesn't abort. */
const RANGE_HYSTERESIS_TILES = 2;

export type AbortReason = "player_dialogue" | "out_of_range" | "scene_change" | "combat";

export interface ChatRunHandle {
  readonly id: string;
  readonly sceneKey: string;
  readonly participants: ReadonlySet<string>;
  abort(reason: AbortReason): void;
}

interface ActiveChat {
  def: ChatDef;
  sceneKey: string;
  slotMap: Record<string, NpcProxy>;
  participantIds: Set<string>;
  /** Pending Phaser timer events so we can cancel on abort. */
  timers: Phaser.Time.TimerEvent[];
  scene: Phaser.Scene;
  ended: boolean;
}

const active = new Map<ChatDef, ActiveChat>();
const chattingNpcIds = new Set<string>();
let interactedSubInstalled = false;

function lineDurationMs(text: string): number {
  const raw = READ_BASE_MS + READ_PER_CHAR_MS * text.length;
  return Math.max(MIN_LINE_MS, Math.min(MAX_LINE_MS, raw));
}

function facingTowards(self: { x: number; y: number }, other: { x: number; y: number }): NpcFacing {
  const dx = other.x - self.x;
  const dy = other.y - self.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "down" : "up";
}

function endChat(chat: ActiveChat): void {
  if (chat.ended) return;
  chat.ended = true;
  for (const t of chat.timers) t.remove(false);
  chat.timers.length = 0;
  for (const proxy of Object.values(chat.slotMap)) {
    proxy.model.scripted = false;
    chattingNpcIds.delete(proxy.agent.id);
  }
  active.delete(chat.def);
}

function ensureInteractedSub(): void {
  if (interactedSubInstalled) return;
  interactedSubInstalled = true;
  bus.onTyped("npc:interacted", ({ npcId }) => {
    for (const chat of active.values()) {
      if (chat.participantIds.has(npcId)) {
        endChat(chat);
        // (Cooldown was stamped at start, so no extra bookkeeping here.)
      }
    }
  });
}

function chebyshevTiles(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / TILE_SIZE;
}

function makeHandle(chat: ActiveChat): ChatRunHandle {
  return {
    id: chat.def.id,
    sceneKey: chat.sceneKey,
    participants: chat.participantIds,
    abort(_reason: AbortReason): void {
      endChat(chat);
    },
  };
}

export const chatPlayback = {
  start(input: {
    def: ChatDef;
    sceneKey: string;
    slotMap: Record<string, NpcProxy>;
    scene: Phaser.Scene;
  }): ChatRunHandle {
    ensureInteractedSub();

    const participantIds = new Set<string>();
    for (const proxy of Object.values(input.slotMap)) participantIds.add(proxy.agent.id);

    const chat: ActiveChat = {
      def: input.def,
      sceneKey: input.sceneKey,
      slotMap: input.slotMap,
      participantIds,
      timers: [],
      scene: input.scene,
      ended: false,
    };
    active.set(input.def, chat);

    // Lock + face. Two-slot v1 — pair each proxy with the other.
    const proxies = Object.values(input.slotMap);
    for (const proxy of proxies) {
      chattingNpcIds.add(proxy.agent.id);
      proxy.model.scripted = true;
      const other = proxies.find((p) => p !== proxy);
      if (other) proxy.model.facing = facingTowards(proxy.model, other.model);
      proxy.model.animState = "idle";
    }

    // Line walker. Each timer schedules one bubble emit; the last
    // line's timer ends the chat after its own duration + GAP.
    let cursor = 0;
    for (const line of input.def.lines) {
      const dur = lineDurationMs(line.text);
      const speakDelay = cursor;
      cursor += dur + GAP_MS;
      const timer = input.scene.time.delayedCall(speakDelay, () => {
        if (chat.ended) return;
        const speaker = chat.slotMap[line.by];
        if (speaker) {
          bus.emitTyped("npc:speak", {
            npcId: speaker.agent.id,
            text: line.text,
            durationMs: dur,
          });
        }
      });
      chat.timers.push(timer);
    }
    const finishTimer = input.scene.time.delayedCall(cursor, () => {
      endChat(chat);
    });
    chat.timers.push(finishTimer);

    return makeHandle(chat);
  },

  isChatting(npcId: string): boolean {
    return chattingNpcIds.has(npcId);
  },

  activeChats(): readonly ChatRunHandle[] {
    const out: ChatRunHandle[] = [];
    for (const chat of active.values()) out.push(makeHandle(chat));
    return out;
  },

  /** Per-tick watchdog. Director calls this with the same input it
   *  uses for `chatDirector.tick`. */
  tick(input: {
    sceneKey: string;
    proxies: ReadonlyMap<string, NpcProxy>;
  }): void {
    for (const chat of [...active.values()]) {
      if (chat.sceneKey !== input.sceneKey) continue;
      const proxies = Object.values(chat.slotMap);
      // Any participant left the scene → end.
      const stillHere = proxies.every((p) => input.proxies.has(p.agent.id));
      if (!stillHere) {
        endChat(chat);
        continue;
      }
      // Pair distance broke through hysteresis-padded radius → end.
      const limit = chat.def.proximityTiles + RANGE_HYSTERESIS_TILES;
      if (proxies.length >= 2) {
        const d = chebyshevTiles(proxies[0].model, proxies[1].model);
        if (d > limit) endChat(chat);
      }
    }
  },

  abortAllInScene(sceneKey: string): void {
    for (const chat of [...active.values()]) {
      if (chat.sceneKey === sceneKey) endChat(chat);
    }
  },
};

/** Test-only helper: wipe playback state. */
export function __resetChatPlaybackForTests(): void {
  for (const chat of active.values()) {
    for (const t of chat.timers) t.remove(false);
    for (const proxy of Object.values(chat.slotMap)) proxy.model.scripted = false;
  }
  active.clear();
  chattingNpcIds.clear();
}
