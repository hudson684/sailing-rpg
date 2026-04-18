# Project notes for Claude

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
