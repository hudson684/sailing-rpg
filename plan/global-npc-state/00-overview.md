# Global NPC State Management — Plan Index

A universal NPC daily-routine system. Every NPC has a planned day, executed
by a global registry that owns NPCs across scene boundaries. Activities are
the vocabulary; subsystems (tavern, shops, jobs) borrow NPC bodies for
specialized behavior. Inspired by Stardew Valley schedules + The Sims
interaction handoff.

## Why

Today: tavern customers and staff are interior-scoped, despawn when the
player leaves; wandering NPCs pick a random tile within a 3-tile radius.
There's no concept of an NPC having a *day*.

Goal: NPCs that exist as world citizens, plan a sequence of activities each
day (visit shops, eat at the tavern, sleep at home), and live that day
whether or not the player is watching.

## Locked decisions (from design conversation)

- **Global registry, not per-scene handoff.** One source of truth for every
  NPC; scenes are views over it.
- **Dual execution: live + abstract.** Live (per-frame, full pathfinding +
  animation) when player is in the same scene; abstract (per-minute, cheap
  bookkeeping) otherwise. Abstract state is canonical and serializable;
  live is a presentation layer on top.
- **Activities, not one giant FSM.** NPC top-level state is "running
  activity[i]." Activities are a small reusable vocabulary. Existing
  customer/staff FSMs are *not* rewritten — they become services that
  delegated activities (`PatronTavern`, `WorkAt`) hand the NPC body to.
- **Day-of-week + calendar from data.** `calendar.json` defines week
  length, month structure, season mapping. Authored once, swappable later.
- **Tavern queueing.** When full, `patronService.requestSeat` returns
  `Queued{eta}` or `Rejected`; the activity decides whether to wait,
  replan, or fail.
- **Body ownership = exactly one driver.** TypeScript-enforced
  `BodyHandle` token + runtime active-check in dev builds. Subsystems
  receive the handle on delegation, return it on completion.
- **Spawn definitions are hybrid.** Tiled object marks the *where*
  (`class: "npcSpawnPoint", spawnGroupId: "town_tourists"`); JSON owns the
  *rules* (rate, day-of-week weights, archetype).

## Architecture summary

Three layers:

1. **Sim** (`src/game/sim/`, no Phaser deps) — registry, agents, location,
   body handles, activities, planner, calendar. Pure, serializable.
2. **Adapters** (`src/game/entities/`, `src/game/world/sceneNpcBinder.ts`) —
   `NpcProxy` GameObjects, scene-binding lifecycle, pathfinding bridge.
3. **Subsystem services** (`src/game/business/customerSim/patronService.ts`,
   `src/game/business/staff/staffService.ts`) — accept borrowed NPCs from
   the registry, drive them through specialized FSMs, return the handle
   on completion.

See `architecture.md` for full layout, contracts, and data shapes.

## Build order

| Step | Status | File |
|------|--------|------|
| 1. Calendar + day-of-week | pending | `01-calendar.md` |
| 2. Registry skeleton + body handles + activity interface | pending | `02-registry-foundation.md` |
| 3. SceneNpcBinder + migrate Wander | pending | `03-binder-and-wander.md` |
| 4. GoTo + cross-scene movement | pending | `04-goto-cross-scene.md` |
| 5. PatronTavern + customerSim refactor | pending | `05-patron-tavern.md` |
| 6. Scheduler + Tourist archetype + spawn pipeline | pending | `06-scheduler-and-tourist.md` |
| 7. Browse / Idle support activities | pending | `07-browse-idle.md` |
| 8. WorkAt + staff service refactor | pending | `08-workat-staff.md` |
| 9. Migrate townsfolk + cleanup + save/load | pending | `09-townsfolk-cleanup.md` |

Each phase is shippable on its own — the game keeps working between
phases. Phases 5 and 8 ride behind a feature flag for one phase to allow
A/B comparison against the current behavior.

## Deferred (post phase 9)

- Interrupt layer (combat, dialogue, panic). Hook is reserved
  (`Activity.canInterrupt()`) but no real interrupters exist.
- Inter-NPC live-mode collision avoidance. Activities retry on collide.
- Weather / season-driven schedule variants. Calendar supports it; no
  schedule consumes it yet.
- Persistent NPC memory (relationships, opinions). Separate concern.

## Anti-goals

- Running live activity logic for NPCs in scenes other than the player's.
  The whole point of abstract is you don't pay for that.
- Making `Activity` polymorphic enough to handle every future system
  (combat, dialogue, fishing). Keep it focused on daily routine; combat
  lives above it as an interrupter.
- Shared "needs" model (hunger, energy) before the schedule system is
  proven. Stardew NPCs feel alive without it.
