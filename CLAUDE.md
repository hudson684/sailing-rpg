# Project notes for Claude

## Always start from fresh main

Before planning or coding on any branch, run `git fetch origin` and
check how the current branch compares to `origin/main`. If the branch
is behind `origin/main`, rebase onto it before doing anything else.
Do NOT propose plans, read code for architectural decisions, or start
implementing against a stale base — the codebase changes fast and old
assumptions become wrong quickly.

The SessionStart hook in `.claude/settings.json` prints this comparison
automatically at the start of every session. Read its output.

## Don't start dev servers

Never run `npm run dev` / `vite` / Playwright / any other server-starting
command to "test" changes. The user runs the dev server themselves and
will report what they see.

Verify changes with:

- `npx tsc --noEmit` for typechecking
- `npx vite build` for build sanity
- Reading the relevant code

If a change really needs a live browser to validate, ask the user to
reload their dev server and tell you what they see — don't spin one up.

## NPC system

Before touching anything that creates, ticks, or drives NPCs — the
global registry, activities, the customer/staff borrowed-body paths,
`NpcProxy` / `WorldTicker` / `agentBinding`, schedules, or save/load
of NPC state — read **`docs/npc-system.md`**. It covers the mental
model, body-ownership rules, day plans, the spawn pipeline, save/load
ordering, and the transitional warts that survived Phase 9.

`plan/global-npc-state/decisions.md` is the implementation log for the
nine phases that built the system; reach for it when "why is it like
this?" doesn't have an obvious answer in the code.

Quick index:

- Authoring a new activity: `src/game/sim/README.md`
- Authoring archetypes / schedules / spawn groups:
  `src/game/sim/data/README.md`

## Building exteriors

Buildings on the world map can swap visuals based on state (rundown
vs. repaired vs. upgraded) and toggle small cosmetic overlays (a new
sign, fresh paint) on top. Before authoring building art in Tiled or
adding registry entries for overlays, read **`docs/building-exteriors.md`**.
It covers the layer naming convention (`building@id:<bid>:state:<sid>`),
the overlay object layer contract, the `(building, slot)` registry,
and the runtime resolution rules.

## Prefer Phaser 4 solutions

This project is built on Phaser 4. Always consider a Phaser 4 native
solution first — its scenes, cameras, input, physics, tweens, timers,
events, GameObjects, and plugin system — before reaching for custom
code, external libraries, or patterns ported from Phaser 3 or other
engines. Lean into how Phaser 4 works and use its idioms.

If a proposed plan or user request clashes with the Phaser 4 way of
doing things (e.g. bypassing the scene lifecycle, reimplementing
something the framework already provides, or relying on Phaser 3
behavior that changed in 4), raise it with the user before
implementing. Explain the clash and suggest the Phaser 4 alternative,
then let the user decide.

## Exporting .aseprite sprites

Use `tools/export-aseprite.mjs` to turn `.aseprite` files into per-tag
PNG spritesheets with transparent backgrounds. It shells out to the
Aseprite CLI (auto-discovered, or override via `ASEPRITE_EXE` /
`--aseprite`). Don't hand-export from the Aseprite GUI and don't try
to parse `.aseprite` binary directly.

Typical usage (Hana Caraka pirate, for example):

```
node tools/export-aseprite.mjs \
  "assets-source/character/16x16/Hana Caraka - Base Character/Premade Character/pirate/pirate.aseprite" \
  public/sprites/enemies \
  --prefix pirate \
  --tags idle,walk,sword,hurt,death \
  --layer side
```

Notes:

- `--layer side` isolates the sideways facing. Hana Caraka files group
  facings as `up` / `down` / `side` layer groups; the enemy and NPC
  systems only use the side view (and mirror it via `setFlipX` for
  left/right), so exporting just that group keeps sheets tight.
- The default post-process computes one bounding box across every
  frame of every exported tag and crops all sheets to match. That
  drops editor whitespace and keeps the character's feet pinned to
  the same relative position in every animation. Pass `--no-trim`
  to skip.
- Default `--columns 1` matches Hana Caraka files, where each aseprite
  frame is a single composite. Bump `--columns` for files where each
  facing or variant is a separate aseprite frame.
- The script passes `--ignore-layer "bg helper"` so the editor-only
  checkerboard layer doesn't get baked into the output. If a new
  character kit uses a different helper layer name, extend the script.
- Use `--list` to print tags in a file before exporting.

After export, set `frameWidth` / `frameHeight` / `sheetCols` in the
matching def (e.g. `src/game/data/enemies.json`) to match the new
trimmed dimensions the script prints at the end. Characters are
always rendered at 1× — there is no `display.scale`, so the source
sheet must already be the size you want in-world.
