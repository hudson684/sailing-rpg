# NPC Ambient Chats — Plan Index

A small, data-driven system that lets two nearby NPCs play a short
back-and-forth dialogue in speech bubbles when conditions match (e.g.
Brom tending the shop + a tourist browsing). The player must be
nearby for the chat to fire, but is not necessarily a participant.

This rides on top of existing systems — the NPC registry, activities,
the live-tick architecture, and the speech-bubble renderer. It does
not change body ownership, schedules, or save shape beyond adding a
single cooldown map.

## Why

The world ticks NPCs through their day plans, but offscreen-vs-onscreen
NPCs feel identical when the player is in the room with them: they
walk, idle, and stand. There's no observable interaction *between*
NPCs. Ambient chats are the cheapest way to make a populated scene
feel social without expanding the dialogue/cutscene system or adding
new activities.

The reuse story is strong: speech bubbles already exist (`fx/speechBubble.ts`),
NPCs already have a `scripted` flag that lets external systems drive
them without activities stomping (used by cutscenes and customerSim),
and the bus already carries typed events that scenes subscribe to.

## What this is *not*

- A replacement for the dialogue/cutscene system. Ambient chats are
  speech-bubble flavor only — no choices, no quest hooks, no portrait
  UI, no progression effects.
- A new activity. Chatting reuses the existing `model.scripted = true`
  lock; activities pause and resume cleanly the same way they do for
  cutscenes.
- A pathing/positioning system. NPCs face each other in place; they
  do not walk together to start a chat. If they wander out of range
  mid-line the chat aborts.
- An author-time schedule editor. Chats are independent JSON files
  matched at runtime by participant predicates; they don't slot into
  schedule keys or replanners.

## Locked decisions

- **Trigger gate is player-proximity-first.** No chat eligibility is
  evaluated unless a player is in the scene; pair scanning iterates
  only proxies within ~10 tiles of the player. This keeps the
  director's cost proportional to what the player can actually
  observe.
- **Cadence is a throttled live tick, not `time:simTick`.** The
  director ticks at ~1 Hz from each scene's `update()`. 10-min sim
  ticks are too coarse for "5-tile proximity"; per-frame is needlessly
  hot.
- **Cooldown is global per chat-id.** One `Record<chatId, dayCount>`
  in the save store. Once heard anywhere, a chat is silent for
  `cooldownDays` everywhere. Simplest storage, prevents the same line
  repeating across towns.
- **Concurrency: ≤1 new chat per scene per director tick.** Eligible
  pairs are weighted-random sampled. This keeps overlapping bubbles
  rare without a global lock.
- **Interruptions abort and stamp.** If the player opens dialogue with
  a chatter, combat starts, or a participant leaves the scene, the
  chat ends and the cooldown is stamped anyway. Avoids the "same line
  replays seconds later" failure mode.
- **Predicates are static-analyzable.** AND/OR over typed predicates
  only — same shape as the schedule-enrichments resolver. No string
  interpolation, no live-state lookups beyond what's already in the
  predicate inputs (activity, time, flags, calendar/weather).
- **Index is compile-time, keyed by most-selective participant field.**
  Built once at module load; eligibility check is two map lookups + a
  small intersection, not a linear scan over all chats.
- **Speech-bubble rendering is the existing `showSpeechBubble`.** The
  director emits a typed bus event per line; scenes resolve npc-id →
  `NpcProxy.model` and call the existing renderer. No new draw path.

## Build order

| Step | Status | File |
|------|--------|------|
| 1. Bus events + per-NPC speech bubble plumbing | pending | `01-bus-and-bubbles.md` |
| 2. Chat data format + compile-time index | pending | `02-data-and-index.md` |
| 3. Predicate evaluator (activity, time, flag, calendar) | pending | `03-predicates.md` |
| 4. Director: pair scan, eligibility, weighted pick | pending | `04-director.md` |
| 5. Playback: scripted lock, pacing, interrupts | pending | `05-playback.md` |
| 6. Cooldown store + save round-trip | pending | `06-cooldown-store.md` |
| 7. Authoring docs + first real chats | pending | `07-authoring.md` |

Each phase ships independently and the game works between them.
Phases 1–2 are foundational; phase 3 is the predicate matcher shared
with future systems if needed; phases 4–5 are the runtime; phase 6
makes cooldowns persist; phase 7 turns it on for content.

## Recommended cut points

- **Walking-skeleton:** phases 1 + 2 + 4 + 5 with hard-coded "always
  eligible" predicates and an in-memory cooldown. Proves the
  director, lock, and pacing end-to-end with one authored chat.
