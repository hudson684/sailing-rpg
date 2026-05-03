# Phase 5 — Festivals as replanner override

## Goal

On a festival day, every NPC's normal schedule is replaced by a
hand-built sequence of activities placed at festival staging tiles.
Players walk into the festival and find the whole town there, doing
their festival thing. Stardew has this; we don't.

## Why

Festivals are the design moment where "the world feels alive" really
sells. Without them, even rich daily schedules feel same-y across the
calendar year. They're also a forcing function for content authoring —
once one festival exists and the pipeline is proven, adding more is
cheap.

## Background

Stardew implements festivals as a parallel system that bypasses
schedules entirely (`Data/Festivals/<festival>` files with hardcoded
tile placements and scripted dialogue). For us, the cleaner shape is
to reuse the existing replanner mechanism: a festival is just a
high-priority replanner that returns a hand-built `Activity[]` for
each NPC on the festival day.

Why this fits:

- The registry already iterates all persistent agents at midnight and
  asks each archetype's replanner for a new day plan
  (`registerReplanner` in `npcRegistry.ts:488`).
- Activities are already the right vocabulary — `GoTo` + `StandAround`
  + `Patrol` + `PatronTavern` cover most festival behaviors.
- Anchors (`namedTile`) already let us address symbolic positions on
  the map.

So: register one festival replanner that beats every archetype's
default; data drives what each NPC does that day.

## Deliverables

### 1. Festival data shape

`src/game/sim/data/festivals/<id>.json`:

```json
{
  "id": "harvest_festival",
  "calendarDay": { "season": "autumn", "dayOfMonth": 16 },
  "scene": "town_square",
  "openHour": 9,
  "closeHour": 22,
  "participants": {
    "townsfolk_default": { "kind": "wander_anchor", "anchor": "festival_floor", "radius": 6 },
    "staff:cook":        { "kind": "stand_at", "anchor": "festival_food_booth", "facing": "down" },
    "tourist":           { "kind": "browse_anchors", "anchors": ["festival_floor", "festival_stage"] }
  },
  "specialAgents": {
    "mayor": [
      { "kind": "goTo", "anchor": "festival_stage" },
      { "kind": "standAround", "anchor": "festival_stage", "until": 1080, "facing": "down" },
      { "kind": "goTo", "anchor": "festival_stage_speech" },
      { "kind": "standAround", "anchor": "festival_stage_speech", "duration": 30 }
    ]
  },
  "afterClose": "default"
}
```

Two tiers of authoring:

- **Per-archetype templates** — `participants` maps archetype-id (or
  prefix) to a small festival-template type. Most NPCs get this.
- **Per-agent overrides** — `specialAgents` keys an NPC id to a fully
  hand-built `Activity[]`. Used for the mayor giving a speech, etc.

Festival anchors (`festival_floor`, `festival_stage`, etc.) are
ordinary `namedTile` Tiled objects — no new anchor type.

### 2. Festival registry + replanner

`src/game/sim/festivals/festivalRegistry.ts`:

```ts
export function loadFestivals(): void;
export function festivalForDay(calendar: CalendarContext): FestivalDef | null;
```

`src/game/sim/festivals/festivalReplanner.ts` registers a replanner
under a special wildcard key `"*"` (extend `findReplanner` to check
`"*"` only when no archetype-specific replanner returned a plan, OR
hoist festival check above the per-archetype lookup — preferred):

```ts
bus.onTyped("time:midnight", ({ dayCount }) => {
  const festival = festivalForDay(calendarContextFor(dayCount));
  if (!festival) return;  // normal day, normal replanners run
  for (const agent of npcRegistry.allAgents()) {
    if (agent.flags.unregisterOnPlanExhaustion) continue;
    const plan = buildFestivalPlanForAgent(agent, festival);
    if (plan) npcRegistry.replaceDayPlan(agent.id, plan);
  }
});
```

The festival replanner runs *before* the existing per-archetype
midnight loop — so on a festival day, the festival plan wins, and the
default replanner sees the agent already has a fresh day plan and
short-circuits. (Add a "did festival replan happen this midnight"
flag on the bus event, or just check `agent.dayPlan[0].kind` before
overwriting.)

