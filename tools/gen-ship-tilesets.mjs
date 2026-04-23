// Generate packed 2D ship tilesets (+ prefab .tmx) from the raw Sea
// Adventures "strip" spritesheets.
//
// Background: the source spritesheets are horizontal strips of full-ship
// frames (608x640 per frame, 17 frames for sailing, 15 for idle). A single
// strip is 10336x640 for sailing — wider than the WebGL MAX_TEXTURE_SIZE on
// common mobile GPUs (which can be as low as 4096), causing the texture to
// fail to upload and render as black on mobile. This generator repacks the
// strips into a 2D grid that fits within a 4096px cap while preserving the
// per-frame tile animation pipeline.
//
// Input: `<name>-strip.png` (one of the hand-authored horizontal strips).
// Output (overwrites at each run):
//   - `<name>.png`          packed 2D grid (same filename the .tsx ships to)
//   - `<name>.tsx`          tileset referencing the packed PNG with
//                            per-sub-tile <animation> entries
//   - `<name>.prefab.tmx`   1-frame-sized prefab placing the frame-0 tile
//                            for each non-empty sub-tile
//
// Tile-grid interpretation: we reinterpret the packed image as a 32x32 tile
// grid. Frame `f` lives at grid position (fr = f/FPR, fc = f%FPR), occupying
// (ROWS_PER_FRAME x COLS_PER_FRAME) sub-tiles. The tile id for sub-tile
// (subR, subC) in frame `f` is:
//   id = (fr * ROWS_PER_FRAME + subR) * (FPR * COLS_PER_FRAME)
//        + (fc * COLS_PER_FRAME + subC)
// The frame-0 tile for each sub-tile (r, c) carries the <animation> cycling
// through the other frames' tiles at the same sub-tile position.
//
// Run: node tools/gen-ship-tilesets.mjs

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SHIP_DIR = path.resolve(
  "maps/themes/Sea Adventures/props/animated/ship",
);
const FRAME_W = 608;
const FRAME_H = 640;
const TILE = 32;
const COLS_PER_FRAME = FRAME_W / TILE; // 19
const ROWS_PER_FRAME = FRAME_H / TILE; // 20
const FRAME_RATE = 12;
const FRAME_MS = Math.round(1000 / FRAME_RATE);
// WebGL MAX_TEXTURE_SIZE on mobile GPUs can be as low as 4096. Aim for a
// packing that keeps both dimensions below this cap with headroom.
const MAX_DIM = 4096;

function isStrip(name) {
  return name.endsWith("-strip.png");
}

function pickFramesPerRow(nFrames) {
  // Among all packings that fit within MAX_DIM, pick the one minimizing
  // max(width, height). This yields the most square packing — good for
  // texture cache and a conservative margin under the hardware cap.
  let best = null;
  for (let fpr = 1; fpr <= nFrames; fpr++) {
    const rows = Math.ceil(nFrames / fpr);
    const w = fpr * FRAME_W;
    const h = rows * FRAME_H;
    if (w > MAX_DIM || h > MAX_DIM) continue;
    const score = Math.max(w, h);
    if (!best || score < best.score) best = { fpr, rows, w, h, score };
  }
  if (!best) {
    throw new Error(
      `Cannot pack ${nFrames} frames of ${FRAME_W}x${FRAME_H} under ${MAX_DIM}px`,
    );
  }
  return best;
}

