# Phase 6 — Cooldown store + save round-trip

## Goal

Replace the in-memory cooldown placeholder with a persisted
`Record<chatId, dayCount>` that survives save/load and prunes entries
older than the longest-defined cooldown so it doesn't grow without
bound.

## Why sixth

Until this phase, cooldowns reset on every page reload, which is
fine for development but wrong for shipping. Persisting after the
director and playback are stable means the storage layer doesn't
have to evolve alongside selection logic.

## Background

The project already has a save store layered on IndexedDB
(`src/game/save/store/idbShared.ts` and friends) with a serializer
per subsystem. Adding a new `chatCooldowns` slice follows the same
pattern as other sim state.

`time:midnight` already exists on the bus and carries `dayCount`.
That's the natural cleanup hook.

## Deliverables

### 1. Store module

`src/game/sim/chat/chatStore.ts`:

```ts
interface ChatCooldownState {
  /** chatId → dayCount when it was last played. */
  lastPlayed: Record<string, number>;
}

export const chatCooldownStore = {
  isOnCooldown(chatId: string, currentDay: number): boolean;
  markPlayed(chatId: string, currentDay: number): void;
  /** For save serialization. */
  snapshot(): ChatCooldownState;
  /** For load deserialization. */
  restore(state: ChatCooldownState | undefined): void;
  /** Drop entries whose cooldown has fully elapsed. Called on midnight. */
  prune(currentDay: number): void;
};
```

`isOnCooldown` looks up `chatIndex` for the def's `cooldownDays` and
returns `(currentDay - lastPlayed) < cooldownDays`. If the def is
unknown (chat removed from data), returns `false` and the next
`prune` drops the orphan.

### 2. Save integration

Extend whatever sim-state envelope `idbShared` writes with a
`chatCooldowns` field carrying `chatCooldownStore.snapshot()`. On
load, call `chatCooldownStore.restore(envelope.chatCooldowns)`.

If the save predates this field, `restore(undefined)` should leave
the store empty — no migration needed because the only consequence
is "all chats are eligible on first day after upgrade," which is
fine.

### 3. Pruning

Subscribe to `time:midnight` at module init:

```ts
bus.onTyped("time:midnight", ({ dayCount }) => {
  chatCooldownStore.prune(dayCount);
});
```

`prune` iterates `lastPlayed` and removes entries where
`currentDay - lastPlayed >= maxCooldownAcrossAllDefs`. Computed once
at index build time. Cheap and bounded.

### 4. Director swap

Replace the placeholder in `chatDirector` with the real store:

```ts
if (chatCooldownStore.isOnCooldown(entry.def.id, currentDay)) continue;
```

And in `chatPlayback.start` (or wherever phase 5 stamps):

```ts
chatCooldownStore.markPlayed(def.id, currentDay);
```

### 5. Dev helper (optional, behind flag)

If the project has a dev console / cheats panel pattern, expose:

- `__chatDev.clearCooldowns()` — empty the map for testing.
- `__chatDev.listCooldowns()` — print remaining-days per chatId.

Skip if no such pattern exists; not worth standing one up.

## Out of scope

- Per-(scene, chat) or per-instance cooldowns. Locked to global per
  chat-id in the overview.
- Migration from any prior chat persistence (none exists).
- A UI for inspecting cooldowns. The dev overlay listed in the
  overview's open follow-ups would cover this.

## Definition of done

- After a chat plays, saving + reloading + waiting < 7 days does not
  replay it; waiting ≥ 7 days does.
- Removing a chat's JSON file does not break load (orphan entries
  are pruned on next midnight, ignored in the meantime).
- `chatCooldowns` round-trips through the save envelope unchanged.
- `npx tsc --noEmit` passes; `npx vite build` passes.
