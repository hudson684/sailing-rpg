# Phase 4 — Director: pair scan, eligibility, weighted pick

## Goal

Stand up `chatDirector` — the runtime that, on a throttled live tick,
finds nearby NPC pairs, asks the index whether any chat matches, and
hands a winner off to playback (phase 5). Cooldown and playback are
stubbed in this phase; the director only needs to *decide* that a
chat should start.

## Why fourth

Everything before this is data and pure functions. This is the first
phase that touches scene update loops and runs every frame (well,
every ~1s). Building it before playback means we can verify the
selection logic in isolation by logging picks.

## Background

The director needs three things per tick:

1. The player's position (for the proximity gate).
2. The set of `NpcProxy` instances in the current scene.
3. The current scene key.

`SceneNpcBinder` already owns all three. The director is invoked
from each scene's `update()`, which has the binder in hand.

## Deliverables

### 1. Director module

`src/game/sim/chat/chatDirector.ts`:

```ts
export interface DirectorTickInput {
  dtMs: number;
  sceneKey: string;
  player: { x: number; y: number } | null;
  proxies: ReadonlyMap<string, NpcProxy>;
}

export const chatDirector = {
  tick(input: DirectorTickInput): void;
};
```

Internal state:

- `accumulatorMs: number` — time since last attempt.
- `tickIntervalMs = 1000` — fires the eligibility scan at ~1 Hz.

### 2. Tick body

```
accumulatorMs += dtMs
if accumulatorMs < tickIntervalMs: return
accumulatorMs = 0

if player is null: return
if no chats touch this scene (chatIndex.byScene check): return

candidates = proxies near player within PLAYER_GATE_TILES (≈10)
for each unordered pair (A, B) in candidates:
  if pair distance > max(proximityTiles for any chat): continue
  if either A or B is already chatting: continue
  entries = candidatesFor(A.id, A.archetype, sceneKey)
  for entry in entries:
    if pair distance > entry.def.proximityTiles: continue
    partnerSlot = the other slot in entry.def.participants
    if !B matches partnerSlot.match: continue
    if !evaluateAll(entry.def.participants[entry.matchedSlot].requires, ctxFor(A)): continue
    if !evaluateAll(partnerSlot.requires, ctxFor(B)): continue
    if cooldownStore.isOnCooldown(entry.def.id, currentDay): continue
    push { def, A, B, slotMap, weight } onto eligibles

if eligibles is empty: return
pick winner by weighted random
playback.start(winner)   // phase 5
```

Symmetry: `candidatesFor(A, …)` and `candidatesFor(B, …)` would
double-count. The pair loop calls only one — for each unordered pair,
we look up entries keyed by A and check B against the partner slot.
That correctly considers both orderings because the index inserted
each chat under both participants' keys.

### 3. Per-NPC distance + position

`NpcProxy.model.x` / `.y` are live pixel positions. Convert to tile
distance with the project's tile size (32px). Use Chebyshev distance
(max of dx, dy in tiles) — matches "within 5 tiles in any direction"
intuitively and is what the rest of the codebase uses for tile
proximity. Note this in the JSON-schema docs (phase 7).

`PLAYER_GATE_TILES` constant (~10) lives at the top of the file.
Must be ≥ the largest authored `proximityTiles` (currently 5) to
avoid filtering out valid pairs.

### 4. Stubs

- `cooldownStore.isOnCooldown` — phase 6 implements; phase 4 ships
  with an in-memory `Set<string>` placeholder that always returns
  `false`. Director stamps it on `playback.start` for now so manual
  testing doesn't replay instantly.
- `playback.start` — phase 5 implements; phase 4 ships with a stub
  that emits a `console.log` and a single `npc:speak` event for
  `lines[0]` so we can verify selection visually.
- `isAlreadyChatting(proxy)` — phase 5 maintains the truth (the
  scripted lock + a `currentlyChatting` set). Phase 4's stub returns
  `false` always.

### 5. Wire-in

`SceneNpcBinder.update(dtMs)` (or each scene's update — pick the one
with stable access to `player`) calls:

```ts
chatDirector.tick({
  dtMs,
  sceneKey: this.sceneKey,
  player: this.scene?.getPlayerPosition() ?? null,
  proxies: this.proxies,
});
```

Add a `getPlayerPosition(): {x,y} | null` to the scenes that own a
player, returning the on-foot player's pixel position (or null when
the player is at sea / not in this scene).

## Out of scope

- Real cooldown persistence (phase 6).
- Actual line pacing, scripted lock, interrupt handling (phase 5).
- Spatial index. Linear scan over <PLAYER_GATE_TILES proxies is fine
  at expected NPC counts (≤30 per scene typically). Revisit if a
  profile shows it's hot.

## Definition of done

- Director runs on schedule, doesn't allocate per frame between
  ticks, and short-circuits on every gate check before doing
  per-pair work.
- With the stub playback, walking the player into the blacksmith
  shop while Brom is tending and a tourist is browsing produces a
  console log naming the chat and a single bubble over Brom's head.
- Walking away (>10 tiles) stops the director from selecting.
- `npx tsc --noEmit` passes.
