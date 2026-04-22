#!/usr/bin/env node
/**
 * Exhaustive per-layer × per-tag export from an .aseprite file. Walks the
 * sprite's layer tree (via a Lua sidecar — `--list-layers` flattens groups)
 * and writes one PNG sheet per (facing, part, tag) plus one composite sheet
 * per (facing, tag). Intended for pulling body parts out of the Hana Caraka
 * master file so they can be inspected or re-composited downstream.
 *
 * Output layout (under <outDir>):
 *   <facing>/<tag>.png           full facing composite
 *   <facing>-<part>/<tag>.png    single part within that facing
 *   <part>/<tag>.png             top-level leaf layer (no facing group)
 *   manifest.json                export record (input hash, bboxes, empties)
 *
 * Frames within one facing are trimmed to a *shared* bbox across every part
 * and tag in that facing, so parts re-composite pixel-perfect in engine.
 *
 * Options:
 *   --exclude-layer NAME   Skip this layer (repeatable). Default: "bg helper".
 *   --tags a,b,c           Only export these tags. Default: all tags.
 *   --columns N            Sheet columns (default 1 — stacks frames vertically).
 *   --concurrency N        Parallel Aseprite invocations (default 4).
 *   --force                Ignore the incremental cache and re-export.
 *   --dry-run              Print planned jobs and exit.
 *   --aseprite PATH        Explicit Aseprite.exe. Also reads ASEPRITE_EXE.
 *
 * Example:
 *   node tools/export-aseprite-parts.mjs \
 *     "assets-source/character/16x16/Hana Caraka - Base Character/Master File Pale Skin.aseprite" \
 *     "assets-source/character/16x16/Hana Caraka - Base Character/Master_File_Parts"
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import sharp from "sharp";

const exec = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LUA_TREE = join(SCRIPT_DIR, "aseprite-list-tree.lua");
const MANIFEST_VERSION = 1;

function parseArgs(argv) {
  const out = {
    input: null,
    outDir: null,
    exclude: ["bg helper"],
    tags: null,
    columns: 1,
    concurrency: 4,
    force: false,
    dryRun: false,
    aseprite: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--exclude-layer") out.exclude.push(argv[++i]);
    else if (a === "--tags")
      out.tags = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--columns") out.columns = Number(argv[++i]);
    else if (a === "--concurrency") out.concurrency = Math.max(1, Number(argv[++i]));
    else if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
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

function slugify(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function listTags(ase, input) {
  const { stdout } = await exec(ase, ["-b", "--list-tags", input]);
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function dumpLayerTree(ase, input) {
  const tmp = join(
    process.env.TEMP || process.env.TMPDIR || "/tmp",
    `ase-tree-${process.pid}-${Date.now()}.json`,
  );
  try {
    await exec(ase, [
      "-b",
      input,
      "--script-param",
      `out=${tmp}`,
      "--script",
      LUA_TREE,
    ]);
    return JSON.parse(readFileSync(tmp, "utf8"));
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/**
 * Flatten the layer tree into export jobs:
 *   - each top-level group becomes a "facing" with a composite job plus one
 *     per leaf child
 *   - each top-level leaf becomes its own standalone job (no facing)
 * Excluded names (case-insensitive) are dropped at any depth.
 */
function planJobs(tree, excludeSet, tagsWanted) {
  const isExcluded = (name) => excludeSet.has(name.toLowerCase());
  const facings = []; // { name, slug, composite: [paths], parts: [{ name, path }] }
  const standalones = []; // { name, path }

  for (const node of tree) {
    if (isExcluded(node.name)) continue;
    if (node.isGroup) {
      const leaves = [];
      const seen = new Set();
      const collect = (n) => {
        if (isExcluded(n.name)) return;
        if (n.isGroup) {
          for (const c of n.children) collect(c);
        } else if (!seen.has(n.path)) {
          seen.add(n.path);
          leaves.push({ name: n.name, path: n.path });
        }
      };
      for (const c of node.children) collect(c);
      if (leaves.length === 0) continue;
      facings.push({
        name: node.name,
        slug: slugify(node.name),
        groupPath: node.path,
        leaves,
      });
    } else {
      standalones.push({ name: node.name, path: node.path });
    }
  }

  const jobs = [];
  for (const facing of facings) {
    // Facing composite: output dir = <slug>/
    jobs.push({
      kind: "composite",
      facing: facing.slug,
      dirSlug: facing.slug,
      layers: [facing.groupPath, ...facing.leaves.map((l) => l.path)],
    });
    for (const leaf of facing.leaves) {
      jobs.push({
        kind: "part",
        facing: facing.slug,
        part: slugify(leaf.name),
        dirSlug: `${facing.slug}-${slugify(leaf.name)}`,
        layers: [facing.groupPath, leaf.path],
      });
    }
  }
  for (const s of standalones) {
    jobs.push({
      kind: "standalone",
      facing: "",
      dirSlug: slugify(s.name),
      layers: [s.path],
    });
  }

  // Cross-product with tags.
  const withTags = [];
  for (const job of jobs) {
    for (const tag of tagsWanted) {
      withTags.push({ ...job, tag, tagSlug: slugify(tag) });
    }
  }
  return { facings, standalones, jobs: withTags };
}

