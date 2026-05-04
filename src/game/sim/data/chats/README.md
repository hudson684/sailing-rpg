# Ambient chats

Two-NPC speech-bubble vignettes that fire when the player is nearby.
No quests, no inventory, no flags get mutated — these are flavor.
The runtime lives in `src/game/sim/chat/`; this folder is the data.

## File layout

One JSON per chat. Filename matches the `id` field for greppability.
No subfolders.

```
src/game/sim/data/chats/
  brom_tourist_umbrella.json
  ...
```

The loader picks every `*.json` up automatically via Vite's
`import.meta.glob`. Author errors throw at startup with the file
path and field name — open the devtools console.

## Schema (worked example)

```jsonc
{
  // Stable id. Used as the key in the cooldown store. Once shipped,
  // don't rename — saves remember it.
  "id": "brom_tourist_umbrella",

  // Exactly two slots. Slot names are author-chosen and only used
  // by `lines[].by`.
  "participants": {
    "shopkeeper": {
      // Match by `npcId` (most-selective) or `archetype`.
      "match": { "npcId": "npc:brom_blacksmith" },
      // AND-combined predicate list. Empty/omitted = always satisfied.
      "requires": [
        { "activity": "idle" },
        { "time": { "phase": "day" } }
      ]
    },
    "customer": {
      "match": { "archetype": "tourist" },
      "requires": [
        { "activity": ["browse", "standAround"] }
      ]
    }
  },

  // Optional scene gate. Omit for "any scene". `chunk:<id>` is a
  // world chunk; `interior:<key>` is a building.
  "where": { "scene": "interior:blacksmiths" },

  // Chebyshev tile distance between the two participants. The
  // director also gates on a fixed ~10-tile radius around the player
  // (no chats fire offscreen).
  "proximityTiles": 5,

  // Global per-chat cooldown in in-game days. Once heard anywhere,
  // silent everywhere for this many days. Pruned at midnight.
  "cooldownDays": 7,

  // Weighted random tiebreak when multiple chats are eligible at the
  // same tick. Default 1.
  "weight": 1,

  // Played in order. `by` resolves to one of the slot names above.
  // Lines auto-time by character count (≈45 ms/char + 1.2 s base,
  // clamped to 1.5–5 s).
  "lines": [
    { "by": "shopkeeper", "text": "Welcome to the store!" },
    { "by": "customer",   "text": "Looking for an iron umbrella frame." },
    { "by": "shopkeeper", "text": "Unusual. I can do that." }
  ]
}
```

## Participant matching

- `{ "npcId": "npc:<def-id>" }` — pin a specific NPC. The `npc:`
  prefix is mandatory; agent ids are constructed as `npc:${def.id}`.
- `{ "archetype": "<archetype-id>" }` — match a class of NPCs (any
  `tourist`, any `townsfolk_default`, …). Use this when the chat is
  thematic rather than character-specific.

The two slots are matched without a fixed order — for each pair the
director tries both assignments. Don't write chats that only make
sense if "first" is left of "second"; it might play either way.

## Predicates

`requires` is an array of typed predicates, AND-combined. Unknown
keys throw at startup.

### `activity`

Matches `agent.currentActivity.kind`. Single string or array of
strings.

```json
{ "activity": "browse" }
{ "activity": ["wander", "standAround"] }
```

Available kinds: `browse`, `goTo`, `idle`, `noop`, `patrol`,
`patronTavern`, `sleep`, `standAround`, `wander`, `workAt`.

### `time`

Phase and/or hour range. Hours are inclusive `from`, exclusive `to`,
with wraparound (e.g. `22 → 4` covers 22:00–03:59).

```json
{ "time": { "phase": "day" } }
{ "time": { "hours": { "from": 18, "to": 22 } } }
```

### `flag`

Reads the same flag store quests use. `truthy` is the default if
neither is given.

```json
{ "flag": { "key": "quest.intro.completed", "truthy": true } }
{ "flag": { "key": "world.harborOpen", "equals": true } }
```

### `calendar`

Reads from the calendar context (and the festival registry for
`festival`). One of `weather`, `festival`, `season`, `dayOfWeek`.

```json
{ "calendar": { "festival": "harvest_festival" } }
{ "calendar": { "season": "autumn" } }
{ "calendar": { "dayOfWeek": ["sunsday", "moonsday"] } }
```

> Note: `weather` always evaluates to false until a live weather
> system exists. The shape is stable so authoring forward is fine.

The predicate vocabulary mirrors `plan/npc-schedule-enrichments/02-conditional-keys.md`
intentionally; check there for the design rationale.

## Cooldown semantics

One stamp per `id`, shared globally. Once a chat plays anywhere the
director won't pick it again for `cooldownDays` in-game days
**anywhere** in the world. Cooldowns persist through save/load and
prune at midnight when the longest authored window has elapsed.

Cooldown is stamped at chat *start*, not completion — so an
interrupted chat still respects the window (no instant replay if
the player walks away).

## Pacing

Lines auto-time by character count: `1200 + 45 × text.length` ms,
clamped to `[1500, 5000]`. A 250 ms gap separates lines.

If a line needs to land slower, pad the text — there is no `holdMs`.

## Anti-patterns

- Don't use chats to mutate state (flags, quests, inventory). If a
  line "should" change something, it belongs in real dialogue.
- Don't author > ~6 lines. Chats lock both participants out of their
  scheduled activity until they end. Long chats stop NPCs from
  doing their job.
- Don't gate on the *partner's* state. `requires` only sees the
  participant being matched — cross-participant constraints belong
  in the director (proximity already handles "they're together").
- Don't write chats that only make sense in one approach direction —
  the player may walk in mid-conversation. Missed lines don't replay.

## How to test

`npm run dev`, walk to the scene, and watch for bubbles. The chat
director is throttled to ~1 Hz. If a chat won't fire:

1. Check the predicates against the current activity / time / scene.
2. Check the cooldown — a 7-day window survives reload.
3. Check `chatIndex` lookups: a chat with no `where` lands in the
   "any scene" bucket; a chat with `where: { scene: ... }` is
   filtered out for other scenes.
