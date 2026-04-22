#!/usr/bin/env node
/**
 * Deduplicate body-layer shapes in a Hana Caraka-style master .aseprite.
 *
 * Walks every frame of the target body layers (default `up/body`, `down/body`,
 * `side/body`), tight-crops each cel's non-transparent pixels, and groups by
 * identical pixel grid regardless of canvas position. Writes:
 *
 *   <outDir>/body-shapes-template.aseprite
 *     One frame per unique shape. Each shape sits at (0, 0) of its frame so
 *     a replacement variant ("blueshirt", "armor", etc.) can be painted in
 *     place and re-anchored at the JSON's absolute (x, y) during regen.
 *
 *   <outDir>/body-shapes-map.json
 *     { frames: { <facing>: [ { frame, shapeId, x, y } ] }, shapes: [...] }
 *
 * Usage:
 *   node tools/dedupe-body-shapes.mjs <input.aseprite> <outDir> [options]
 *
 * Options:
 *   --layers a,b,c    Layer paths. Default: up/body,down/body,side/body
 *   --palette PATH    Apply this palette file to the template (.aseprite
 *                     or any format Aseprite can open). Defaults to the
 *                     Hana Caraka "Color palette/color palette.aseprite"
 *                     sibling of the input, if present.
 *   --aseprite PATH   Explicit Aseprite.exe (also reads ASEPRITE_EXE).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const exec = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LUA = join(SCRIPT_DIR, "aseprite-dedupe-body-shapes.lua");

function parseArgs(argv) {
  const out = { input: null, outDir: null, layers: null, palette: null, aseprite: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--layers") out.layers = argv[++i];
    else if (a === "--palette") out.palette = argv[++i];
    else if (a === "--aseprite") out.aseprite = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else rest.push(a);
  }
  out.input = rest[0] ?? null;
  out.outDir = rest[1] ?? null;
  return out;
}

function findAseprite(explicit) {
  const candidates = [
    explicit,
    process.env.ASEPRITE_EXE,
    "C:/Program Files/Aseprite/Aseprite.exe",
    "C:/Program Files (x86)/Aseprite/Aseprite.exe",
    "C:/Program Files (x86)/Steam/steamapps/common/Aseprite/Aseprite.exe",
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Programs/Aseprite/Aseprite.exe")
      : null,
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return "aseprite";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input || !args.outDir) {
    console.log(
      "Usage: node tools/dedupe-body-shapes.mjs <input.aseprite> <outDir> [--layers a,b,c] [--aseprite PATH]",
    );
    process.exit(args.help ? 0 : 1);
  }
  const input = resolve(args.input);
  if (!existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(1);
  }
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });

  const ase = findAseprite(args.aseprite);
  // Auto-detect the Hana Caraka palette sibling if --palette wasn't given.
  let palette = args.palette;
  if (!palette) {
    const guess = join(
      dirname(input),
      "Color palette",
      "color palette.aseprite",
    );
    if (existsSync(guess)) palette = guess;
  }
  const aseArgs = ["-b", input, "--script-param", `out=${outDir}`];
  if (args.layers) aseArgs.push("--script-param", `layers=${args.layers}`);
  if (palette) aseArgs.push("--script-param", `palette=${palette}`);
  aseArgs.push("--script", LUA);

  const { stdout, stderr } = await exec(ase, aseArgs);
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stdout.write(stdout);
}

main().catch((err) => {
  console.error(err?.stderr?.toString() ?? err.message ?? err);
  process.exit(1);
});