async function runJob(ase, input, outDir, job, columns) {
  const jobDir = join(outDir, job.dirSlug);
  mkdirSync(jobDir, { recursive: true });
  const outPath = join(jobDir, `${job.tagSlug}.png`);
  const dataPath = outPath.replace(/\.png$/, ".aseprite-tmp.json");
  const args = ["-b"];
  for (const layer of job.layers) args.push("--layer", layer);
  args.push(
    "--tag",
    job.tag,
    "--format",
    "png",
    "--sheet-columns",
    String(columns),
    "--sheet",
    outPath,
    "--data",
    dataPath,
    input,
  );
  await exec(ase, args);
  const meta = JSON.parse(readFileSync(dataPath, "utf8"));
  unlinkSync(dataPath);
  const frames = Object.values(meta.frames).map((f) => f.frame);
  return { ...job, outPath, frames };
}

/** Read sheet once, return raw buffer + info (sharp objects are not reusable). */
async function readRaw(path) {
  return sharp(path).raw().toBuffer({ resolveWithObject: true });
}

function frameBboxFromRaw(raw, frames) {
  const { data, info } = raw;
  const { width, channels } = info;
  let minX = Infinity,
    minY = Infinity,
    maxX = -1,
    maxY = -1;
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

/** Simple N-worker pool over a job list. */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

function inputFingerprint(inputPath) {
  const st = statSync(inputPath);
  return { mtimeMs: Math.floor(st.mtimeMs), size: st.size };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input || !args.outDir) {
    console.log(
      "Usage: node tools/export-aseprite-parts.mjs <input.aseprite> <outDir>\n" +
        "  [--exclude-layer NAME] [--tags a,b,c] [--columns N]\n" +
        "  [--concurrency N] [--force] [--dry-run] [--aseprite PATH]",
    );
    process.exit(args.help ? 0 : 1);
  }
  const input = resolve(args.input);
  if (!existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(1);
  }
  const outDir = resolve(args.outDir);
  const ase = findAseprite(args.aseprite);
  const excludeSet = new Set(args.exclude.map((s) => s.toLowerCase()));

  // Incremental check: input fingerprint + tool args must match prior run.
  const fingerprint = inputFingerprint(input);
  const manifestPath = join(outDir, "manifest.json");
  const cacheKey = {
    version: MANIFEST_VERSION,
    fingerprint,
    exclude: [...excludeSet].sort(),
    tags: args.tags ? [...args.tags].sort() : null,
    columns: args.columns,
  };
  if (!args.force && existsSync(manifestPath)) {
    try {
      const prev = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (JSON.stringify(prev.cacheKey) === JSON.stringify(cacheKey)) {
        console.log("Up to date (manifest matches). Use --force to re-export.");
        return;
      }
    } catch {
      // stale/corrupt manifest → fall through and re-export
    }
  }

  const [tree, allTags] = await Promise.all([
    dumpLayerTree(ase, input),
    listTags(ase, input),
  ]);
  if (allTags.length === 0) {
    console.error("No animation tags found.");
    process.exit(1);
  }
  const tagsWanted = args.tags
    ? allTags.filter((t) => args.tags.some((w) => w.toLowerCase() === t.toLowerCase()))
    : allTags;
  if (args.tags && tagsWanted.length !== args.tags.length) {
    const missing = args.tags.filter(
      (w) => !allTags.some((t) => t.toLowerCase() === w.toLowerCase()),
    );
    console.warn(`  (no such tag: ${missing.join(", ")})`);
  }

  const plan = planJobs(tree, excludeSet, tagsWanted);
  if (plan.jobs.length === 0) {
    console.error("Nothing to export.");
    process.exit(1);
  }

  console.log(
    `${basename(input)}: ${plan.facings.length} facing(s), ${plan.standalones.length} standalone layer(s), ${tagsWanted.length} tag(s) — ${plan.jobs.length} sheets`,
  );
  if (args.dryRun) {
    for (const j of plan.jobs) {
      console.log(`  ${j.dirSlug}/${j.tagSlug}.png  [${j.layers.join(" | ")}]`);
    }
    return;
  }

  // Fresh outDir wipe is risky; we only clear the manifest to avoid false
  // "up to date" hits if this run crashes mid-way.
  mkdirSync(outDir, { recursive: true });
  if (existsSync(manifestPath)) unlinkSync(manifestPath);

  // Stage 1: run all Aseprite exports in parallel.
  const t0 = Date.now();
  let done = 0;
  const exported = await runPool(plan.jobs, args.concurrency, async (job) => {
    const res = await runJob(ase, input, outDir, job, args.columns);
    done++;
    if (done % 25 === 0 || done === plan.jobs.length) {
      console.log(`  [${done}/${plan.jobs.length}] exported`);
    }
    return res;
  });
  console.log(`  aseprite stage: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Stage 2: per-facing shared bbox. Group every non-empty sheet by facing
  // slug (empty-facing bucket for standalones), union their bboxes, then
  // crop every sheet in that group to the shared rect.
  const byFacing = new Map();
  const emptySheets = [];
  const rawCache = new Map(); // outPath -> raw buffer/info
  for (const e of exported) {
    const raw = await readRaw(e.outPath);
    rawCache.set(e.outPath, raw);
    const bbox = frameBboxFromRaw(raw, e.frames);
    if (!bbox) {
      emptySheets.push(e);
      continue;
    }
    const key = e.facing;
    if (!byFacing.has(key)) byFacing.set(key, { bbox: { ...bbox }, items: [] });
    const bucket = byFacing.get(key);
    bucket.items.push(e);
    if (bbox.minX < bucket.bbox.minX) bucket.bbox.minX = bbox.minX;
    if (bbox.minY < bucket.bbox.minY) bucket.bbox.minY = bbox.minY;
    if (bbox.maxX > bucket.bbox.maxX) bucket.bbox.maxX = bbox.maxX;
    if (bbox.maxY > bucket.bbox.maxY) bucket.bbox.maxY = bbox.maxY;
  }

  const facingDims = {};
  for (const [facing, bucket] of byFacing) {
    const dims = { w: 0, h: 0 };
    for (const e of bucket.items) {
      const raw = rawCache.get(e.outPath);
      const d = await cropSheetRaw(raw, e.outPath, e.frames, bucket.bbox);
      dims.w = d.w;
      dims.h = d.h;
    }
    facingDims[facing || "(standalone)"] = dims;
    console.log(
      `  facing "${facing || "(standalone)"}" cropped to ${dims.w}x${dims.h} (${bucket.items.length} sheets)`,
    );
  }

  // Delete empty sheets and the empty job-dirs they leave behind.
  for (const e of emptySheets) {
    if (existsSync(e.outPath)) unlinkSync(e.outPath);
  }
  // A job dir with no remaining PNGs → remove it.
  const dirsSeen = new Set(plan.jobs.map((j) => j.dirSlug));
  for (const d of dirsSeen) {
    const full = join(outDir, d);
    if (!existsSync(full)) continue;
    const entries = readFileSyncDirSafely(full);
    if (entries.length === 0) rmSync(full, { recursive: true, force: true });
  }

  // Manifest.
  const manifest = {
    version: MANIFEST_VERSION,
    cacheKey,
    input: basename(input),
    generatedAt: new Date().toISOString(),
    facings: {},
    emptySheets: emptySheets.map((e) => ({
      dir: e.dirSlug,
      tag: e.tag,
      kind: e.kind,
    })),
  };
  for (const [facing, bucket] of byFacing) {
    const key = facing || "(standalone)";
    manifest.facings[key] = {
      bbox: facingDims[key],
      sheets: bucket.items.map((e) => ({
        dir: e.dirSlug,
        tag: e.tag,
        kind: e.kind,
        frames: e.frames.length,
      })),
    };
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(
    `Done. ${exported.length - emptySheets.length} PNG(s), ${emptySheets.length} empty skipped. Manifest: ${manifestPath}`,
  );
}

function readFileSyncDirSafely(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

main().catch((err) => {
  console.error(err?.stderr?.toString() ?? err.message ?? err);
  process.exit(1);
});
