# Phase 5 — Playback: scripted lock, pacing, interrupts

## Goal

Replace the phase-4 stub with a real playback runtime: lock both
participants into a `scripted` state so their activities don't drag
them apart, face them toward each other, walk the `lines` array with
appropriate pacing, and abort cleanly on interruption.

## Why fifth

Director selection works without playback (phase 4 verified visually).
This phase is where the chat actually plays out and where most of the
"feels right" tuning lives.

## Background

`NpcModel.scripted = true` is the existing convention for "an
external system owns this NPC's motion; do not let activities tick
it." Used by cutscenes and customerSim. The proxy mirrors model →
agent body in this mode (see `NpcProxy.sync`), so when the chat ends
and `scripted` clears, the activity resumes from the right pixel
position.

## Deliverables

### 1. Playback module

`src/game/sim/chat/chatPlayback.ts`:

```ts
export interface ChatRunHandle {
  readonly id: string;
  readonly participants: ReadonlySet<string>;  // npcIds
  abort(reason: "player_dialogue" | "out_of_range" | "scene_change" | "combat"): void;
}

export const chatPlayback = {
  start(input: {
    def: ChatDef;
    slotMap: Record<string, NpcProxy>;  // slot → proxy
    scene: Phaser.Scene;
  }): ChatRunHandle;

  isChatting(npcId: string): boolean;
  activeChats(): readonly ChatRunHandle[];
};
```

### 2. Start sequence

1. For every proxy in `slotMap`: set `model.scripted = true`, record
   them in an internal `chattingNpcIds: Set<string>`.
2. Compute `facing` for each participant pointing at the other (use
   dx/dy sign on the two model positions; map to the existing
   `"left" | "right" | "up" | "down"` enum).
3. Set `model.facing` and `model.animState = "idle"` so they stand
   still facing each other for the entire chat.
4. Schedule the line walker (below).
5. Return a `ChatRunHandle`. Director stamps cooldown
   (`cooldownStore.markPlayed(def.id, currentDay)`) immediately on
   start — not on completion — so an interrupted chat still respects
   the 7-day window.

### 3. Line walker

Per line, in order:

- Compute duration: `READ_BASE_MS + READ_PER_CHAR_MS * text.length`,
  clamped to `[MIN_LINE_MS, MAX_LINE_MS]`. Suggested constants:
  `READ_BASE_MS = 1200`, `READ_PER_CHAR_MS = 45`, `MIN_LINE_MS =
  1500`, `MAX_LINE_MS = 5000`.
- Add a small inter-line gap (`GAP_MS = 250`) before the next line
  starts.
- Resolve `slotMap[line.by]` → `proxy.agent.id`, emit
  `bus.emitTyped("npc:speak", { npcId, text: line.text, durationMs: duration })`.
- Sleep `duration + GAP_MS` (use `scene.time.delayedCall` so pause/
  resume and scene shutdown clean up correctly — do not use raw
  `setTimeout`).

After the last line, finish (see end sequence).

### 4. End sequence

Triggered by either natural completion or `abort(reason)`:

- Cancel any pending `delayedCall`.
- For every proxy in `slotMap`: clear `model.scripted = false`. The
  proxy's next `sync()` will resume mirroring agent body → model and
  the activity picks back up.
- Remove all participant ids from `chattingNpcIds`.
- Drop the handle from `activeChats()`.

Cooldown is already stamped at start (decision in §2), so no stamp
on end.

### 5. Interrupt sources

The playback module owns the watchdog logic; per-tick checks happen
inside `chatPlayback` rather than spreading abort calls across the
codebase. On each director tick, after `chatDirector` runs, also
call `chatPlayback.tick(input)` with the same `DirectorTickInput`.
Inside, for each active handle:

- If any participant is no longer in `proxies` (left scene): abort
  `"scene_change"`.
- If any pair distance > `def.proximityTiles + 2` (small hysteresis):
  abort `"out_of_range"`.
- If `useShopStore`/`useDialogueStore`/etc. shows the player has
  opened dialogue with one of the participants (check via
  `npc:interacted` bus event subscribed at module init): abort
  `"player_dialogue"`.
- If the scene signals combat-active (existing flag, scene-specific):
  abort `"combat"`. If no such flag exists in the touched scenes,
  this check is a no-op until added.

### 6. Director integration

Replace the phase-4 stub:

- `chatDirector` calls `chatPlayback.start({...})` instead of logging.
- `isAlreadyChatting(proxy)` becomes `chatPlayback.isChatting(proxy.agent.id)`.
- Director still stamps cooldown at start — but now via the real
  `cooldownStore` (phase 6 lands alongside, or phase 5 keeps using
  the in-memory placeholder until phase 6 wires persistence).

### 7. Edge cases

- **Same NPC matches both slots.** Reject in the director's pair
  loop (`A.id === B.id` skip). Already implicit — don't iterate
  same-element pairs — but call it out in a comment.
- **Two chats want the same NPC same tick.** Director picks one
  winner per tick; the loser's NPCs aren't locked yet on the next
  tick because winner's start happened. Any subsequent eligible
  chat that would reuse a now-chatting NPC is filtered by
  `isChatting`.
- **Scene shutdown mid-chat.** `SceneNpcBinder.detach` should call
  `chatPlayback.abortAllInScene(sceneKey)` (new helper) before
  clearing proxies. The `delayedCall`s die with the scene anyway,
  but `scripted` flags need clearing on the models that are about
  to be dematerialized so the agent body sync doesn't snapshot a
  scripted-locked frame.

## Out of scope

- Speech-bubble pacing tweaks beyond the linear formula. If a chat
  needs custom timing per line, add an optional `holdMs` to
  `ChatLine` later.
- Visual cue that two NPCs are about to chat (head turn animation,
  exclamation mark). Could add behind a flag in a later pass.
- Per-line audio. Listed as a follow-up in the overview.

## Definition of done

- The umbrella chat plays end-to-end: Brom greets, tourist asks,
  tourist explains, Brom answers — with bubbles appearing in
  sequence over the right NPC, paced by text length.
- Interrupting (walk away, talk to Brom) ends the chat cleanly with
  no leftover scripted lock.
- Both NPCs face each other for the full duration and resume their
  prior activity afterward.
- `npx tsc --noEmit` passes; `npx vite build` passes.
