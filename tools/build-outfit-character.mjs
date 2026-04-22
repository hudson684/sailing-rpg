#!/usr/bin/env node
/**
 * Build a full premade-character .aseprite by starting from the master file
 * and swapping each facing's body-layer cels with the pixels from a
 * repainted body+head template (via the body-head-shapes map). Output can
 * then be fed directly into tools/export-aseprite.mjs like any other
 * premade character (pirate, blacksmith, etc.).
 *
 * Usage:
 *   node tools/build-outfit-character.mjs \
 *     <master.aseprite> <outfit.aseprite> <map.json> <out.aseprite>
 *     [--part body|head|...] [--facings up,down,side] [--aseprite PATH]
 *
 * --part selects which leaf layer in the master gets its cels swapped.
 * The outfit .aseprite must have "<facing>-<part>" layers. Defaults to
 * "body". Use "head" to layer hair/headgear onto a character built
 * from a head-only template.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const exec = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LUA = join(SCRIPT_DIR, "aseprite-build-outfit-character.lua");

function parseArgs(argv) {
  const out = { master: null, outfit: null, mapPath: null, outPath: null, facings: "up,down,side", part: "body", aseprite: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--facings") out.facings = argv[++i];
    else if (a === "--part") out.part = argv[++i];
    else if (a === "--aseprite") out.aseprite = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else rest.push(a);
  }
  out.master = rest[0] ?? null;
  out.outfit = rest[1] ?? null;
  out.mapPath = rest[2] ?? null;
  out.outPath = rest[3] ?? null;
  return out;
}

function findAseprite(explicit) {
  const candidates = [
    explicit, process.env.ASEPRITE_EXE,
    "C:/Program Files/Aseprite/Aseprite.exe",
    "C:/Program Files (x86)/Aseprite/Aseprite.exe",
    "C:/Program Files (x86)/Steam/steamapps/common/Aseprite/Aseprite.exe",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs/Aseprite/Aseprite.exe") : null,
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return "aseprite";
}

function toLua(v) {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "nil";
  if (typeof v === "string") return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  if (Array.isArray(v)) return "{" + v.map(toLua).join(",") + "}";
  if (typeof v === "object") {
    return "{" + Object.entries(v).map(([k, val]) => `[${toLua(k)}]=${toLua(val)}`).join(",") + "}";
  }
  return "nil";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.master || !args.outfit || !args.mapPath || !args.outPath) {
    console.log("Usage: node tools/build-outfit-character.mjs <master.aseprite> <outfit.aseprite> <map.json> <out.aseprite> [--facings a,b,c]");
    process.exit(args.help ? 0 : 1);
  }
  const master = resolve(args.master);
  const outfit = resolve(args.outfit);
  const mapPath = resolve(args.mapPath);
  const outPath = resolve(args.outPath);
  for (const [label, p] of [["master", master], ["outfit", outfit], ["map", mapPath]]) {
    if (!existsSync(p)) { console.error(`${label} not found: ${p}`); process.exit(1); }
  }
  mkdirSync(dirname(outPath), { recursive: true });

  const mapJson = JSON.parse(readFileSync(mapPath, "utf8"));
  const tempDir = join(dirname(outPath), "_tmp_outfit");
  mkdirSync(tempDir, { recursive: true });
  const mapLuaPath = join(tempDir, "map.lua");
  writeFileSync(mapLuaPath, "return " + toLua(mapJson));

  const ase = findAseprite(args.aseprite);
  const { stdout, stderr } = await exec(ase, [
    "-b", master,
    "--script-param", `out=${outPath}`,
    "--script-param", `outfit=${outfit}`,
    "--script-param", `mapLua=${mapLuaPath}`,
    "--script-param", `facings=${args.facings}`,
    "--script-param", `bodySuffix=${args.part}`,
    "--script", LUA,
  ]);
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stdout.write(stdout);

  rmSync(tempDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err?.stderr?.toString() ?? err.message ?? err);
  process.exit(1);
});
