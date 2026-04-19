// Build per-part ship-animation tilesets from the exploded frame PNGs in
// maps/themes/Sea Adventures/props/animated/ship/ship parts/<dir>-frames/.
//
// Each direction folder (down-frames, sideways-frames, up-frames) contains
// N individual PNGs per part, named `<state>-<part>-frame<N>.png` where:
//   state = idle | sailing
//   part  = ship-base, sail, wheel, waves, wind, handrail, ...
//
// For every (direction, state, part) group we:
//   1. Sort frame PNGs numerically.
//   2. Composite them into a horizontal strip: N x 608x640.
//   3. Write the strip PNG and a matching .tsx that treats the image as
//      32x32 sub-tiles with per-sub-tile <animation>s cycling through the
//      same (r, c) position across every frame. Fully-transparent sub-tile
//      positions are skipped.
//
// Outputs go to `ship parts/combined/` alongside the source frames. The
// ship .tmx files can reference them via
//   ../themes/Sea Adventures/props/animated/ship/ship parts/combined/*.tsx
//
// Run: node tools/gen-ship-parts-tilesets.mjs

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(
  "maps/themes/Sea Adventures/props/animated/ship/ship parts",
);
const OUT_DIR = path.join(ROOT, "combined");
const DIRS = ["down-frames", "sideways-frames", "up-frames"];
const FRAME_W = 608;
const FRAME_H = 640;
const TILE = 32;
const COLS_PER_FRAME = FRAME_W / TILE; // 19
const ROWS_PER_FRAME = FRAME_H / TILE; // 20
const FRAME_RATE = 12;
const FRAME_MS = Math.round(1000 / FRAME_RATE);

// Map the on-disk folder prefix to the direction label used in output names.
const DIR_LABEL = {
  "down-frames": "down",
  "sideways-frames": "sideways",
  "up-frames": "up",
};

// Matches: "<state>-<part>-frame<N>.png"
const FRAME_RE = /^(idle|sailing)-(.+)-frame(\d+)\.png$/i;

async function groupFrames(dir) {
  const entries = await fs.readdir(dir);
  const groups = new Map(); // key "state|part" -> [{n, abs}]
  for (const name of entries) {
    const m = FRAME_RE.exec(name);
    if (!m) continue;
    const [, state, part, nStr] = m;
    const key = `${state.toLowerCase()}|${part}`;
    const abs = path.join(dir, name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ n: Number(nStr), abs });
  }
  for (const list of groups.values()) list.sort((a, b) => a.n - b.n);
  return groups;
}

async function compositeStrip(frameFiles, outPath) {
  const composites = frameFiles.map((f, i) => ({
    input: f.abs,
    left: i * FRAME_W,
    top: 0,
  }));
  const totalW = frameFiles.length * FRAME_W;
  const buf = await sharp({
    create: {
      width: totalW,
      height: FRAME_H,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
  await fs.writeFile(outPath, buf);
  return buf;
}

async function loadPresence(pngBuf, nFrames) {
  const { data, info } = await sharp(pngBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`Expected RGBA, got ${info.channels}`);
  const w = info.width;
  const present = [];
  for (let f = 0; f < nFrames; f++) {
    const grid = [];
    for (let r = 0; r < ROWS_PER_FRAME; r++) {
      grid.push(new Array(COLS_PER_FRAME).fill(false));
    }
    present.push(grid);
  }
  for (let y = 0; y < info.height; y++) {
    const r = Math.floor(y / TILE);
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a === 0) continue;
      const f = Math.floor(x / FRAME_W);
      const c = Math.floor((x - f * FRAME_W) / TILE);
      present[f][r][c] = true;
    }
  }
  return present;
}

function buildTsx({ name, pngName, nFrames, present, imageW, imageH }) {
  const cols = nFrames * COLS_PER_FRAME;
  const tilecount = cols * ROWS_PER_FRAME;
  const animations = [];
  if (nFrames > 1) {
    for (let r = 0; r < ROWS_PER_FRAME; r++) {
      for (let c = 0; c < COLS_PER_FRAME; c++) {
        let anyOpaque = false;
        for (let f = 0; f < nFrames; f++) {
          if (present[f][r][c]) { anyOpaque = true; break; }
        }
        if (!anyOpaque) continue;
        const baseId = r * cols + c;
        const frames = [];
        for (let f = 0; f < nFrames; f++) {
          const fid = r * cols + f * COLS_PER_FRAME + c;
          frames.push(`   <frame tileid="${fid}" duration="${FRAME_MS}"/>`);
        }
        animations.push(
          ` <tile id="${baseId}">\n  <animation>\n${frames.join("\n")}\n  </animation>\n </tile>`,
        );
      }
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<tileset version="1.10" tiledversion="1.12.1" name="${name}" tilewidth="${TILE}" tileheight="${TILE}" tilecount="${tilecount}" columns="${cols}">
 <image source="${pngName}" width="${imageW}" height="${imageH}"/>
${animations.join("\n")}
</tileset>
`;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  let wrote = 0;
  for (const dirName of DIRS) {
    const dir = path.join(ROOT, dirName);
    const label = DIR_LABEL[dirName];
    const groups = await groupFrames(dir);
    const keys = Array.from(groups.keys()).sort();
    for (const key of keys) {
      const [state, part] = key.split("|");
      const frames = groups.get(key);
      const nFrames = frames.length;
      const name = `${label}-${state}-${part}`;
      const pngName = `${name}.png`;
      const pngPath = path.join(OUT_DIR, pngName);
      const stripBuf = await compositeStrip(frames, pngPath);
      const imageW = nFrames * FRAME_W;
      const imageH = FRAME_H;
      const present = await loadPresence(stripBuf, nFrames);
      const tsx = buildTsx({ name, pngName, nFrames, present, imageW, imageH });
      await fs.writeFile(path.join(OUT_DIR, `${name}.tsx`), tsx, "utf8");
      let opaque = 0;
      for (let r = 0; r < ROWS_PER_FRAME; r++) {
        for (let c = 0; c < COLS_PER_FRAME; c++) {
          for (let f = 0; f < nFrames; f++) {
            if (present[f][r][c]) { opaque++; break; }
          }
        }
      }
      console.log(
        `${name}: ${nFrames} frames, ${opaque}/${COLS_PER_FRAME * ROWS_PER_FRAME} opaque sub-tiles`,
      );
      wrote++;
    }
  }
  console.log(`\n${wrote} part tilesets written to ${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
