// Horizontally mirror a ship .tmx: reverse each CSV row and XOR the Tiled
// horizontal-flip flag onto every non-zero gid.

import fs from "node:fs";

const [, , srcPath, dstPath] = process.argv;
if (!srcPath || !dstPath) {
  console.error("usage: node tools/mirror-ship-tmx.mjs <src.tmx> <dst.tmx>");
  process.exit(1);
}
const FLIP_H = 0x80000000n;
const src = fs.readFileSync(srcPath, "utf8");

const out = src.replace(
  /<data encoding="csv">\s*\n([\s\S]*?)\n\s*<\/data>/g,
  (_m, body) => {
    const rows = body.split(/\n/).map((r) => r.replace(/,\s*$/, "").trim()).filter((r) => r.length);
    const flipped = rows.map((r) => {
      const cells = r.split(",").map((s) => s.trim()).filter((s) => s.length);
      const rev = cells.reverse().map((s) => {
        const g = BigInt(s);
        if (g === 0n) return "0";
        return (g ^ FLIP_H).toString();
      });
      return rev.join(",");
    });
    const joined = flipped
      .map((r, i) => r + (i === flipped.length - 1 ? "" : ","))
      .join("\n");
    return `<data encoding="csv">\n${joined}\n</data>`;
  },
);

fs.writeFileSync(dstPath, out);
console.log(`wrote ${dstPath}`);
