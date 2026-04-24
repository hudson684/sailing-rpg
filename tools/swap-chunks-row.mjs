// One-shot: swap chunks (1,2)↔(1,3) and (2,2)↔(2,3). The row-2 chunks
// (populated) move down to row 3; the row-3 ocean chunks move up.
// Also shifts any world-map entity tileX/tileY in npcs/enemies/nodes
// between the swapped chunks so global coords still land inside the
// content that moved.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const chunksDir = path.join(repoRoot, "maps", "chunks");
const gameDataDir = path.join(repoRoot, "src", "game", "data");

const CHUNK_TILES = 64;
const PAIRS = [
  [{ cx: 1, cy: 2 }, { cx: 1, cy: 3 }],
  [{ cx: 2, cy: 2 }, { cx: 2, cy: 3 }],
];

// Swap TMX file contents by going through a temp name.
for (const [a, b] of PAIRS) {
  const fa = path.join(chunksDir, `${a.cx}_${a.cy}.tmx`);
  const fb = path.join(chunksDir, `${b.cx}_${b.cy}.tmx`);
  const tmp = path.join(chunksDir, `__swap_${a.cx}_${a.cy}.tmx`);
  renameSync(fa, tmp);
  renameSync(fb, fa);
  renameSync(tmp, fb);
  console.log(`Swapped ${path.basename(fa)} ↔ ${path.basename(fb)}`);
}

// Shift entity tile coords that landed in either side of the swap.
const inRange = (tx, ty, cx, cy) =>
  tx >= cx * CHUNK_TILES && tx < (cx + 1) * CHUNK_TILES &&
  ty >= cy * CHUNK_TILES && ty < (cy + 1) * CHUNK_TILES;

// For each pair, compute dy in each direction. Both pairs here have dy=+/-1
// (one chunk = 64 tiles).
function shiftForPairs(node) {
  if (Array.isArray(node)) {
    for (const item of node) shiftForPairs(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.tileX === "number" && typeof node.tileY === "number") {
    for (const [a, b] of PAIRS) {
      if (inRange(node.tileX, node.tileY, a.cx, a.cy)) {
        node.tileY += (b.cy - a.cy) * CHUNK_TILES;
        break;
      }
      if (inRange(node.tileX, node.tileY, b.cx, b.cy)) {
        node.tileY += (a.cy - b.cy) * CHUNK_TILES;
        break;
      }
    }
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object") shiftForPairs(v);
  }
}

function isWorldMapNpc(npc) {
  if (!("map" in npc) || npc.map == null) return true;
  if (typeof npc.map === "string") return npc.map === "world";
  return false;
}

function updateNpcs(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  for (const npc of data.npcs ?? []) {
    if (!isWorldMapNpc(npc)) continue;
    shiftForPairs(npc);
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function updateInstances(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  for (const inst of data.instances ?? []) {
    if (inst.map && inst.map !== "world") continue;
    shiftForPairs(inst);
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

updateNpcs(path.join(gameDataDir, "npcs.json"));
updateInstances(path.join(gameDataDir, "enemies.json"));
updateInstances(path.join(gameDataDir, "nodes.json"));

console.log("Done. Remember to re-run node tools/build-maps.mjs.");
