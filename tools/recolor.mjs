#!/usr/bin/env node
/**
 * Recursively swap one exact RGBA color for another across all .png and
 * .aseprite files under a directory.
 *
 *   node tools/recolor.mjs <dir> [--from #2f3b3d] [--to #000000]
 *                                [--dry-run] [--backup] [--aseprite PATH]
 *
 * Match is exact RGB with alpha 255. PNGs are rewritten in place via
 * sharp. .aseprite files are processed by shelling out to the Aseprite
 * CLI with a generated Lua script (handles both RGB and INDEXED color
 * modes; INDEXED files have palette entries swapped instead of pixels).
 *
 * Always do --dry-run first. --backup writes a sibling .bak before
 * touching each file.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import sharp from "sharp";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

function parseHex(h) {
  const s = h.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`bad hex: ${h}`);
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
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

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function recolorPng(file, from, to, dryRun) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let count = 0;
  for (let i = 0; i < data.length; i += channels) {
    if (
      data[i] === from[0] &&
      data[i + 1] === from[1] &&
      data[i + 2] === from[2] &&
      data[i + 3] === 255
    ) {
      data[i] = to[0];
      data[i + 1] = to[1];
      data[i + 2] = to[2];
      count++;
    }
  }
  if (count > 0 && !dryRun) {
    const tmp = file + ".tmp";
    await sharp(data, { raw: { width, height, channels } })
      .png()
      .toFile(tmp);
    await rename(tmp, file);
  }
  return count;
}

function buildLua(from, to) {
  return `local fr,fg,fb=${from[0]},${from[1]},${from[2]}
local tr,tg,tb=${to[0]},${to[1]},${to[2]}
local spr=app.activeSprite
if not spr then return end
if spr.colorMode==ColorMode.INDEXED then
  for _,pal in ipairs(spr.palettes) do
    for i=0,#pal-1 do
      local c=pal:getColor(i)
      if c.red==fr and c.green==fg and c.blue==fb and c.alpha==255 then
        pal:setColor(i,Color{r=tr,g=tg,b=tb,a=255})
      end
    end
  end
elseif spr.colorMode==ColorMode.RGB then
  local fpx=app.pixelColor.rgba(fr,fg,fb,255)
  local tpx=app.pixelColor.rgba(tr,tg,tb,255)
  for _,cel in ipairs(spr.cels) do
    local img=cel.image:clone()
    local changed=false
    for it in img:pixels() do
      if it()==fpx then it(tpx) changed=true end
    end
    if changed then spr:newCel(cel.layer,cel.frameNumber,img,cel.position) end
  end
else
  print("skip: unsupported colorMode "..tostring(spr.colorMode))
  return
end
spr:saveAs(spr.filename)
`;
}

async function main() {
  const args = process.argv.slice(2);
  let dir = null;
  let from = "#2f3b3d";
  let to = "#000000";
  let dryRun = false;
  let backup = false;
  let asepriteExe = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--from") from = args[++i];
    else if (a === "--to") to = args[++i];
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--backup") backup = true;
    else if (a === "--aseprite") asepriteExe = args[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node tools/recolor.mjs <dir> [--from #hex] [--to #hex] [--dry-run] [--backup] [--aseprite PATH]"
      );
      process.exit(0);
    } else if (!dir) dir = a;
    else throw new Error(`unexpected arg: ${a}`);
  }

  if (!dir) {
    console.error("missing <dir>. use --help.");
    process.exit(1);
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`not a directory: ${dir}`);
    process.exit(1);
  }

  const fromRgb = parseHex(from);
  const toRgb = parseHex(to);
  const ase = findAseprite(asepriteExe);
  const luaPath = resolve(__dirname, "recolor.lua");
  await writeFile(luaPath, buildLua(fromRgb, toRgb));

  console.log(
    `Recoloring under ${resolve(dir)}: ${from} -> ${to}` +
      (dryRun ? "  [DRY RUN]" : "") +
      (backup ? "  [+backup]" : "")
  );
  console.log(`Aseprite: ${ase}`);

  let pngsChanged = 0;
  let pngsScanned = 0;
  let pixelTotal = 0;
  let aseProcessed = 0;
  let aseFailed = 0;

  for (const file of walk(dir)) {
    const ext = extname(file).toLowerCase();
    if (ext === ".png") {
      pngsScanned++;
      try {
        if (backup && !dryRun) copyFileSync(file, file + ".bak");
        const n = await recolorPng(file, fromRgb, toRgb, dryRun);
        if (n > 0) {
          pngsChanged++;
          pixelTotal += n;
          console.log(`  png  ${file}  (${n} px)`);
        }
      } catch (e) {
        console.error(`  png  ${file}  FAILED: ${e.message}`);
      }
    } else if (ext === ".aseprite" || ext === ".ase") {
      console.log(`  ase  ${file}`);
      if (dryRun) continue;
      try {
        if (backup) copyFileSync(file, file + ".bak");
        const { stdout } = await exec(ase, ["-b", file, "--script", luaPath]);
        if (stdout.trim()) console.log(`       ${stdout.trim()}`);
        aseProcessed++;
      } catch (e) {
        aseFailed++;
        console.error(`       FAILED: ${e.message}`);
      }
    }
  }

  console.log(
    `\nDone. PNGs: ${pngsChanged}/${pngsScanned} changed (${pixelTotal} px). ` +
      `Aseprite: ${aseProcessed} ok, ${aseFailed} failed.`
  );
  if (dryRun) console.log("(dry run — nothing written)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
