import * as Phaser from "phaser";
import { TILE_SIZE } from "../../constants";
import { getFlagStore } from "../../quests/activeQuestManager";
import { useTimeStore } from "../../time/timeStore";
import { minuteOfDay } from "../../time/constants";
import { calendarContextFor } from "../calendar/calendar";
import type { NpcProxy } from "../../entities/npcProxy";
import { candidatesFor, chatIndex } from "./chatIndex";
import type { ChatDef, ParticipantSpec } from "./chatTypes";
import {
  evaluateAll,
  type ChatPredicateContext,
} from "./chatPredicates";
import { chatPlayback } from "./chatPlayback";

/** Hard cap on the radius we'll consider before per-pair filtering. Must be
 *  ≥ the largest authored `proximityTiles` (currently 5). */
const PLAYER_GATE_TILES = 10;
const TICK_INTERVAL_MS = 1000;

export interface DirectorTickInput {
  dtMs: number;
  sceneKey: string;
  scene: Phaser.Scene;
  player: { x: number; y: number } | null;
  proxies: ReadonlyMap<string, NpcProxy>;
}

interface Eligible {
  def: ChatDef;
  slotMap: Record<string, NpcProxy>;
  weight: number;
}

// Phase-6 will swap this for a persisted store.
const inMemoryCooldown = new Set<string>();

function isAlreadyChatting(proxy: NpcProxy): boolean {
  return chatPlayback.isChatting(proxy.agent.id);
}
function isOnCooldown(chatId: string): boolean {
  return inMemoryCooldown.has(chatId);
}
function markPlayed(chatId: string, _currentDay: number): void {
  inMemoryCooldown.add(chatId);
}

function chebyshevTiles(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / TILE_SIZE;
}

function partnerSlot(def: ChatDef, matchedSlot: string): [string, ParticipantSpec] {
  for (const [k, v] of Object.entries(def.participants)) {
    if (k !== matchedSlot) return [k, v];
  }
  // Validation guarantees exactly two slots, so this is unreachable.
  throw new Error(`[chatDirector] '${def.id}' has no partner slot for '${matchedSlot}'`);
}

function matchesParticipant(proxy: NpcProxy, spec: ParticipantSpec): boolean {
  const m = spec.match;
  if ("npcId" in m) return proxy.agent.id === m.npcId;
  return proxy.agent.archetypeId === m.archetype;
}

function buildCtx(proxy: NpcProxy): ChatPredicateContext {
  const t = useTimeStore.getState();
  const minute = minuteOfDay(t.phase, t.elapsedInPhaseMs);
  const hour = Math.floor(minute / 60);
  return {
    agent: proxy.agent,
    now: { hour, phase: t.phase, dayCount: t.dayCount },
    calendar: calendarContextFor(t.dayCount),
    flags: getFlagStore(),
    weather: null,
  };
}

function pickWeighted(eligibles: Eligible[]): Eligible {
  let total = 0;
  for (const e of eligibles) total += e.weight;
  let r = Math.random() * total;
  for (const e of eligibles) {
    r -= e.weight;
    if (r <= 0) return e;
  }
  return eligibles[eligibles.length - 1];
}

function start(
  winner: Eligible,
  currentDay: number,
  scene: Phaser.Scene,
  sceneKey: string,
): void {
  // Stamp cooldown at start (not on completion) so an interrupted chat
  // still respects its window. Decision in plan/phase-5.
  markPlayed(winner.def.id, currentDay);
  chatPlayback.start({
    def: winner.def,
    sceneKey,
    slotMap: winner.slotMap,
    scene,
  });
}

let accumulatorMs = 0;

export const chatDirector = {
  tick(input: DirectorTickInput): void {
    accumulatorMs += input.dtMs;
    if (accumulatorMs < TICK_INTERVAL_MS) return;
    accumulatorMs = 0;

    // Watchdog runs first so interrupts free up participants before
    // this tick's selection considers them.
    chatPlayback.tick({ sceneKey: input.sceneKey, proxies: input.proxies });

    if (!input.player) return;

    // Early-out: no chats at all touch this scene (incl. the "any-scene"
    // bucket).
    const sceneList = chatIndex.byScene.get(input.sceneKey);
    const anySceneList = chatIndex.byScene.get(null);
    if (!sceneList && !anySceneList) return;

    // Narrow proxies to those within PLAYER_GATE_TILES of the player.
    const nearby: NpcProxy[] = [];
    for (const proxy of input.proxies.values()) {
      if (chebyshevTiles({ x: proxy.model.x, y: proxy.model.y }, input.player) <= PLAYER_GATE_TILES) {
        nearby.push(proxy);
      }
    }
    if (nearby.length < 2) return;

    const eligibles: Eligible[] = [];
    const seenChatIds = new Set<string>();
    const tDay = useTimeStore.getState().dayCount;

    for (let i = 0; i < nearby.length; i++) {
      const A = nearby[i];
      if (isAlreadyChatting(A)) continue;
      const entries = candidatesFor(A.agent.id, A.agent.archetypeId, input.sceneKey);
      if (entries.length === 0) continue;

      for (let j = 0; j < nearby.length; j++) {
        if (i === j) continue;
        const B = nearby[j];
        if (A.agent.id === B.agent.id) continue;
        if (isAlreadyChatting(B)) continue;
        const dist = chebyshevTiles(A.model, B.model);

        for (const entry of entries) {
          // Don't double-count when both A and B are indexed for the
          // same chat — we'll consider this pair through whichever
          // proxy hits the entry first.
          const pairKey = entry.def.id + "|" + (A.agent.id < B.agent.id ? A.agent.id + "|" + B.agent.id : B.agent.id + "|" + A.agent.id);
          if (seenChatIds.has(pairKey)) continue;

          if (dist > entry.def.proximityTiles) continue;
          const [partnerKey, partnerSpec] = partnerSlot(entry.def, entry.matchedSlot);
          if (!matchesParticipant(B, partnerSpec)) continue;

          if (isOnCooldown(entry.def.id)) continue;

          const matchedSpec = entry.def.participants[entry.matchedSlot];
          if (!evaluateAll(matchedSpec.requires, buildCtx(A))) continue;
          if (!evaluateAll(partnerSpec.requires, buildCtx(B))) continue;

          seenChatIds.add(pairKey);
          eligibles.push({
            def: entry.def,
            slotMap: { [entry.matchedSlot]: A, [partnerKey]: B },
            weight: entry.def.weight ?? 1,
          });
        }
      }
    }

    if (eligibles.length === 0) return;
    const winner = pickWeighted(eligibles);
    start(winner, tDay, input.scene, input.sceneKey);
  },
};

/** Test-only: drop director state. */
export function __resetChatDirectorForTests(): void {
  inMemoryCooldown.clear();
  accumulatorMs = 0;
}
