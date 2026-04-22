#!/usr/bin/env node
/**
 * Build per-slot sprite sheets for a layered character model. Takes a
 * model config that declares each slot+variant and how to produce its
 * pixels (either a layer of the master, or a painted template + map),
 * exports per-tag PNG sheets, and crops every sheet to a SHARED bbox
 * across the whole model so layers composite pixel-perfect at runtime.
 *
 * Output layout (reads cleanly into Phaser spritesheet loaders):
 *   <outDir>/<model>/model.json           { frameWidth, frameHeight, slotOrder }
 *   <outDir>/<model>/<slot>/<variant>/<tag>.png
 *
 * Config JSON shape:
 *   {
 *     "model": "hana_caraka",
 *     "master": "path/to/master.aseprite",
 *     "facing": "side",                    // which facing group to export
 *     "tags": ["idle", "walk"],
 *     "slotOrder": ["body", "head", "hair", "helmet"],
 *     "variants": [
 *       { "slot": "body", "variant": "pale_default",
 *         "source": "master-layer", "layer": "side/body" },
 *       { "slot": "hair", "variant": "short_brown",
 *         "source": "template",
 *         "template": "path/to/head-shapes-short_brown.aseprite",
 *         "map":      "path/to/head-shapes-map.json",
 *         "part":     "hair" }
 *     ]
 *   }
 *
 * Usage:
 *   node tools/build-character-slots.mjs <config.json> [--out-dir PATH] [--aseprite PATH]
 *   (default out-dir: "public/sprites/characters")
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import sharp from "sharp";

const exec = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APPLY_LUA = join(SCRIPT_DIR, "aseprite-apply-body-outfit.lua");

function parseArgs(argv) {
  const out = { config: null, outDir: "public/sprites/characters", aseprite: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out-dir") out.outDir = argv[++i];
    else if (a === "--aseprite") out.aseprite = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else rest.push(a);
  }
  out.config = rest[0] ?? null;
  return out;
}

function findAseprite(explicit) {
  const cands = [
    explicit, process.env.ASEPRITE_EXE,
    "C:/Program Files/Aseprite/Aseprite.exe",
    "C:/Program Files (x86)/Aseprite/Aseprite.exe",
    "C:/Program Files (x86)/Steam/steamapps/common/Aseprite/Aseprite.exe",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs/Aseprite/Aseprite.exe") : null,
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
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

async function exportTag(ase, aseFile, tag, outPath, extraLayerArgs = []) {
  const dataPath = outPath.replace(/\.png$/, ".tmp.json");
  await exec(ase, [
    "-b",
    ...extraLayerArgs,
    "--tag", tag,
    "--format", "png",
    "--sheet-columns", "1",
    "--sheet", outPath,
    "--data", dataPath,
    aseFile,
  ]);
  const meta = JSON.parse(readFileSync(dataPath, "utf8"));
  unlinkSync(dataPath);
  return Object.values(meta.frames).map((f) => f.frame);
}

/** Export a slot variant's per-tag sheets at full master-canvas size. Returns
 *  [{ tag, pngPath, frames }]. Different sources need different approaches:
 *   - "master-layer": export straight from the master with --layer filter.
 *   - "template":     first call the apply-body-outfit lua to produce a
 *                     canvas-sized intermediate for the named facing/part,
 *                     then export tags from that intermediate. */
async function buildVariantSheets(ase, config, variant, tempDir) {
  const sheets = [];
  const slotVariantDir = join(tempDir, variant.slot, variant.variant);
  mkdirSync(slotVariantDir, { recursive: true });

  if (variant.source === "master-layer") {
    for (const tag of config.tags) {
      const outPath = join(slotVariantDir, `${tag}.png`);
      const frames = await exportTag(ase, resolve(config.master), tag, outPath, ["--layer", variant.layer]);
      sheets.push({ tag, pngPath: outPath, frames });
    }
    return sheets;
  }

  if (variant.source === "template") {
    // Produce an intermediate <facing>-<part>.aseprite via the apply-outfit
    // lua, then export tags from it.
    const intermediateDir = join(slotVariantDir, "_aseprite");
    mkdirSync(intermediateDir, { recursive: true });
    const mapJson = JSON.parse(readFileSync(resolve(variant.map), "utf8"));
    const mapLuaPath = join(intermediateDir, "map.lua");
    writeFileSync(mapLuaPath, "return " + toLua(mapJson));
    await exec(ase, [
      "-b", resolve(config.master),
      "--script-param", `out=${intermediateDir}`,
      "--script-param", `outfit=${resolve(variant.template)}`,
      "--script-param", `mapLua=${mapLuaPath}`,
      "--script-param", `facings=${config.facing}`,
      "--script-param", `bodySuffix=${variant.part}`,
      "--script", APPLY_LUA,
    ]);
    const facingAse = join(intermediateDir, `${config.facing}-${variant.part}.aseprite`);
    if (!existsSync(facingAse)) throw new Error(`intermediate missing for ${variant.slot}/${variant.variant}: ${facingAse}`);
    for (const tag of config.tags) {
      const outPath = join(slotVariantDir, `${tag}.png`);
      const frames = await exportTag(ase, facingAse, tag, outPath);
      sheets.push({ tag, pngPath: outPath, frames });
    }
    return sheets;
  }

  throw new Error(`unknown source type: ${variant.source}`);
}

