#!/usr/bin/env node
/**
 * Export each animation tag from an .aseprite file to a separate PNG
 * spritesheet with transparent background. Tag frames are laid out in a
 * grid — default 3 columns, which matches the Hana Caraka premade
 * character layout (sideways / front / back facings across columns,
 * animation frames down rows).
 *
 * Usage:
 *   node tools/export-aseprite.mjs <input.aseprite> <outDir> [options]
 *
 * Options:
 *   --prefix NAME      Output filename prefix (default: input basename).
 *                      Files are written as "<prefix>-<tag>.png".
 *   --columns N        Sheet column count (default: 1). Hana Caraka files
 *                      bake the three facings into a single aseprite frame,
 *                      so 1 column stacks anim frames vertically — which is
 *                      what the enemy/npc schemas expect. Use 3+ for files
 *                      where each facing is a separate aseprite frame.
 *   --tags a,b,c       Export only these tag names (comma-separated).
 *                      Defaults to every tag in the file.
 *   --layer NAME       Export only this layer / layer group. Hana Caraka
 *                      files organise facings as groups named `up`, `down`,
 *                      `side` — pass `--layer side` to isolate one facing
 *                      (the enemy/npc systems only use the side view and
 *                      mirror it via flipX).
 *   --no-trim          Disable `--trim-sprite`. By default each tag is
 *                      trimmed to the tightest bounding box across all of
 *                      its frames, so in-engine `display.scale` doesn't
 *                      need to compensate for editor whitespace. Frame
 *                      dimensions stay uniform within a tag (but differ
 *                      between tags, which is fine — each tag ships as
 *                      its own sheet).
 *   --list             Print tags in the file and exit without exporting.
 *   --aseprite PATH    Explicit path to Aseprite.exe. Overrides discovery
 *                      and the ASEPRITE_EXE env var.
 *
 * Example:
 *   node tools/export-aseprite.mjs \
 *     "assets-source/character/16x16/Hana Caraka - Base Character/Premade Character/pirate/pirate.aseprite" \
 *     public/sprites/enemies \
 *     --prefix pirate
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import process from "node:process";
import sharp from "sharp";

const exec = promisify(execFile);

function parseArgs(argv) {
  const out = { input: null, outDir: null, prefix: null, columns: 1, list: false, aseprite: null, tags: null, trim: true, layer: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prefix") out.prefix = argv[++i];
    else if (a === "--columns") out.columns = Number(argv[++i]);
    else if (a === "--tags") out.tags = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--no-trim") out.trim = false;
    else if (a === "--trim") out.trim = true;
    else if (a === "--layer") out.layer = argv[++i];
    else if (a === "--list") out.list = true;
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
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Final fallback: hope it's on PATH.
  return "aseprite";
}

function slugify(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function listTags(ase, input) {
  // Aseprite's CLI is order-sensitive: `--list-tags` must come BEFORE the
  // input file, otherwise it silently outputs nothing.
  const { stdout } = await exec(ase, ["-b", "--list-tags", input]);
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function exportTag(ase, input, tag, outPath, columns, layer) {
  const dataPath = outPath.replace(/\.png$/, ".aseprite-tmp.json");
  const args = [
    "-b",
    "--tag",
    tag,
    "--format",
    "png",
    // Hana Caraka files include a checkerboard "bg helper" layer used as a
    // visual transparency indicator in the editor. It ships as opaque pixels,
    // so exporting it bakes the checkerboard into the output. Exclude it.
    "--ignore-layer",
    "bg helper",
  ];
  // Restricting to a single layer/group renders only that group (other
  // groups export as transparent, which the trim pass then crops away).
  if (layer) args.push("--layer", layer);
  args.push(
    "--sheet-columns",
    String(columns),
    "--sheet",
    outPath,
    "--data",
    dataPath,
    input,
  );
  await exec(ase, args);
  // Parse the companion JSON to learn exact frame rects in the sheet.
  const meta = JSON.parse(readFileSync(dataPath, "utf8"));
  unlinkSync(dataPath);
  const frames = Object.values(meta.frames).map((f) => f.frame);
  return frames; // [{ x, y, w, h }, ...]
}

/** Compute the union local bounding box of non-transparent pixels across
 *  every frame rect in the sheet. Returns `{ minX, minY, maxX, maxY }` in
 *  frame-local coords, or null if all frames are entirely transparent. */
