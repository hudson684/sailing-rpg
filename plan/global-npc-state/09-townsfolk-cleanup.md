# Phase 9 — Migrate townsfolk + cleanup + save/load

## Goal

Existing townsfolk become first-class scheduled NPCs. Feature flags
removed. Save/load wired into the real save system. Documentation
pass. End state: every NPC in the game runs through the global
registry.

## Why last

By this point the system has been validated across two delegated
flows (patrons, staff) and one full archetype (tourist). Migrating
the remaining townsfolk is mechanical content work. Save/load
integration is safer here because the data shape has settled.

## Deliverables

- Authored simple schedules for each existing townsfolk NPC:
  - Default template: `Sleep(home)` → `Wander(town_area)` → optional
    `Browse(business)` → `Wander(town_area)` → `Sleep(home)`.
  - Per-NPC overrides where the world expects specific behavior
    (the baker visiting the docks at dawn, etc.).
- `src/game/sim/data/schedules/townsfolk_default.json` plus per-NPC
  override files where needed.
- Authored `npcResidence` objects for every existing townsfolk NPC.
- Remove leftover spawn-from-`NpcModel` paths in `npcBootstrap.ts`.
  All NPC creation goes through `registry.register`.
- Remove feature flags: `npcRegistryPatrons`, `npcRegistryStaff`.
  Delete the dormant code paths in `customerSim.ts`.
- Save/load integration:
  - Hook `registry.serialize()` into the existing save flow as a
    new top-level key.
  - On load, `registry.hydrate(snap)` runs after businesses /
    inventory / world state. Spawn groups re-resolve scheduled
    arrivals from the loaded calendar day.
  - Schema versioning: include `schemaVersion` in `RegistrySnapshot`;
    add a one-line migration stub for future use.
- Documentation:
  - `src/game/sim/README.md` — how to author a new activity.
  - `src/game/sim/data/README.md` — how to author a new archetype +
    schedule + spawn group.
  - Update root `CLAUDE.md` with a one-line pointer to the sim layer.

## Validation

- Full game loop with townsfolk + tourists + staff coexisting:
  - Walk around town through a full in-game day; everyone behaves
    sensibly.
  - Multiple consecutive days; weekday/weekend variation visible.
  - Save mid-day, quit, relaunch, load: world resumes seamlessly.
- Flag-removed builds tested for behavior parity vs. last
  pre-removal build.
- No references to the old `NpcModel` AI tick path remain
  (`grep` clean).
- `npx tsc --noEmit` and `npx vite build` clean.

## Risks / mitigations

- **Risk:** save-format change breaks existing player saves.
  **Mitigation:** schemaVersion supports a no-op load for missing
  registry key (treat as "no NPCs" and let spawn pipeline repopulate
  on next midnight).
- **Risk:** an obscure townsfolk relied on a specific old wander
  behavior used by a quest / cutscene. **Mitigation:** quest gating
  on NPCs already routes through `SpawnGateRegistry`; preserved.
  Audit existing quests touching NPCs as part of this phase.
- **Risk:** scope creep — "while we're in here, let's add needs /
  relationships." **Mitigation:** explicitly anti-goal in
  `00-overview.md`; defer.

## Out of scope (deferred past this plan)

- Interrupt layer (combat, dialogue, panic). Next plan.
- Inter-NPC live-mode collision avoidance.
- Weather / season-driven schedule variants.
- Persistent NPC memory (relationships, opinions).
- Procedural inn / overnight tourist behavior.
