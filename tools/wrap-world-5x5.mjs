// One-shot migration: wrap the current 3x3 grid of 64-tile chunks with a
// border ring of ocean chunks, producing a 5x5 grid. The existing 9 chunks
// shift from (0..2, 0..2) to (1..3, 1..3); 16 new ocean-only chunks fill
// the border. Updates maps/world.json (startChunk, authoredChunks),
// maps/sailing-rpg.world, and shifts every world-map tileX/tileY in
// src/game/data/npcs.json|enemies.json|nodes.json by +64 tiles.
//
// Border chunks reference only `deep sea.tsx` at firstgid=1 and fill a
// single `ocean` layer with the most common deep-sea gid sampled from the
// current center chunk. Drop them into Tiled later to paint coastline/etc.

import { readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const mapsDir = path.join(repoRoot, "maps");
const chunksDir = path.join(mapsDir, "chunks");
const manifestPath = path.join(mapsDir, "world.json");
const worldPath = path.join(mapsDir, "sailing-rpg.world");
const gameDataDir = path.join(repoRoot, "src", "game", "data");

const OLD_SIZE_CHUNKS = 3;
const NEW_SIZE_CHUNKS = 5;
const CHUNK_TILES = 64;
const TILE_PX = 32;
const CHUNK_PX = CHUNK_TILES * TILE_PX;
const DEEP_SEA_SRC = "../themes/Sea Adventures/TiledMap Editor/Tilesets/deep sea.tsx";

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.chunkSize !== CHUNK_TILES) throw new Error(`Expected chunkSize=${CHUNK_TILES}`);
if (manifest.authoredChunks.length !== OLD_SIZE_CHUNKS * OLD_SIZE_CHUNKS) {
  throw new Error(`Expected ${OLD_SIZE_CHUNKS * OLD_SIZE_CHUNKS} authored chunks, got ${manifest.authoredChunks.length}`);
}

// 1. Sample an ocean gid from the center chunk (1,1 in old coords).
const oceanFillGid = sampleOceanGid(path.join(chunksDir, "1_1.tmx"));
console.log(`Using ocean fill gid ${oceanFillGid} (deep sea tile id ${oceanFillGid - 1}).`);

// 2. Rename existing 3x3 chunks from (cx,cy) → (cx+1, cy+1).
//    Do it via a two-phase rename through a temp suffix to avoid collisions.
for (const key of manifest.authoredChunks) {
  const src = path.join(chunksDir, `${key}.tmx`);
  const tmp = path.join(chunksDir, `${key}.tmx.__tmp`);
  renameSync(src, tmp);
}
const shifted = [];
for (const key of manifest.authoredChunks) {
  const [cx, cy] = key.split("_").map(Number);
  const ncx = cx + 1;
  const ncy = cy + 1;
  const tmp = path.join(chunksDir, `${key}.tmx.__tmp`);
  const dst = path.join(chunksDir, `${ncx}_${ncy}.tmx`);
  renameSync(tmp, dst);
  shifted.push(`${ncx}_${ncy}`);
}

// 3. Generate the 16 ocean border chunks.
const newKeys = [...shifted];
for (let cy = 0; cy < NEW_SIZE_CHUNKS; cy++) {
  for (let cx = 0; cx < NEW_SIZE_CHUNKS; cx++) {
    const isBorder = cx === 0 || cy === 0 || cx === NEW_SIZE_CHUNKS - 1 || cy === NEW_SIZE_CHUNKS - 1;
    if (!isBorder) continue;
    const key = `${cx}_${cy}`;
    const tmx = buildOceanChunkTmx(oceanFillGid);
    writeFileSync(path.join(chunksDir, `${key}.tmx`), tmx);
    newKeys.push(key);
  }
}
newKeys.sort(keyCmp);

// 4. Update maps/world.json.
const newManifest = {
  ...manifest,
  startChunk: { cx: manifest.startChunk.cx + 1, cy: manifest.startChunk.cy + 1 },
  authoredChunks: newKeys,
};
writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2) + "\n");

// 5. Regenerate maps/sailing-rpg.world.
writeFileSync(worldPath, buildWorldFile(NEW_SIZE_CHUNKS));

// 6. Shift tileX/tileY in npcs/enemies/nodes data. World map only.
const SHIFT = CHUNK_TILES;
shiftNpcsFile(path.join(gameDataDir, "npcs.json"));
shiftInstancesFile(path.join(gameDataDir, "enemies.json"));
shiftInstancesFile(path.join(gameDataDir, "nodes.json"));

console.log(
  `Wrapped to ${NEW_SIZE_CHUNKS}x${NEW_SIZE_CHUNKS}. Shifted startChunk to (${newManifest.startChunk.cx},${newManifest.startChunk.cy}); ` +
    `shifted tileX/tileY in npcs/enemies/nodes by +${SHIFT}.`,
);

// ───────────────────────── helpers ─────────────────────────

function keyCmp(a, b) {
  const [ax, ay] = a.split("_").map(Number);
  const [bx, by] = b.split("_").map(Number);
  return ay - by || ax - bx;
}