async function computeFrameBbox(sheetPath, frames) {
  const { data, info } = await sharp(sheetPath)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, channels } = info;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (const f of frames) {
    for (let y = 0; y < f.h; y++) {
      const rowStart = ((f.y + y) * width + f.x) * channels + 3;
      for (let x = 0; x < f.w; x++) {
        if (data[rowStart + x * channels] > 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

/** Crop every frame rect to `bbox` (frame-local coords) and repack into a
 *  new sheet that preserves the original grid layout. Overwrites the file. */
async function cropSheet(sheetPath, frames, bbox) {
  const { data, info } = await sharp(sheetPath)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, channels } = info;
  const newFw = bbox.maxX - bbox.minX + 1;
  const newFh = bbox.maxY - bbox.minY + 1;
  // Frames are laid out in a regular grid; derive cols/rows from the rects.
  const cols = new Set(frames.map((f) => f.x)).size;
  const rows = new Set(frames.map((f) => f.y)).size;
  const outW = newFw * cols;
  const outH = newFh * rows;
  const out = Buffer.alloc(outW * outH * channels);
  // Map each original frame to its grid slot by sorted-unique x/y values.
  const xs = [...new Set(frames.map((f) => f.x))].sort((a, b) => a - b);
  const ys = [...new Set(frames.map((f) => f.y))].sort((a, b) => a - b);
  for (const f of frames) {
    const col = xs.indexOf(f.x);
    const row = ys.indexOf(f.y);
    const srcOx = f.x + bbox.minX;
    const srcOy = f.y + bbox.minY;
    const dstOx = col * newFw;
    const dstOy = row * newFh;
    for (let y = 0; y < newFh; y++) {
      const srcStart = ((srcOy + y) * width + srcOx) * channels;
      const dstStart = ((dstOy + y) * outW + dstOx) * channels;
      data.copy(out, dstStart, srcStart, srcStart + newFw * channels);
    }
  }
  await sharp(out, { raw: { width: outW, height: outH, channels } })
    .png()
    .toFile(sheetPath);
  return { newFw, newFh };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    console.log(
      "Usage: node tools/export-aseprite.mjs <input.aseprite> <outDir> [--prefix NAME] [--columns N] [--list]",
    );
    process.exit(args.help ? 0 : 1);
  }
  const input = resolve(args.input);
  if (!existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(1);
  }
  const ase = findAseprite(args.aseprite);
  const prefix = args.prefix ?? basename(input, extname(input));

  const tags = await listTags(ase, input);
  if (tags.length === 0) {
    console.error("No animation tags found in the file.");
    process.exit(1);
  }
  if (args.list) {
    console.log(`Tags in ${basename(input)}:`);
    for (const t of tags) console.log(`  - ${t}`);
    return;
  }

  if (!args.outDir) {
    console.error("outDir is required.");
    process.exit(1);
  }
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });

  const wanted = args.tags
    ? tags.filter((t) => args.tags.some((w) => w.toLowerCase() === t.toLowerCase()))
    : tags;
  if (args.tags && wanted.length !== args.tags.length) {
    const missing = args.tags.filter(
      (w) => !tags.some((t) => t.toLowerCase() === w.toLowerCase()),
    );
    console.warn(`  (no such tag: ${missing.join(", ")})`);
  }

  const exports = [];
  for (const tag of wanted) {
    const outName = `${prefix}-${slugify(tag)}.png`;
    const outPath = join(outDir, outName);
    const frames = await exportTag(ase, input, tag, outPath, args.columns, args.layer);
    exports.push({ tag, outName, outPath, frames });
    console.log(`  ${tag.padEnd(14)} -> ${outName}`);
  }

  if (args.trim && exports.length > 0) {
    // Compute one bbox across every frame of every exported tag, so that
    // after cropping the character's feet sit at the same relative position
    // in every animation (no per-anim jitter).
    let union = null;
    for (const e of exports) {
      const bbox = await computeFrameBbox(e.outPath, e.frames);
      if (!bbox) continue;
      if (!union) {
        union = { ...bbox };
      } else {
        if (bbox.minX < union.minX) union.minX = bbox.minX;
        if (bbox.minY < union.minY) union.minY = bbox.minY;
        if (bbox.maxX > union.maxX) union.maxX = bbox.maxX;
        if (bbox.maxY > union.maxY) union.maxY = bbox.maxY;
      }
    }
    if (union) {
      for (const e of exports) await cropSheet(e.outPath, e.frames, union);
      const newFw = union.maxX - union.minX + 1;
      const newFh = union.maxY - union.minY + 1;
      console.log(`Trimmed frames to ${newFw}x${newFh} (union bbox across all tags).`);
    }
  }

  console.log(`Done. ${wanted.length} sheet(s) written to ${outDir}`);
}

main().catch((err) => {
  console.error(err?.stderr?.toString() ?? err.message ?? err);
  process.exit(1);
});
