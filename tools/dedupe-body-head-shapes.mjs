#!/usr/bin/env node
/**
 * Deduplicate body+head composites across a Hana Caraka master .aseprite.
 * Sister tool to dedupe-body-shapes.mjs, but combines each frame's body and
 * head cels into a single image before hashing — the template's frames are
 * full body+head "outfits" rather than single parts.
 *
 * Writes:
 *   <outDir>/body-head-shapes-template.aseprite
 *     One frame per unique (body+head) composite, centered in a 32x32
 *     canvas (or --frame-size WxH). Three layers, one per facing.
 *   <outDir>/body-head-shapes-map.json
 *     { frames: { <facing>: [ { frame, shapeId, x, y } ] }, shapes: [...] }
 *     (x, y) = absolute canvas position of the template frame's top-left
 *     during reconstruction.
 *
 * Usage:
 *   node tools/dedupe-body-head-shapes.mjs <input.aseprite> <outDir> [options]
 *
 * Options:
 *   --facings a,b,c    Facing group names. Default: up,down,side
 *   --parts a,b        Leaf layer names to composite. Default: body,head
 *   --frame-size WxH   Template frame size. Default: 32x32
 *   --palette PATH     Palette to apply. Defaults to the Hana Caraka
 *                      "Color palette/color palette.aseprite" sibling.
 *   --aseprite PATH    Explicit Aseprite.exe (also reads ASEPRITE_EXE).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const exec = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LUA = join(SCRIPT_DIR, "aseprite-dedupe-body-head.lua");

function parseArgs(argv) {
  const out = {
    input: null,
    outDir: null,
    facings: null,
    parts: null,
    extraParts: null,
    frameSize: null,
    palette: null,
    templateName: null,
    jsonName: null,
    aseprite: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--facings") out.facings = argv[++i];
    else if (a === "--parts") out.parts = argv[++i];
    else if (a === "--extra-parts") out.extraParts = argv[++i];
    else if (a === "--frame-size") out.frameSize = argv[++i];
    else if (a === "--palette") out.palette = argv[++i];
    else if (a === "--template-name") out.templateName = argv[++i];
    else if (a === "--json-name") out.jsonName = argv[++i];
    else if (a === "--aseprite") out.aseprite = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else rest.push(a);
  }
  out.input = rest[0] ?? null;
  out.outDir = rest[1] ?? null;
  // Derive friendlier defaults from --parts (e.g. head-shapes-*.aseprite
  // instead of body-head-shapes-*.aseprite when deduping heads alone).
  if (!out.templateName || !out.jsonName) {
    const slug = out.parts ? out.parts.split(",").map((s) => s.trim()).filter(Boolean).join("-") : null;
    if (slug) {
      if (!out.templateName) out.templateName = `${slug}-shapes-template.aseprite`;
      if (!out.jsonName) out.jsonName = `${slug}-shapes-map.json`;
    }
  }
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
      "Usage: node tools/dedupe-body-head-shapes.mjs <input.aseprite> <outDir>\n" +
        "  [--facings a,b,c] [--parts a,b] [--frame-size WxH] [--palette PATH]",
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
  let palette = args.palette;
  if (!palette) {
    const guess = join(dirname(input), "Color palette", "color palette.aseprite");
    if (existsSync(guess)) palette = guess;
  }
  const aseArgs = ["-b", input, "--script-param", `out=${outDir}`];
  if (args.facings) aseArgs.push("--script-param", `facings=${args.facings}`);
  if (args.parts) aseArgs.push("--script-param", `parts=${args.parts}`);
  if (args.extraParts) aseArgs.push("--script-param", `extraParts=${args.extraParts}`);
  if (args.templateName) aseArgs.push("--script-param", `templateName=${args.templateName}`);
  if (args.jsonName) aseArgs.push("--script-param", `jsonName=${args.jsonName}`);
  if (args.frameSize) aseArgs.push("--script-param", `frameSize=${args.frameSize}`);
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
