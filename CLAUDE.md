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