async function packStripTo2D(stripPath, nFrames, fpr, rows, outPath) {
  const stripImg = sharp(stripPath);
  const composites = [];
  for (let f = 0; f < nFrames; f++) {
    const fr = Math.floor(f / fpr);
    const fc = f % fpr;
    const frameBuf = await stripImg
      .clone()
      .extract({ left: f * FRAME_W, top: 0, width: FRAME_W, height: FRAME_H })
      .png()
      .toBuffer();
    composites.push({
      input: frameBuf,
      left: fc * FRAME_W,
      top: fr * FRAME_H,
    });
  }
  await sharp({
    create: {
      width: fpr * FRAME_W,
      height: rows * FRAME_H,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toFile(outPath);
}

async function loadFrameAlpha(packedPath, nFrames, fpr, rows) {
  // Returns a 3D array [frame][row][col] = true if sub-tile is non-empty.
  // We flag a sub-tile "opaque" if any pixel inside it has alpha > 0.
  const { data, info } = await sharp(packedPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4)
    throw new Error(`Expected RGBA, got ${info.channels}`);
  const present = [];
  for (let f = 0; f < nFrames; f++) {
    const rowsArr = [];
    for (let r = 0; r < ROWS_PER_FRAME; r++) {
      rowsArr.push(new Array(COLS_PER_FRAME).fill(false));
    }
    present.push(rowsArr);
  }
  const w = info.width;
  for (let y = 0; y < info.height; y++) {
    const fr = Math.floor(y / FRAME_H);
    const subR = Math.floor((y - fr * FRAME_H) / TILE);
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a === 0) continue;
      const fc = Math.floor(x / FRAME_W);
      const f = fr * fpr + fc;
      if (f >= nFrames) continue; // empty slot in the packed grid
      const subC = Math.floor((x - fc * FRAME_W) / TILE);
      present[f][subR][subC] = true;
    }
  }
  return present;
}

function tileIdFor(f, subR, subC, fpr) {
  const fr = Math.floor(f / fpr);
  const fc = f % fpr;
  const gridCols = fpr * COLS_PER_FRAME;
  const r = fr * ROWS_PER_FRAME + subR;
  const c = fc * COLS_PER_FRAME + subC;
  return r * gridCols + c;
}

function buildTsx({ name, pngName, nFrames, present, fpr, rows, imageW, imageH }) {
  const gridCols = fpr * COLS_PER_FRAME;
  const gridRows = rows * ROWS_PER_FRAME;
  const tilecount = gridCols * gridRows;
  const animations = [];
  for (let subR = 0; subR < ROWS_PER_FRAME; subR++) {
    for (let subC = 0; subC < COLS_PER_FRAME; subC++) {
      // Skip if this sub-tile is empty in every frame.
      let anyOpaque = false;
      for (let f = 0; f < nFrames; f++) {
        if (present[f][subR][subC]) {
          anyOpaque = true;
          break;
        }
      }
      if (!anyOpaque) continue;
      if (nFrames <= 1) continue;
      const baseId = tileIdFor(0, subR, subC, fpr);
      const frames = [];
      for (let f = 0; f < nFrames; f++) {
        const fid = tileIdFor(f, subR, subC, fpr);
        frames.push(`   <frame tileid="${fid}" duration="${FRAME_MS}"/>`);
      }
      animations.push(
        ` <tile id="${baseId}">\n  <animation>\n${frames.join(
          "\n",
        )}\n  </animation>\n </tile>`,
      );
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<tileset version="1.10" tiledversion="1.12.1" name="${name}" tilewidth="${TILE}" tileheight="${TILE}" tilecount="${tilecount}" columns="${gridCols}">
 <image source="${pngName}" width="${imageW}" height="${imageH}"/>
${animations.join("\n")}
</tileset>
`;
}

function buildPrefab({ name, tsxName, present, nFrames, fpr }) {
  // A standalone .tmx sized to one frame (COLS_PER_FRAME x ROWS_PER_FRAME)
  // that places the frame-0 sub-tiles of any non-empty position. Imports the
  // tileset with firstgid=1.
  const rows = [];
  for (let subR = 0; subR < ROWS_PER_FRAME; subR++) {
    const line = [];
    for (let subC = 0; subC < COLS_PER_FRAME; subC++) {
      let anyOpaque = false;
      for (let f = 0; f < nFrames; f++) {
        if (present[f][subR][subC]) {
          anyOpaque = true;
          break;
        }
      }
      if (!anyOpaque) {
        line.push("0");
      } else {
        const baseId = tileIdFor(0, subR, subC, fpr);
        line.push(String(1 + baseId));
      }
    }
    rows.push(line.join(",") + ",");
  }
  rows[rows.length - 1] = rows[rows.length - 1].replace(/,$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" tiledversion="1.12.1" orientation="orthogonal" renderorder="right-down" width="${COLS_PER_FRAME}" height="${ROWS_PER_FRAME}" tilewidth="${TILE}" tileheight="${TILE}" infinite="0" nextlayerid="2" nextobjectid="1">
 <tileset firstgid="1" source="${tsxName}"/>
 <layer id="1" name="${name}" width="${COLS_PER_FRAME}" height="${ROWS_PER_FRAME}">
  <data encoding="csv">
${rows.join("\n")}
</data>
 </layer>
</map>
`;
}

async function main() {
  const entries = await fs.readdir(SHIP_DIR);
  const strips = entries.filter(isStrip).sort();
  if (strips.length === 0) {
    console.error(`No -strip.png sources found in ${SHIP_DIR}`);
    process.exit(1);
  }

  for (const strip of strips) {
    const stripAbs = path.join(SHIP_DIR, strip);
    const meta = await sharp(stripAbs).metadata();
    if (meta.height !== FRAME_H) {
      console.warn(`Skip ${strip}: height ${meta.height} != ${FRAME_H}`);
      continue;
    }
    if (meta.width % FRAME_W !== 0) {
      console.warn(
        `Skip ${strip}: width ${meta.width} not a multiple of ${FRAME_W}`,
      );
      continue;
    }
    const nFrames = meta.width / FRAME_W;
    const { fpr, rows, w: packedW, h: packedH } = pickFramesPerRow(nFrames);

    // Canonical output names (no `-strip` suffix) — these become the
    // tileset's public-facing filenames.
    const stemName = strip.replace(/-strip\.png$/i, "");
    const packedPng = `${stemName}.png`;
    const tsxFile = `${stemName}.tsx`;
    const tmxFile = `${stemName}.prefab.tmx`;
    const packedAbs = path.join(SHIP_DIR, packedPng);

    await packStripTo2D(stripAbs, nFrames, fpr, rows, packedAbs);

    const present = await loadFrameAlpha(packedAbs, nFrames, fpr, rows);

    const tsx = buildTsx({
      name: stemName,
      pngName: packedPng,
      nFrames,
      present,
      fpr,
      rows,
      imageW: packedW,
      imageH: packedH,
    });
    await fs.writeFile(path.join(SHIP_DIR, tsxFile), tsx, "utf8");

    const tmx = buildPrefab({
      name: stemName,
      tsxName: tsxFile,
      present,
      nFrames,
      fpr,
    });
    await fs.writeFile(path.join(SHIP_DIR, tmxFile), tmx, "utf8");

    let opaque = 0;
    for (let subR = 0; subR < ROWS_PER_FRAME; subR++) {
      for (let subC = 0; subC < COLS_PER_FRAME; subC++) {
        for (let f = 0; f < nFrames; f++) {
          if (present[f][subR][subC]) {
            opaque++;
            break;
          }
        }
      }
    }
    console.log(
      `${stemName}: ${nFrames} frames → ${fpr}x${rows} (${packedW}x${packedH}), ` +
        `${opaque}/${COLS_PER_FRAME * ROWS_PER_FRAME} opaque sub-tiles`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
