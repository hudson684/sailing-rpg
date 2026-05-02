// One-shot: resize tavern_rusty_anchor.tmx from 20x14 to 64x64.
// Anchors existing content at top-left; pads with 0 tiles. Run once:
//   node tools/resize-tavern.mjs
// Then: npm run maps
import fs from "node:fs";
import path from "node:path";

const TMX = path.resolve("maps/interiors/tavern_rusty_anchor.tmx");
const OLD_W = 20;
const OLD_H = 14;
const NEW_W = 64;
const NEW_H = 64;

let src = fs.readFileSync(TMX, "utf8");

// Bump map width/height.
src = src.replace(
  /(<map\b[^>]*?)\swidth="\d+"\s+height="\d+"/,
  `$1 width="${NEW_W}" height="${NEW_H}"`,
);

// Resize every <layer> width/height.
src = src.replace(
  /(<layer\b[^>]*?)\swidth="\d+"\s+height="\d+"/g,
  `$1 width="${NEW_W}" height="${NEW_H}"`,
);

// Resize every CSV data block.
src = src.replace(
  /(<data\s+encoding="csv">)([\s\S]*?)(<\/data>)/g,
  (_m, open, body, close) => {
    const flat = body
      .split(/[,\n\r]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number(s));
    if (flat.length !== OLD_W * OLD_H) {
      throw new Error(
        `unexpected csv length ${flat.length}, expected ${OLD_W * OLD_H}`,
      );
    }
    const rows = [];
    for (let y = 0; y < NEW_H; y++) {
      const row = new Array(NEW_W).fill(0);
      if (y < OLD_H) {
        for (let x = 0; x < OLD_W; x++) {
          row[x] = flat[y * OLD_W + x];
        }
      }
      // Match the existing format: every row except the last ends with ','.
      const isLast = y === NEW_H - 1;
      rows.push(row.join(",") + (isLast ? "" : ","));
    }
    return `${open}\n${rows.join("\n")}\n${close}`;
  },
);

fs.writeFileSync(TMX, src, "utf8");
console.log(`Resized ${TMX} to ${NEW_W}x${NEW_H}.`);