function sampleOceanGid(file) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", preserveOrder: true });
  const xml = readFileSync(file, "utf8");
  const tree = parser.parse(xml);
  const mapNode = tree.find((n) => n.map !== undefined).map;
  // Confirm deep sea is at firstgid=1 so gid values are directly reusable.
  const tsNodes = [];
  for (const c of mapNode) {
    if (c.tileset === undefined) continue;
    tsNodes.push({ source: c[":@"]["@_source"], firstgid: Number(c[":@"]["@_firstgid"]) });
  }
  const deepSea = tsNodes.find((t) => t.source === DEEP_SEA_SRC);
  if (!deepSea) throw new Error(`${file} has no deep sea tileset reference`);
  if (deepSea.firstgid !== 1) {
    throw new Error(`deep sea tileset in ${file} is at firstgid=${deepSea.firstgid}, expected 1`);
  }

  let oceanLayer = null;
  for (const c of mapNode) {
    if (c.layer === undefined) continue;
    if (c[":@"]["@_name"] === "ocean") {
      oceanLayer = c.layer;
      break;
    }
  }
  if (!oceanLayer) throw new Error(`${file} has no 'ocean' layer`);
  const dataEntry = oceanLayer.find((x) => x.data);
  const text = (dataEntry.data[0]?.["#text"] ?? "").trim();
  let bytes = Buffer.from(text, "base64");
  if (dataEntry[":@"]["@_compression"] === "zlib") bytes = inflateSync(bytes);
  const counts = new Map();
  for (let i = 0; i < bytes.length; i += 4) {
    const gid = bytes.readUInt32LE(i) & 0x1fffffff;
    if (gid === 0) continue;
    if (gid < 1 || gid > 225) continue; // deep sea tileset range
    counts.set(gid, (counts.get(gid) ?? 0) + 1);
  }
  if (counts.size === 0) throw new Error(`No deep-sea gids found in ${file} ocean layer`);
  let bestGid = 0;
  let bestCount = -1;
  for (const [g, c] of counts) if (c > bestCount) { bestGid = g; bestCount = c; }
  return bestGid;
}

function buildOceanChunkTmx(fillGid) {
  const tileCount = CHUNK_TILES * CHUNK_TILES;
  const buf = Buffer.alloc(tileCount * 4);
  for (let i = 0; i < tileCount; i++) buf.writeUInt32LE(fillGid, i * 4);
  const encoded = deflateSync(buf).toString("base64");
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  out += `<map version="1.10" tiledversion="1.12.1" orientation="orthogonal" renderorder="right-down"`;
  out += ` width="${CHUNK_TILES}" height="${CHUNK_TILES}" tilewidth="${TILE_PX}" tileheight="${TILE_PX}"`;
  out += ` infinite="0" nextlayerid="3" nextobjectid="1">\n`;
  out += ` <tileset firstgid="1" source="${DEEP_SEA_SRC}"/>\n`;
  out += ` <layer id="1" name="ocean" width="${CHUNK_TILES}" height="${CHUNK_TILES}">\n`;
  out += `  <data encoding="base64" compression="zlib">\n`;
  out += `   ${encoded}\n`;
  out += `  </data>\n`;
  out += ` </layer>\n`;
  out += `</map>\n`;
  return out;
}

function buildWorldFile(sizeChunks) {
  const entries = [];
  for (let cy = 0; cy < sizeChunks; cy++) {
    for (let cx = 0; cx < sizeChunks; cx++) {
      entries.push(
        `        { "fileName": "chunks/${cx}_${cy}.tmx", "x": ${cx * CHUNK_PX}, "y": ${cy * CHUNK_PX}, "width": ${CHUNK_PX}, "height": ${CHUNK_PX} }`,
      );
    }
  }
  return `{\n    "type": "world",\n    "maps": [\n${entries.join(",\n")}\n    ],\n    "onlyShowAdjacentMaps": false\n}\n`;
}

function isWorldMapNpc(npc) {
  if (!("map" in npc)) return true;
  if (npc.map === null || npc.map === undefined) return true;
  if (typeof npc.map === "string") return npc.map === "world";
  // Any object-shaped map field (e.g. {interior:"cabin"}) means non-world.
  return false;
}

function shiftTileCoordsDeep(node) {
  if (Array.isArray(node)) {
    for (const item of node) shiftTileCoordsDeep(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.tileX === "number") node.tileX += SHIFT;
  if (typeof node.tileY === "number") node.tileY += SHIFT;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object") shiftTileCoordsDeep(v);
  }
}

function shiftNpcsFile(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  for (const npc of data.npcs ?? []) {
    if (!isWorldMapNpc(npc)) continue;
    shiftTileCoordsDeep(npc);
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function shiftInstancesFile(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  for (const inst of data.instances ?? []) {
    if (inst.map && inst.map !== "world") continue;
    if (typeof inst.tileX === "number") inst.tileX += SHIFT;
    if (typeof inst.tileY === "number") inst.tileY += SHIFT;
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
