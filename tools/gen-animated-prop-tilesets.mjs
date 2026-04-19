// Generate Tiled .tsx tilesets for the animated props in
// maps/themes/Sea Adventures/props/animated/, compatible with Phaser tile
// animations. Phaser only animates tiles on a tilemap layer whose tile size
// equals the tileset tile size, so every tileset here uses tilewidth=32 /
// tileheight=32 and we reinterpret each frame as a grid of 32x32 sub-tiles.
// For every opaque sub-tile position (r, c) inside a frame we emit an
// <animation> on the frame-0 tile cycling through that same (r, c)
// sub-tile in every other frame.
//
// If a frame's dimensions aren't multiples of 32 (palm trees, flag-pirate2)
// we first write a padded copy `<name>.padded.png` that extends each frame
// slot out to the next 32-multiple with transparent pixels, then generate
// the .tsx against that padded PNG. The originals are left untouched.
//
// Frame layouts are declared in the MANIFEST below. Edit and rerun if any
// asset's layout differs from what's assumed.
//
// Run: node tools/gen-animated-prop-tilesets.mjs

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const DIR = path.resolve("maps/themes/Sea Adventures/props/animated");
const TILE = 32;
const FRAME_RATE = 12;
const FRAME_MS = Math.round(1000 / FRAME_RATE);

// file: basename
// frameW/frameH: one frame in pixels
// frames: total frame count (played in order)
// cols: optional — sheet column count. Defaults to `frames` (single-row strip).
const MANIFEST = [
  { file: "animated Palm Tree-1.png",                  frameW: 104, frameH: 215, frames: 15 },
  { file: "animated Palm Tree-1-foliage.png",          frameW: 104, frameH: 96,  frames: 15 },
  { file: "animated Palm Tree-1-foliage-shadow.png",   frameW: 104, frameH: 87,  frames: 15 },
  { file: "animated Palm Tree-1-foliage-shadow2.png",  frameW: 104, frameH: 87,  frames: 15 },
  { file: "animated Palm Tree-2.png",                  frameW: 104, frameH: 215, frames: 15 },
  { file: "animated Palm Tree-2-foliage.png",          frameW: 104, frameH: 96,  frames: 15 },
  { file: "animated Palm Tree-2-foliage-shadow.png",   frameW: 104, frameH: 87,  frames: 15 },
  { file: "animated Palm Tree-2-foliage-shadow2.png",  frameW: 128, frameH: 96,  frames: 10 },
  { file: "animated Palm Tree-3.png",                  frameW: 104, frameH: 215, frames: 15 },
  { file: "animated Palm Tree-3-foliage.png",          frameW: 104, frameH: 96,  frames: 15 },
  { file: "animated Palm Tree-3-foliage-shadow.png",   frameW: 104, frameH: 87,  frames: 15 },

  { file: "banner-2-anim-neutral.png",                 frameW: 128, frameH: 128, frames: 9 },
  { file: "banner-2-anim.png",                         frameW: 128, frameH: 128, frames: 9 },
  { file: "banner-anim-neutral.png",                   frameW: 128, frameH: 128, frames: 9 },
  { file: "banner-anim.png",                           frameW: 128, frameH: 128, frames: 9 },
  { file: "banner-only.png",                           frameW: 128, frameH: 128, frames: 9 },

  { file: "boat-idle-down.png",                        frameW: 288, frameH: 256, frames: 14, cols: 4 },
  { file: "boat-idle-sideways.png",                    frameW: 288, frameH: 256, frames: 14, cols: 4 },
  { file: "boat-idle-up.png",                          frameW: 288, frameH: 256, frames: 14, cols: 4 },
  { file: "boat-sailing-down.png",                     frameW: 288, frameH: 256, frames: 14, cols: 4 },
  { file: "boat-sailing-sideways.png",                 frameW: 288, frameH: 256, frames: 14, cols: 4 },
  { file: "boat-sailing-up.png",                       frameW: 288, frameH: 256, frames: 14, cols: 4 },

  { file: "buried chest-opening.png",                  frameW: 128, frameH: 128, frames: 10 },
  { file: "buried chest-opening-gold.png",             frameW: 128, frameH: 128, frames: 10 },
  { file: "buried chest-opening-half buried.png",      frameW: 128, frameH: 128, frames: 11 },
  { file: "buried chest-opening-half buried-gold.png", frameW: 128, frameH: 128, frames: 11 },

  { file: "flag-pirate.png",                           frameW: 96,  frameH: 96,  frames: 8 },
  { file: "flag-pirate2.png",                          frameW: 128, frameH: 186, frames: 10 },

  { file: "gems-1.png",                                frameW: 32,  frameH: 32,  frames: 8 },
  { file: "gems-2.png",                                frameW: 32,  frameH: 32,  frames: 8 },
  { file: "gems-3.png",                                frameW: 32,  frameH: 32,  frames: 8 },
  { file: "gems-4.png",                                frameW: 32,  frameH: 32,  frames: 8 },

  { file: "wind fx-48frames.png",                      frameW: 288, frameH: 64,  frames: 48 },
];