### 3. Plan builder

`buildFestivalPlanForAgent(agent, festival)`:

1. Look up `specialAgents[agent.id]` first; if present, use that plan
   directly (with a leading `GoTo` to the festival scene if needed).
2. Otherwise look up `participants[agent.archetypeId]`, falling back
   to longest-prefix match (same logic as `findReplanner`).
3. If neither matches, return `null` — agent runs its normal day. Some
   NPCs aren't at the festival; that's fine.

Built plans always start with `GoTo(festival.scene + festival_arrival_anchor)`
and end with `GoTo(spawnPoint or home)` so post-close the world tidies
itself.

### 4. Tourist spawn redirection

On festival days, the spawn dispatcher (`spawnDispatcher.ts`) routes
tourist spawns to the festival scene's npcSpawnPoints if they exist
there. This keeps festivals populated even on days that wouldn't
normally have heavy tourist traffic. Implementation: festival data
declares a `touristSpawnGroupOverride: "harvest_festival_tourists"`;
the dispatcher checks for an override before sampling its normal
spawn group.

### 5. Author docs

Update `src/game/sim/data/README.md` with a festival authoring guide:
where anchors come from, how to gate participants, how to test a
festival without waiting for the calendar.

Add a dev command: `window.__npc.forceFestival('harvest_festival')`
that triggers a midnight replan with the chosen festival. Essential
for authoring.

## Validation

- On the calendar day matching a festival's `calendarDay`, every
  matched agent's day plan starts with a `GoTo` to the festival scene.
- Agents not matched by `participants` or `specialAgents` run their
  normal schedule.
- The mayor's `specialAgents` plan executes in order, hitting the
  speech location at the right time.
- Walking into the festival scene late at night (after `closeHour`)
  finds it empty — agents have moved on per `afterClose`.
- Tourist spawn override populates the festival; turning the override
  off on a non-festival day produces normal tourist behavior.
- `window.__npc.forceFestival(...)` works mid-game without restarting.
- Save mid-festival, reload: the agent's festival plan persists; they
  resume at the same activity.

## Risks / mitigations

- **Risk:** festival agents collide at staging tiles (everyone wants
  to stand on `festival_stage`). **Mitigation:** festival templates
  can specify a radius, and the plan builder picks an offset per agent
  using the existing seeded RNG (`hashSeed(agent.id) ^ dayCount`).
- **Risk:** festivals stack with hard arrival times from phase 3.
  **Mitigation:** festival plans are hand-built; they can use
  `mustStartAt` directly. The phase 3 padding/trim logic doesn't care
  who built the plan.
- **Risk:** mid-festival reload races the replanner. **Mitigation:**
  the replanner runs at midnight only; reload doesn't trigger it.
  Hydrating an in-progress festival plan from snapshot just works.
- **Risk:** "afterClose" is hard to model without a third clock.
  **Mitigation:** the festival plan's last activity is a `GoTo home` —
  there is no third clock. The agent goes home when their plan says
  so. Festival "closing" is purely a content-authoring convention.

## Out of scope

- Scripted dialogue tied to festival timeline. Activities expose
  hooks for dialogue (`PatronTavern` does this); festivals reuse the
  same hooks but no new dialogue authoring is in scope here.
- Multi-day festivals. Author them as two separate festivals on
  consecutive days.
- Festival mini-games. Out of scope for the schedule layer; if/when
  added, they live above this as activity-interrupting cutscenes.
- Player-attendance gating ("festival only happens if the player
  reached friendship X with the mayor"). Phase 2's predicate language
  already supports this — just gate the festival data loader.

## Files touched

- New: `src/game/sim/data/festivals/<id>.json`
- New: `src/game/sim/festivals/festivalRegistry.ts`
- New: `src/game/sim/festivals/festivalReplanner.ts`
- New: `src/game/sim/festivals/festivalPlanBuilder.ts`
- Edited: `src/game/sim/npcRegistry.ts` (run festival replanner first
  at midnight)
- Edited: `src/game/sim/planner/spawnDispatcher.ts` (tourist override)
- Edited: `src/game/sim/data/README.md`