async function readRaw(path) {
  return sharp(path).raw().toBuffer({ resolveWithObject: true });
}

function bboxOfRaw(raw, frames) {
  const { data, info } = raw;
  const { width, channels } = info;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (const f of frames) {
    for (let y = 0; y < f.h; y++) {
      const row = ((f.y + y) * width + f.x) * channels + 3;
      for (let x = 0; x < f.w; x++) {
        if (data[row + x * channels] > 0) {
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

async function cropSheetToBbox(raw, outPath, frames, bbox) {
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
  await sharp(out, { raw: { width: outW, height: outH, channels } }).png().toFile(outPath);
  return { w: newFw, h: newFh };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.config) {
    console.log("Usage: node tools/build-character-slots.mjs <config.json> [--out-dir PATH]");
    process.exit(args.help ? 0 : 1);
  }
  const cfgPath = resolve(args.config);
  if (!existsSync(cfgPath)) { console.error(`config not found: ${cfgPath}`); process.exit(1); }
  const config = JSON.parse(readFileSync(cfgPath, "utf8"));
  for (const required of ["model", "master", "facing", "tags", "slotOrder", "variants"]) {
    if (config[required] === undefined) throw new Error(`config missing "${required}"`);
  }
  if (!existsSync(resolve(config.master))) throw new Error(`master not found: ${config.master}`);

  const ase = findAseprite(args.aseprite);
  const modelRootTemp = join(resolve(args.outDir), config.model, "_tmp");
  if (existsSync(modelRootTemp)) rmSync(modelRootTemp, { recursive: true, force: true });
  mkdirSync(modelRootTemp, { recursive: true });

  // Stage 1: produce canvas-sized sheets for every slot variant.
  console.log(`Building ${config.variants.length} slot-variant(s) for model "${config.model}"...`);
  const sheetsByVariant = [];
  for (const variant of config.variants) {
    process.stdout.write(`  ${variant.slot}/${variant.variant}... `);
    const t0 = Date.now();
    const sheets = await buildVariantSheets(ase, config, variant, modelRootTemp);
    sheetsByVariant.push({ variant, sheets });
    console.log(`${sheets.length} tag(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Stage 2: compute one shared bbox across every sheet so all slots align.
  console.log("Computing shared bbox across all slot variants...");
  const rawCache = new Map();
  let unionBbox = null;
  for (const { sheets } of sheetsByVariant) {
    for (const s of sheets) {
      const raw = await readRaw(s.pngPath);
      rawCache.set(s.pngPath, raw);
      const bb = bboxOfRaw(raw, s.frames);
      if (!bb) continue;
      if (!unionBbox) { unionBbox = { ...bb }; continue; }
      if (bb.minX < unionBbox.minX) unionBbox.minX = bb.minX;
      if (bb.minY < unionBbox.minY) unionBbox.minY = bb.minY;
      if (bb.maxX > unionBbox.maxX) unionBbox.maxX = bb.maxX;
      if (bb.maxY > unionBbox.maxY) unionBbox.maxY = bb.maxY;
    }
  }
  if (!unionBbox) { console.error("No non-transparent pixels in any slot variant."); process.exit(1); }
  const frameW = unionBbox.maxX - unionBbox.minX + 1;
  const frameH = unionBbox.maxY - unionBbox.minY + 1;
  console.log(`  model frame: ${frameW}x${frameH}`);

  // Stage 3: crop every sheet to the shared bbox and move into the final tree.
  // Collect per-tag frame counts along the way — runtime anim registration
  // needs them and they're identical across slot variants by construction.
  const modelOutDir = join(resolve(args.outDir), config.model);
  const slotsSummary = {};
  const frameCountsByTag = {};
  for (const { variant, sheets } of sheetsByVariant) {
    const slotDir = join(modelOutDir, variant.slot, variant.variant);
    mkdirSync(slotDir, { recursive: true });
    for (const s of sheets) {
      const finalPng = join(slotDir, `${s.tag}.png`);
      const raw = rawCache.get(s.pngPath);
      await cropSheetToBbox(raw, finalPng, s.frames, unionBbox);
      frameCountsByTag[s.tag] ??= s.frames.length;
    }
    (slotsSummary[variant.slot] ??= []).push(variant.variant);
  }

  // Stage 4: write the model manifest the runtime loads at boot.
  // Default frame rates mirror the existing NPC convention (idle=4, walk=8)
  // unless the config overrides them per tag.
  const defaultFps = { idle: 4, walk: 8 };
  const tagsOut = {};
  for (const tag of config.tags) {
    tagsOut[tag] = {
      frames: frameCountsByTag[tag] ?? 0,
      frameRate: (config.frameRates && config.frameRates[tag]) ?? defaultFps[tag] ?? 8,
    };
  }
  const modelJsonPath = join(modelOutDir, "model.json");
  writeFileSync(modelJsonPath, JSON.stringify({
    model: config.model,
    frameWidth: frameW,
    frameHeight: frameH,
    slotOrder: config.slotOrder,
    tags: tagsOut,
    slots: slotsSummary,
  }, null, 2));

  rmSync(modelRootTemp, { recursive: true, force: true });

  console.log(`Done. Model manifest: ${modelJsonPath}`);
  for (const [slot, variants] of Object.entries(slotsSummary)) {
    console.log(`  ${slot}: ${variants.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err?.stderr?.toString() ?? err.message ?? err);
  process.exit(1);
});
