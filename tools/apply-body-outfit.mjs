#!/usr/bin/env node
/**
 * Regenerate per-facing, per-tag body sprite sheets from a repainted
 * body-head template. Combines:
 *   - the master .aseprite (for canvas size, frame durations, tags)
 *   - the repainted template .aseprite (the new outfit's body pixels)
 *   - the body-head-shapes-map.json produced by dedupe-body-head-shapes
 *
 * Output (matching Master_File_Parts layout):
 *   <outDir>/<facing>-body-<variant>/<tag>.png
 *   <outDir>/manifest.json
 *
 * Frames within one facing are cropped to a shared bbox so the sheets stack
 * pixel-perfect (same convention as export-aseprite-parts.mjs).
 *
 * Usage:
 *   node tools/apply-body-outfit.mjs \
 *     <master.aseprite> <outfit.aseprite> <map.json> <outDir> [options]
 *
 * Options:
 *   --part NAME        Leaf layer name in the master ("body", "head", ...).
 *                      Default "body". The outfit template is expected to
 *                      have "<facing>-<part>" layers; output dirs become
 *                      "<facing>-<part>-<variant>".
 *   --variant NAME     Suffix for output dirs (default: derived from the
 *                      outfit filename, e.g. "default-outfit").
 *   --facings a,b,c    Default: up,down,side
 *   --concurrency N    Parallel Aseprite invocations (default 4).
 *   --aseprite PATH    Explicit Aseprite.exe.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import sharp from "sharp";

const exec = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LUA = join(SCRIPT_DIR, "aseprite-apply-body-outfit.lua");

function parseArgs(argv) {
  const out = {
    master: null,
    outfit: null,
    mapPath: null,
    outDir: null,
    variant: null,
    part: "body",
    facings: "up,down,side",
    concurrency: 4,
    aseprite: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--variant") out.variant = argv[++i];
    else if (a === "--part") out.part = argv[++i];
    else if (a === "--facings") out.facings = argv[++i];
    else if (a === "--concurrency") out.concurrency = Math.max(1, Number(argv[++i]));
    else if (a === "--aseprite") out.aseprite = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else rest.push(a);
  }
  out.master = rest[0] ?? null;
  out.outfit = rest[1] ?? null;
  out.mapPath = rest[2] ?? null;
  out.outDir = rest[3] ?? null;
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

function slugify(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Serialize a JS value as a Lua literal (enough for the shapes-map shape).
function toLua(v) {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "nil";
  if (typeof v === "string") return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  if (Array.isArray(v)) {
    return "{" + v.map(toLua).join(",") + "}";
  }
  if (typeof v === "object") {
    const parts = [];
    for (const [k, val] of Object.entries(v)) {
      parts.push(`[${toLua(k)}]=${toLua(val)}`);
    }
    return "{" + parts.join(",") + "}";
  }
  return "nil";
}

async function listTags(ase, aseFile) {
  const { stdout } = await exec(ase, ["-b", "--list-tags", aseFile]);
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function exportTag(ase, aseFile, tag, outPath) {
  const dataPath = outPath.replace(/\.png$/, ".tmp.json");
  await exec(ase, [
    "-b",
    "--tag",
    tag,
    "--format",
    "png",
    "--sheet-columns",
    "1",
    "--sheet",
    outPath,
    "--data",
    dataPath,
    aseFile,
  ]);
  const meta = JSON.parse(readFileSync(dataPath, "utf8"));
  unlinkSync(dataPath);
  const frames = Object.values(meta.frames).map((f) => f.frame);
  return frames;
}

async function readRaw(path) {
  return sharp(path).raw().toBuffer({ resolveWithObject: true });
}

function frameBboxFromRaw(raw, frames) {
  const { data, info } = raw;
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

async function cropSheetRaw(raw, outPath, frames, bbox) {
  const { data, info } = raw;
  const { width, channels } = info;
  const newFw = bbox.maxX - bbox.minX + 1;
  const newFh = bbox.maxY - bbox.minY + 1;
  const xs = [...new Set(frames.map((f) => f.x))].sort((a, b) => a - b);
  const ys = [...new Set(frames.map((f) => f.y))].sort((a, b) => a - b);
  const outW = newFw * xs.length;
  const outH = newFh * ys.length;
  const out = Buffer.alloc(outW * outH * channels);
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
    .toFile(outPath);
  return { w: newFw, h: newFh };
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        results[idx] = await worker(items[idx], idx);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.master || !args.outfit || !args.mapPath || !args.outDir) {
    console.log(
      "Usage: node tools/apply-body-outfit.mjs <master.aseprite> <outfit.aseprite> <map.json> <outDir> [options]",
    );
    process.exit(args.help ? 0 : 1);
  }
  const master = resolve(args.master);
  const outfit = resolve(args.outfit);
  const mapPath = resolve(args.mapPath);
  const outDir = resolve(args.outDir);
  for (const [label, p] of [["master", master], ["outfit", outfit], ["map", mapPath]]) {
    if (!existsSync(p)) {
      console.error(`${label} not found: ${p}`);
      process.exit(1);
    }
  }
  mkdirSync(outDir, { recursive: true });

  const variant = args.variant ?? (() => {
    const base = basename(outfit, extname(outfit));
    // "body-head-shapes-default-outfit" -> "default-outfit"
    //  "head-shapes-redhair"           -> "redhair"
    return base.replace(/^(?:body-head|body|head)-shapes-/, "") || "outfit";
  })();
  const variantSlug = slugify(variant);
  const facings = args.facings.split(",").map((s) => s.trim()).filter(Boolean);

  // Write the map as a Lua file next to the outfit for the Lua script.
  const mapJson = JSON.parse(readFileSync(mapPath, "utf8"));
  const tempDir = join(outDir, "_tmp");
  mkdirSync(tempDir, { recursive: true });
  const mapLuaPath = join(tempDir, "map.lua");
  writeFileSync(mapLuaPath, "return " + toLua(mapJson));

  const ase = findAseprite(args.aseprite);
  const part = args.part;

  // Stage 1: build intermediate <facing>-<part>.aseprite files.
  console.log(`Building intermediates for part "${part}", variant "${variant}"...`);
  const { stdout: luaOut, stderr: luaErr } = await exec(ase, [
    "-b",
    master,
    "--script-param", `out=${tempDir}`,
    "--script-param", `outfit=${outfit}`,
    "--script-param", `mapLua=${mapLuaPath}`,
    "--script-param", `facings=${facings.join(",")}`,
    "--script-param", `bodySuffix=${part}`,
    "--script", LUA,
  ]);
  if (luaErr) process.stderr.write(luaErr);
  if (luaOut) process.stdout.write(luaOut);

  // Stage 2: for each facing × tag, export a sheet.
  const jobs = [];
  for (const facing of facings) {
    const facingAse = join(tempDir, `${facing}-${part}.aseprite`);
    if (!existsSync(facingAse)) {
      console.warn(`  skipping ${facing}: intermediate not written`);
      continue;
    }
    const tags = await listTags(ase, facingAse);
    for (const tag of tags) {
      jobs.push({ facing, tag, facingAse });
    }
  }
  if (jobs.length === 0) {
    console.error("No tags found in intermediates. Nothing to export.");
    process.exit(1);
  }

  console.log(`Exporting ${jobs.length} sheets...`);
  const t0 = Date.now();
  let done = 0;
  const exported = await runPool(jobs, args.concurrency, async (job) => {
    const dirSlug = `${job.facing}-${part}-${variantSlug}`;
    const jobDir = join(outDir, dirSlug);
    mkdirSync(jobDir, { recursive: true });
    const outPath = join(jobDir, `${slugify(job.tag)}.png`);
    const frames = await exportTag(ase, job.facingAse, job.tag, outPath);
    done++;
    if (done % 25 === 0 || done === jobs.length) {
      console.log(`  [${done}/${jobs.length}] exported`);
    }
    return { ...job, dirSlug, outPath, frames };
  });
  console.log(`  aseprite stage: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Stage 3: per-facing shared bbox crop. Empty sheets get deleted.
  const byFacing = new Map();
  const emptySheets = [];
  const rawCache = new Map();
  for (const e of exported) {
    const raw = await readRaw(e.outPath);
    rawCache.set(e.outPath, raw);
    const bbox = frameBboxFromRaw(raw, e.frames);
    if (!bbox) {
      emptySheets.push(e);
      continue;
    }
    if (!byFacing.has(e.facing)) byFacing.set(e.facing, { bbox: { ...bbox }, items: [] });
    const bucket = byFacing.get(e.facing);
    bucket.items.push(e);
    if (bbox.minX < bucket.bbox.minX) bucket.bbox.minX = bbox.minX;
    if (bbox.minY < bucket.bbox.minY) bucket.bbox.minY = bbox.minY;
    if (bbox.maxX > bucket.bbox.maxX) bucket.bbox.maxX = bbox.maxX;
    if (bbox.maxY > bucket.bbox.maxY) bucket.bbox.maxY = bbox.maxY;
  }
  const facingDims = {};
  for (const [facing, bucket] of byFacing) {
    let dims = { w: 0, h: 0 };
    for (const e of bucket.items) {
      const raw = rawCache.get(e.outPath);
      dims = await cropSheetRaw(raw, e.outPath, e.frames, bucket.bbox);
    }
    facingDims[facing] = dims;
    console.log(`  ${facing} cropped to ${dims.w}x${dims.h} (${bucket.items.length} sheets)`);
  }
  for (const e of emptySheets) {
    if (existsSync(e.outPath)) unlinkSync(e.outPath);
  }
  // Remove any dir that ended up empty.
  const dirs = new Set(exported.map((e) => e.dirSlug));
  for (const d of dirs) {
    const full = join(outDir, d);
    try {
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true });
    } catch {}
  }

  // Stage 4: manifest + cleanup.
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    master: basename(master),
    outfit: basename(outfit),
    variant: variantSlug,
    facings: {},
    emptySheets: emptySheets.map((e) => ({ dir: e.dirSlug, tag: e.tag })),
  };
  for (const [facing, bucket] of byFacing) {
    manifest.facings[facing] = {
      bbox: facingDims[facing],
      sheets: bucket.items.map((e) => ({
        dir: e.dirSlug,
        tag: e.tag,
        frames: e.frames.length,
      })),
    };
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  rmSync(tempDir, { recursive: true, force: true });

  console.log(
    `Done. ${exported.length - emptySheets.length} PNG(s), ${emptySheets.length} empty skipped. Output: ${outDir}`,
  );
}

main().catch((err) => {
  console.error(err?.stderr?.toString() ?? err.message ?? err);
  process.exit(1);
});
