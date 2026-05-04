# Phase 7 — Authoring docs + first real chats

## Goal

Document the data format so non-engineer authors (or future-us at
3am) can add chats without reading the runtime, and seed the world
with the first real batch so the system is visible in normal play.

## Why last

Everything before this is plumbing. This phase is the only one
players notice. Doing it after phases 1–6 means the docs describe
what actually shipped, not what was planned.

## Deliverables

### 1. Authoring README

`src/game/sim/data/chats/README.md`. Sections:

**What this is.** One paragraph: ambient bubble dialogue between two
NPCs near the player, no quest/inventory effects.

**File layout.** One JSON per chat, filename matches `id` for
greppability. No subfolders in v1.

**Schema.** The full `ChatDef` shape with every field annotated.
Worked example: paste the umbrella chat with comments explaining
each field.

**Participant matching.** Explain `npcId` vs `archetype` (selectivity,
when to use which), and that the two slots are matched without
order — the director tries both assignments.

**Predicates.** One subsection per kind (`activity`, `time`, `flag`,
`calendar`) with the JSON shape, what input it reads, and one
example. Cross-link to `plan/npc-schedule-enrichments/02-conditional-keys.md`
for the design rationale; do not duplicate it.

**Cooldown semantics.** Global per chat-id, in-game days, pruned at
midnight. Once a chat plays it's silent everywhere for
`cooldownDays`.

**Pacing.** Lines auto-time by character count. If you need a longer
hold for emphasis, pad the text with a trailing space — don't
reach for `holdMs` (not implemented).

**Anti-patterns.** Bullet list:
- Don't use ambient chats for anything that mutates state — use real
  dialogue / cutscenes.
- Don't write chats that only make sense in one direction of player
  approach (the player might walk in mid-conversation; the bubble
  catches up but the missed lines don't replay).
- Don't author > ~6 lines. Ambient chats are vignettes; long ones
  block participants from doing their actual job.
- Don't gate on cross-NPC state (`requires` reads only the
  participant being matched; not their partner).

**How to test.** `npm run dev`, walk to the scene, watch console for
director logs (left in behind a verbose flag), use
`__chatDev.clearCooldowns()` to retry.

### 2. Initial chat batch

Aim for ~6–10 chats covering the spaces the player visits early.
Suggested set (final list depends on what NPCs/activities exist when
this phase ships):

- `brom_tourist_umbrella` — already exists from phase 2.
- `brom_tourist_souvenir` — generic curiosity, fires on any tourist
  browsing without the umbrella requirement.
- `tavern_keeper_patron_weather` — `requires: calendar.weather:
  rain` for the patron, casual weather small-talk.
- `dockmaster_sailor_departure` — sailor about to leave port,
  dockmaster wishes safe travel.
- `townsfolk_townsfolk_gossip_a` and `_b` — two interchangeable
  townsfolk in the market, no specific id matches, fires on any
  pair walking through the same plaza.
- `nightwatch_townsfolk_curfew` — `time.phase: night`, watchman
  reminds a wanderer to head home.
- `festival_vendor_tourist_bargain` — `calendar.festival` gated.

These are suggestions; the real list is whatever fits the world
content at ship time. The point of this phase is to author *enough*
that ambient chats feel like a system, not a one-off.

### 3. Pass-through QA

Walk the early-game route end-to-end and note:

- Do chats fire where expected?
- Does anything feel spammy (too short a cooldown, too many chats
  matching one NPC)?
- Are there NPCs the player hangs around that have *no* chats?
  Author one or two.
- Are bubbles colliding with other UI (shop prompts, dialogue
  boxes)? Speech-bubble offsets may need a per-context adjustment;
  out-of-scope to fix here, but log the cases.

### 4. Cross-link from `docs/npc-system.md`

Add a one-paragraph "Ambient chats" section to `docs/npc-system.md`
linking to `src/game/sim/chat/` and the data README. Same level of
treatment as the existing schedule / activity sections.

## Out of scope

- Localization of authored strings. Mentioned as overview follow-up.
- A chat editor UI. JSON is fine.
- Voice/audio. Overview follow-up.
- Tuning the predicate vocabulary based on authoring pain. If
  authors need a fifth kind, add it as a follow-up phase, not here.

## Definition of done

- README exists, covers every shipped feature, has a worked example.
- ≥ 6 ambient chats are authored, reviewed, and reachable in normal
  play.
- `docs/npc-system.md` references the system.
- A fresh playthrough of the first 30 minutes hears at least 2 chats
  without contrivance.
