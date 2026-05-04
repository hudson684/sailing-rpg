# Phase 1 — Bus events + per-NPC speech bubble plumbing

## Goal

Make `showSpeechBubble` reachable from anywhere in the codebase via
typed bus events, with each scene resolving npc-id → live sprite. No
chat logic yet — just the rendering seam every later phase calls into.

## Why first

The director (phase 4) and playback (phase 5) both need to "make NPC
X say a line" without holding scene/sprite references. Standing this
up first means later phases are pure logic against a one-line API,
and the existing crab-cake call site can also flow through the bus
for uniformity.

## Background

`src/game/fx/speechBubble.ts` already accepts any target with live
`x`/`y`. Today it's called directly from `GameplayScene.useItem` with
`this.player`. NPCs have no equivalent path because sim-layer code
can't import Phaser-coupled scenes.

`SceneNpcBinder.proxies` is `Map<npcId, NpcProxy>`; each proxy holds
an `NpcModel` whose `x`/`y` are live-updated every frame. That's the
target the bus listener needs to resolve.

## Deliverables

### 1. Bus events

Add to `src/game/bus.ts`:

```ts
"npc:speak": (payload: {
  npcId: string;
  text: string;
  durationMs?: number;
}) => void;

"player:speak": (payload: {
  text: string;
  durationMs?: number;
}) => void;
```

`durationMs` is optional; when omitted, the bubble uses
`showSpeechBubble`'s default.

### 2. Scene listeners

`SceneNpcBinder.attach()` subscribes to `npc:speak`. Handler:

1. Look up `this.proxies.get(payload.npcId)`.
2. If absent, drop the event silently (NPC isn't in this scene; some
   other scene's binder owns them, or they're abstract).
3. Call `showSpeechBubble(this.scene, proxy.model, payload.text, opts)`.

`detach()` unsubscribes.

`GameplayScene` (or its on-foot subclasses — wherever the player
sprite is owned) subscribes to `player:speak` with the same shape,
calling `showSpeechBubble(this, this.player, …)`.

### 3. Migrate the existing call site

In `src/game/scenes/GameplayScene.ts:467`, swap:

```ts
showSpeechBubble(this, this.player, "Just like Mum used to make!");
```

for:

```ts
bus.emitTyped("player:speak", { text: "Just like Mum used to make!" });
```

The direct import of `showSpeechBubble` in `GameplayScene` is no
longer needed at the call site (the listener still uses it).

## Out of scope

- Per-NPC bubble dedup beyond what `showSpeechBubble` already does
  (it replaces an active bubble on the same target).
- Pacing multiple consecutive lines — phase 5 owns that.
- Cross-scene bubbles. If the addressed NPC is in a different scene,
  the event drops. That's correct: the player can't see it anyway.

## Definition of done

- `npc:speak` and `player:speak` are typed events on `bus`.
- Emitting `npc:speak` from anywhere shows a bubble over that NPC if
  they're in the player's current scene, and is a silent no-op
  otherwise.
- The crab-cake call site emits `player:speak` and renders identically
  to before.
- `npx tsc --noEmit` passes; `npx vite build` passes.