- **MVP:** add phase 3 (real predicates) and phase 6 (persisted
  cooldowns). At this point the Brom/tourist umbrella chat works as
  specified.
- **Content-ready:** phase 7. Authoring README, conventions, and the
  first batch of real chats.

## Anti-goals

- Pathing NPCs together to converse. If they're not already within
  range, no chat fires. We will not add "walk over to chat" steering.
- Player-facing chat log / repeat-on-demand. Ambient chats are
  ephemeral; missing one is fine.
- Per-pair cooldowns or per-instance memory ("Brom has greeted *this
  specific tourist* before"). Global per-chat-id is the locked scope;
  per-instance state would need participant identity stable across
  despawn, which tourists don't have.
- Replacing customerSim's existing canned shop interactions. Those
  remain; ambient chats are additive flavor that may overlap thematically.
- Dynamic line generation, templating, or LLM hooks. Lines are
  authored strings.
- Letting ambient chats mutate world state (flags, quests, inventory).
  If a line *looks* like it should change something, that interaction
  belongs in real dialogue, not here.

## Data shape (preview — full spec in phase 2)

`src/game/sim/data/chats/brom_tourist_umbrella.json`:

```json
{
  "id": "brom_tourist_umbrella",
  "participants": {
    "shopkeeper": {
      "match": { "npcId": "blacksmith_brom" },
      "requires": { "activity": "tend_shop" }
    },
    "customer": {
      "match": { "archetype": "tourist" },
      "requires": { "activity": "browse" }
    }
  },
  "where": { "scene": "interior:blacksmiths" },
  "proximityTiles": 5,
  "cooldownDays": 7,
  "weight": 1,
  "lines": [
    { "by": "shopkeeper", "text": "Welcome to the store!" },
    { "by": "customer",   "text": "Thank you, I'm looking for a sturdy metal frame for my umbrella." },
    { "by": "customer",   "text": "My old one keeps blowing away." },
    { "by": "shopkeeper", "text": "That's an unusual request, but I can get it done for you." }
  ]
}
```

Top-level fields are stable across phases; the `requires` object grows
as phase 3 adds predicate kinds.

## Predicate vocabulary (v1)

Scoped to four kinds, sharing one evaluator:

- **`activity`** — matches `agent.currentActivity.kind`. Required for
  the Brom/tourist example.
- **`time`** — phase (`day` / `night`) and/or hour range (`{ from: 18, to: 23 }`).
  Reads from `timeStore`.
- **`flag`** — quest flags and world flags by key, with optional
  `equals` / `truthy` checks. Reads from the existing flag store.
- **`calendar`** — weather, festival id, season, day-of-week. Reads
  from `CalendarContext` (already passed through `time:midnight`).

A fifth kind is purely additive: register a new predicate evaluator,
update the JSON-schema notes in phase 7's authoring README. Existing
chats don't change.

## File layout

```
src/game/sim/chat/
  chatIndex.ts        ← compile-time index over data/chats/*.json
  chatPredicates.ts   ← shared predicate evaluator (phase 3)
  chatDirector.ts     ← runtime: pair scan, schedule, play, cooldown
  chatStore.ts        ← cooldown map + save/load hooks
src/game/sim/data/chats/
  *.json
  README.md           ← authoring guide (phase 7)
```

Wire-in is one line in each scene's `update()`:

```ts
chatDirector.tick(dtMs, this.player, this.binder.proxies);
```

## Dependencies on existing systems

- **Speech bubbles** — `src/game/fx/speechBubble.ts`. Generic on
  target; we only add the bus events and per-scene resolvers.
- **NPC registry / proxies** — `npcRegistry`, `SceneNpcBinder.proxies`,
  `NpcProxy.model`. Source of truth for "who is in this scene and
  where."
- **Scripted lock** — `NpcModel.scripted`. Existing convention for
  pausing activity-driven motion; reused verbatim.
- **timeStore + calendar** — predicate inputs for `time` and
  `calendar` kinds. Already exposed via `time:midnight` payloads and
  `timeStore` getters.
- **Flag store** — predicate input for the `flag` kind. Same store
  the schedule resolver and quests already read.
- **Save store (IDB shared)** — `cooldownByChatId` map persists
  alongside other sim state via the existing serializer.

## Open follow-ups (not blocking phase 1)

- Should the director surface a debug overlay (which chats are eligible
  right now, last-played stamps) behind the same dev flag as the
  schedule overlay? Probably yes once phase 4 lands; not worth a phase
  on its own.
- Localization — `text` is currently a raw string. If we add an i18n
  layer later, swap to a key-lookup; the data shape stays compatible.
- Audio — should chat lines optionally play a short blip per bubble?
  Easy to add to the playback step later; out of scope here.