function ceil32(n) {
  return Math.ceil(n / TILE) * TILE;
}

// Load raw RGBA for the source PNG; if the frame dims aren't 32-aligned,
// composite a padded image whose frame slots are the next 32-multiple in
// each dimension and write it to disk. Returns info needed to emit the .tsx.
async function preparePng(entry) {
  const srcPath = path.join(DIR, entry.file);
  const meta = await sharp(srcPath).metadata();
  const cols = entry.cols ?? entry.frames;
  const rows = Math.ceil(entry.frames / cols);

  const expectedW = cols * entry.frameW;
  const expectedH = rows * entry.frameH;
  if (meta.width !== expectedW || meta.height !== expectedH) {
    throw new Error(
      `${entry.file}: expected ${expectedW}x${expectedH}, got ${meta.width}x${meta.height}`,
    );
  }

  const paddedFrameW = ceil32(entry.frameW);
  const paddedFrameH = ceil32(entry.frameH);
  const needsPad =
    paddedFrameW !== entry.frameW || paddedFrameH !== entry.frameH;

  let imagePngName = entry.file;
  let imageW = meta.width;
  let imageH = meta.height;
  let rgba;

  if (needsPad) {
    // Build a new image by compositing each frame into its padded slot.
    const composites = [];
    const origRgba = await sharp(srcPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let fr = 0; fr < rows; fr++) {
      for (let fc = 0; fc < cols; fc++) {
        // Extract this frame from the original image.
        const left = fc * entry.frameW;
        const top = fr * entry.frameH;
        const frameBuf = await sharp(origRgba.data, {
          raw: {
            width: origRgba.info.width,
            height: origRgba.info.height,
            channels: 4,
          },
        })
          .extract({
            left,
            top,
            width: entry.frameW,
            height: entry.frameH,
          })
          .png()
          .toBuffer();
        composites.push({
          input: frameBuf,
          left: fc * paddedFrameW,
          top: fr * paddedFrameH,
        });
      }
    }
    imageW = cols * paddedFrameW;
    imageH = rows * paddedFrameH;
    const paddedBuf = await sharp({
      create: {
        width: imageW,
        height: imageH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(composites)
      .png()
      .toBuffer();

    const paddedName = entry.file.replace(/\.png$/i, ".padded.png");
    await fs.writeFile(path.join(DIR, paddedName), paddedBuf);
    imagePngName = paddedName;

    rgba = await sharp(paddedBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } else {
    rgba = await sharp(srcPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  }

  return {
    pngName: imagePngName,
    imageW,
    imageH,
    cols,
    rows,
    frameW: paddedFrameW,
    frameH: paddedFrameH,
    origFrameW: entry.frameW,
    origFrameH: entry.frameH,
    frames: entry.frames,
    rgba,
  };
}

// Flag a sub-tile (within a frame's padded slot) as opaque if any pixel
// inside the original (unpadded) frame area has non-zero alpha. Padded
// transparent strips stay empty.
function computePresence(prep) {
  const { rgba, imageW, cols, rows, frameW, frameH, origFrameW, origFrameH, frames } = prep;
  const subW = frameW / TILE;
  const subH = frameH / TILE;
  const present = [];
  for (let f = 0; f < frames; f++) {
    const grid = [];
    for (let r = 0; r < subH; r++) grid.push(new Array(subW).fill(false));
    present.push(grid);
  }
  const data = rgba.data;
  for (let y = 0; y < rgba.info.height; y++) {
    const fr = Math.floor(y / frameH);
    const yInFrame = y - fr * frameH;
    if (yInFrame >= origFrameH) continue; // padded strip
    const sr = Math.floor(yInFrame / TILE);
    for (let x = 0; x < rgba.info.width; x++) {
      const fc = Math.floor(x / frameW);
      const fIdx = fr * cols + fc;
      if (fIdx >= frames) continue;
      const xInFrame = x - fc * frameW;
      if (xInFrame >= origFrameW) continue; // padded strip
      const sc = Math.floor(xInFrame / TILE);
      const a = data[(y * imageW + x) * 4 + 3];
      if (a !== 0) present[fIdx][sr][sc] = true;
    }
  }
  return present;
}

function buildTsx({ name, prep, present }) {
  const { pngName, imageW, imageH, cols, rows, frameW, frameH, frames } = prep;
  const subW = frameW / TILE;
  const subH = frameH / TILE;
  const tilesetCols = cols * subW;
  const tilesetRows = rows * subH;
  const tilecount = tilesetCols * tilesetRows;

  // Tile id for frame f, sub-tile (sr, sc):
  //   fR = floor(f / cols), fC = f % cols
  //   row = fR*subH + sr, col = fC*subW + sc
  //   id = row * tilesetCols + col
  const tileId = (f, sr, sc) => {
    const fR = Math.floor(f / cols);
    const fC = f % cols;
    const row = fR * subH + sr;
    const col = fC * subW + sc;
    return row * tilesetCols + col;
  };

  const animations = [];
  if (frames > 1) {
    for (let sr = 0; sr < subH; sr++) {
      for (let sc = 0; sc < subW; sc++) {
        let anyOpaque = false;
        for (let f = 0; f < frames; f++) {
          if (present[f][sr][sc]) { anyOpaque = true; break; }
        }
        if (!anyOpaque) continue;
        const baseId = tileId(0, sr, sc);
        const frameTags = [];
        for (let f = 0; f < frames; f++) {
          const id = tileId(f, sr, sc);
          frameTags.push(`   <frame tileid="${id}" duration="${FRAME_MS}"/>`);
        }
        animations.push(
          ` <tile id="${baseId}">\n  <animation>\n${frameTags.join("\n")}\n  </animation>\n </tile>`,
        );
      }
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<tileset version="1.10" tiledversion="1.12.1" name="${name}" tilewidth="${TILE}" tileheight="${TILE}" tilecount="${tilecount}" columns="${tilesetCols}">
 <image source="${pngName}" width="${imageW}" height="${imageH}"/>
${animations.join("\n")}
</tileset>
`;
}

async function main() {
  let wrote = 0;
  let failed = 0;
  for (const entry of MANIFEST) {
    try {
      const prep = await preparePng(entry);
      const present = computePresence(prep);
      const name = entry.file.replace(/\.png$/i, "");
      const tsx = buildTsx({ name, prep, present });
      await fs.writeFile(path.join(DIR, `${name}.tsx`), tsx, "utf8");
      let opaque = 0;
      const subW = prep.frameW / TILE;
      const subH = prep.frameH / TILE;
      for (let sr = 0; sr < subH; sr++) {
        for (let sc = 0; sc < subW; sc++) {
          for (let f = 0; f < prep.frames; f++) {
            if (present[f][sr][sc]) { opaque++; break; }
          }
        }
      }
      const padded = prep.pngName !== entry.file ? " (padded)" : "";
      console.log(
        `${name}: ${prep.frames} frames, ${subW}x${subH} sub-grid, ${opaque}/${subW * subH} opaque${padded}`,
      );
      wrote++;
    } catch (err) {
      console.warn(`fail ${entry.file}: ${err.message}`);
      failed++;
    }
  }
  console.log(`\n${wrote} wrote, ${failed} failed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
