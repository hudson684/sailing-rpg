// Generate Tiled .tsx tilesets (+ prefab .tmx) from the packed Sea Adventures
// ship spritesheets so Phaser can animate them as ordinary tile animations.
//
// Each source PNG is a horizontal strip of full-ship frames (608x640 per
// frame). Phaser's tilemap animation only runs on tiles whose size matches
// the map grid, so we reinterpret the same PNG as a 32x32 tile grid:
//   image cols = N_frames * (608/32) = N_frames * 19
//   image rows = 640/32 = 20
// For each sub-tile position (r, c) inside a frame we emit an <animation>
// on the first-frame tile (frame 0) cycling through the same (r, c)
// sub-tile in every other frame. The map references only the frame-0 tile
// for each sub-tile position, and Phaser drives the animation.
//
// Fully transparent sub-tiles are skipped (no animation, no prefab tile).
//
// Run: node tools/gen-ship-tilesets.mjs
// Writes .tsx + .tmx alongside each source PNG.

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

function isStrip(name) {
  if (!name.endsWith(".png")) return false;
  if (name.includes("packed")) return false;
  return name.endsWith("-baked.png") || name.endsWith("-windFX.png");
}

async function loadFrameAlpha(pngPath, nFrames) {
  // Returns a 3D array [frame][row][col] = true if sub-tile is non-empty.
  // We flag a sub-tile "opaque" if any pixel inside it has alpha > 0.
  const { data, info } = await sharp(pngPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`Expected RGBA, got ${info.channels}`);
  const w = info.width;
  const present = [];
  for (let f = 0; f < nFrames; f++) {
    const rows = [];
    for (let r = 0; r < ROWS_PER_FRAME; r++) {
      const cols = new Array(COLS_PER_FRAME).fill(false);
      rows.push(cols);
    }
    present.push(rows);
  }
  for (let y = 0; y < info.height; y++) {
    const r = Math.floor(y / TILE);
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a === 0) continue;
      const f = Math.floor(x / FRAME_W);
      const cInFrame = Math.floor((x - f * FRAME_W) / TILE);
      present[f][r][cInFrame] = true;
    }
  }
  return present;
}

function buildTsx({ name, pngName, nFrames, present, imageW, imageH }) {
  const cols = nFrames * COLS_PER_FRAME;
  const tilecount = cols * ROWS_PER_FRAME;
  // Animation goes on the frame-0 tile for each (r, c). Tile id for frame f,
  // row r, col c within the combined image:
  //   id = r * cols + f * COLS_PER_FRAME + c
  const animations = [];
  for (let r = 0; r < ROWS_PER_FRAME; r++) {
    for (let c = 0; c < COLS_PER_FRAME; c++) {
      // Skip if this sub-tile is empty in every frame.
      let anyOpaque = false;
      for (let f = 0; f < nFrames; f++) {
        if (present[f][r][c]) { anyOpaque = true; break; }
      }
      if (!anyOpaque) continue;
      const baseId = r * cols + c;
      if (nFrames <= 1) continue;
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
  return `<?xml version="1.0" encoding="UTF-8"?>
<tileset version="1.10" tiledversion="1.12.1" name="${name}" tilewidth="${TILE}" tileheight="${TILE}" tilecount="${tilecount}" columns="${cols}">
 <image source="${pngName}" width="${imageW}" height="${imageH}"/>
${animations.join("\n")}
</tileset>
`;
}

function buildPrefab({ name, tsxName, present, nFrames }) {
  // A standalone .tmx sized to one frame (19x20) that places the frame-0
  // sub-tiles of any non-empty position. Imports the tileset with firstgid=1.
  const cols = nFrames * COLS_PER_FRAME;
  const rows = [];
  // Any sub-tile opaque in frame 0 is placed; sub-tiles that only appear in
  // later frames still get placed (their frame-0 tile may be empty but the
  // animation cycles it in). Use "opaque in any frame".
  for (let r = 0; r < ROWS_PER_FRAME; r++) {
    const line = [];
    for (let c = 0; c < COLS_PER_FRAME; c++) {
      let anyOpaque = false;
      for (let f = 0; f < nFrames; f++) {
        if (present[f][r][c]) { anyOpaque = true; break; }
      }
      if (!anyOpaque) {
        line.push("0");
      } else {
        // Tiled gids are 1-based with the tileset's firstgid offset.
        const baseId = r * cols + c;
        line.push(String(1 + baseId));
      }
    }
    rows.push(line.join(",") + ",");
  }
  // Drop trailing comma on the very last line.
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
  const pngs = entries.filter(isStrip).sort();
  if (pngs.length === 0) {
    console.error(`No strip PNGs found in ${SHIP_DIR}`);
    process.exit(1);
  }

  for (const png of pngs) {
    const abs = path.join(SHIP_DIR, png);
    const meta = await sharp(abs).metadata();
    if (meta.height !== FRAME_H) {
      console.warn(`Skip ${png}: height ${meta.height} != ${FRAME_H}`);
      continue;
    }
    if (meta.width % FRAME_W !== 0) {
      console.warn(`Skip ${png}: width ${meta.width} not a multiple of ${FRAME_W}`);
      continue;
    }
    const nFrames = meta.width / FRAME_W;
    const present = await loadFrameAlpha(abs, nFrames);
    const name = png.replace(/\.png$/i, "");
    const tsxFile = `${name}.tsx`;
    const tmxFile = `${name}.prefab.tmx`;

    const tsx = buildTsx({
      name,
      pngName: png,
      nFrames,
      present,
      imageW: meta.width,
      imageH: meta.height,
    });
    await fs.writeFile(path.join(SHIP_DIR, tsxFile), tsx, "utf8");

    const tmx = buildPrefab({ name, tsxName: tsxFile, present, nFrames });
    await fs.writeFile(path.join(SHIP_DIR, tmxFile), tmx, "utf8");

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
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
