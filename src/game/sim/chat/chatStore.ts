import { z } from "zod";
import type { Saveable } from "../../save/Saveable";
import { bus } from "../../bus";
import { chatIndex } from "./chatIndex";

// Persisted cooldown state. One day-stamp per chat-id, globally
// shared — once a chat plays anywhere, it's silent everywhere for
// `cooldownDays`. Pruned on each `time:midnight`.

export const ChatCooldownStateSchema = z.object({
  lastPlayed: z.record(z.string(), z.number().int().nonnegative()),
});
export type ChatCooldownState = z.infer<typeof ChatCooldownStateSchema>;

const lastPlayed = new Map<string, number>();

function maxCooldownAcrossAllDefs(): number {
  let max = 0;
  for (const def of chatIndex.all) {
    if (def.cooldownDays > max) max = def.cooldownDays;
  }
  return max;
}

export const chatCooldownStore = {
  isOnCooldown(chatId: string, currentDay: number): boolean {
    const stamp = lastPlayed.get(chatId);
    if (stamp === undefined) return false;
    const def = chatIndex.all.find((d) => d.id === chatId);
    // Unknown chat (removed from data): treat as not-on-cooldown so it
    // doesn't keep matching by accident; prune drops it next midnight.
    if (!def) return false;
    return (currentDay - stamp) < def.cooldownDays;
  },
  markPlayed(chatId: string, currentDay: number): void {
    lastPlayed.set(chatId, currentDay);
  },
  snapshot(): ChatCooldownState {
    const out: Record<string, number> = {};
    for (const [k, v] of lastPlayed) out[k] = v;
    return { lastPlayed: out };
  },
  restore(state: ChatCooldownState | undefined): void {
    lastPlayed.clear();
    if (!state) return;
    for (const [k, v] of Object.entries(state.lastPlayed)) lastPlayed.set(k, v);
  },
  /** Drop entries whose cooldown has fully elapsed. */
  prune(currentDay: number): void {
    const max = maxCooldownAcrossAllDefs();
    for (const [k, stamp] of [...lastPlayed.entries()]) {
      if (currentDay - stamp >= max) lastPlayed.delete(k);
    }
  },
};

let pruneSubInstalled = false;
export function ensureChatCooldownPruneSub(): void {
  if (pruneSubInstalled) return;
  pruneSubInstalled = true;
  bus.onTyped("time:midnight", ({ dayCount }) => {
    chatCooldownStore.prune(dayCount);
  });
}

/** Saveable that wires the cooldown map into the game's envelope. */
export function chatCooldownsSaveable(): Saveable<ChatCooldownState> {
  return {
    id: "chatCooldowns",
    version: 1,
    schema: ChatCooldownStateSchema as unknown as z.ZodType<ChatCooldownState>,
    serialize: () => chatCooldownStore.snapshot(),
    hydrate: (data) => chatCooldownStore.restore(data),
  };
}
