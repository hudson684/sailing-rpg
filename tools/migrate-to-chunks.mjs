// One-shot migration: slice maps/world.tmx (single big TMX) into
// maps/chunks/<cx>_<cy>.tmx pieces at CHUNK_SIZE = 32, write
// maps/world.json manifest, then delete the old maps/world.tmx.
//
// Safe-ish to re-run if a fresh world.tmx is dropped in later.

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const srcTmx = path.join(repoRoot, "maps", "world.tmx");
const chunksDir = path.join(repoRoot, "maps", "chunks");
const manifestPath = path.join(repoRoot, "maps", "world.json");

const CHUNK_SIZE = 32;
const OCEAN_GID = 61; // tile index 60 = plain deep-water tile in the Roguelike sheet

if (!existsSync(srcTmx)) {
  console.log(`No ${path.relative(repoRoot, srcTmx)} — nothing to migrate.`);
  process.exit(0);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
});

const xml = readFileSync(srcTmx, "utf8");
const tree = parser.parse(xml);
const mapNode = findNode(tree, "map");
const mapAttrs = mapNode[":@"];
const mapChildren = mapNode.map;

const width = int(mapAttrs["@_width"]);
const height = int(mapAttrs["@_height"]);
const tileWidth = int(mapAttrs["@_tilewidth"]);
const tileHeight = int(mapAttrs["@_tileheight"]);

const tilesetEntry = mapChildren.find((c) => c.tileset !== undefined);
const tilesetAttrs = tilesetEntry[":@"];
const tilesetSource = tilesetAttrs["@_source"];
const firstGid = int(tilesetAttrs["@_firstgid"]);
if (!tilesetSource) throw new Error("Expected external TSX reference in world.tmx.");

const layers = [];
for (const c of mapChildren) {
  if (c.layer === undefined) continue;
  const attrs = c[":@"];
  const dataEntry = c.layer.find((x) => x.data);
  const dataAttrs = dataEntry[":@"];
  const encoding = dataAttrs["@_encoding"];
  const compression = dataAttrs["@_compression"];
  const text = (dataEntry.data[0]?.["#text"] ?? "").trim();
  if (encoding !== "base64") throw new Error(`Layer encoding ${encoding} unsupported`);
  let bytes = Buffer.from(text, "base64");
  if (compression === "zlib") bytes = inflateSync(bytes);
  else if (compression) throw new Error(`Compression ${compression} unsupported`);
  const gids = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < gids.length; i++) gids[i] = bytes.readUInt32LE(i * 4);
  layers.push({ name: attrs["@_name"], gids });
}

const objectGroupEntry = mapChildren.find((c) => c.objectgroup !== undefined);
const allObjects = [];
if (objectGroupEntry) {
  for (const child of objectGroupEntry.objectgroup) {
    if (child.object === undefined) continue;
    allObjects.push({ attrs: child[":@"], children: child.object });
  }
}

const chunksX = Math.ceil(width / CHUNK_SIZE);
const chunksY = Math.ceil(height / CHUNK_SIZE);

mkdirSync(chunksDir, { recursive: true });

const authoredChunks = [];
let startChunk = null;
let objectIdCounter = 1;

for (let cy = 0; cy < chunksY; cy++) {
  for (let cx = 0; cx < chunksX; cx++) {
    const chunkLayers = [];
    for (const layer of layers) {
      const chunkGids = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
      // Pad ocean on the ground layer only; other layers stay empty (gid 0).
      if (layer.name === "ground") chunkGids.fill(OCEAN_GID);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const gx = cx * CHUNK_SIZE + lx;
          const gy = cy * CHUNK_SIZE + ly;
          if (gx >= width || gy >= height) continue;
          chunkGids[ly * CHUNK_SIZE + lx] = layer.gids[gy * width + gx];
        }
      }
      chunkLayers.push({ name: layer.name, gids: chunkGids });
    }

    const chunkObjects = [];
    for (const obj of allObjects) {
      const gx = num(obj.attrs["@_x"] ?? 0);
      const gy = num(obj.attrs["@_y"] ?? 0);
      const tx = Math.floor(gx / tileWidth);
      const ty = Math.floor(gy / tileHeight);
      const oCx = Math.floor(tx / CHUNK_SIZE);
      const oCy = Math.floor(ty / CHUNK_SIZE);
      if (oCx !== cx || oCy !== cy) continue;

      // Rewrite to local chunk coords.
      const localAttrs = { ...obj.attrs };
      localAttrs["@_x"] = gx - cx * CHUNK_SIZE * tileWidth;
      localAttrs["@_y"] = gy - cy * CHUNK_SIZE * tileHeight;
      localAttrs["@_id"] = objectIdCounter++;
      chunkObjects.push({ attrs: localAttrs, children: obj.children });

      if (obj.attrs["@_type"] === "ship_spawn") startChunk = { cx, cy };
    }

    const tmxOut = buildChunkTmx({
      width: CHUNK_SIZE,
      height: CHUNK_SIZE,
      tileWidth,
      tileHeight,
      tilesetSource: `../tilesets/${path.basename(tilesetSource)}`,
      firstGid,
      layers: chunkLayers,
      objects: chunkObjects,
    });
    const chunkFile = path.join(chunksDir, `${cx}_${cy}.tmx`);
    writeFileSync(chunkFile, tmxOut);
    authoredChunks.push(`${cx}_${cy}`);
  }
}

if (!startChunk) throw new Error("Could not locate ship_spawn in any chunk.");

writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      chunkSize: CHUNK_SIZE,
      tileWidth,
      tileHeight,
      oceanGid: OCEAN_GID,
      tilesetSource: `tilesets/${path.basename(tilesetSource)}`,
      startChunk,
      authoredChunks,
    },
    null,
    2,
  ) + "\n",
);

unlinkSync(srcTmx);
console.log(
  `Wrote ${authoredChunks.length} chunks under maps/chunks/, manifest at maps/world.json (start=${startChunk.cx},${startChunk.cy}). Deleted legacy world.tmx.`,
);

// ───────────────────────── helpers ─────────────────────────

function findNode(tree, name) {
  for (const n of tree) if (n[name] !== undefined) return n;
  throw new Error(`Missing node ${name}`);
}
function int(v) {
  return parseInt(v, 10);
}
function num(v) {
  return Number(v);
}

function encodeLayer(gids) {
  const buf = Buffer.alloc(gids.length * 4);
  for (let i = 0; i < gids.length; i++) buf.writeUInt32LE(gids[i], i * 4);
  return deflateSync(buf).toString("base64");
}

function buildChunkTmx({ width, height, tileWidth, tileHeight, tilesetSource, firstGid, layers, objects }) {
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  out += `<map version="1.10" tiledversion="1.12.1" orientation="orthogonal" renderorder="right-down"`;
  out += ` width="${width}" height="${height}" tilewidth="${tileWidth}" tileheight="${tileHeight}"`;
  out += ` infinite="0" nextlayerid="${layers.length + 2}" nextobjectid="${objects.length + 1}">\n`;
  out += ` <tileset firstgid="${firstGid}" source="${tilesetSource}"/>\n`;
  let lid = 1;
  for (const layer of layers) {
    out += ` <layer id="${lid++}" name="${layer.name}" width="${width}" height="${height}">\n`;
    out += `  <data encoding="base64" compression="zlib">\n`;
    out += `   ${encodeLayer(layer.gids)}\n`;
    out += `  </data>\n`;
    out += ` </layer>\n`;
  }
  if (objects.length > 0) {
    out += ` <objectgroup id="${lid}" name="objects">\n`;
    for (const obj of objects) {
      const a = obj.attrs;
      const attrStr = Object.entries(a)
        .filter(([k]) => k.startsWith("@_"))
        .map(([k, v]) => `${k.slice(2)}="${v}"`)
        .join(" ");
      if (obj.children && obj.children.length > 0) {
        out += `  <object ${attrStr}>\n`;
        for (const ch of obj.children) {
          if (ch.point !== undefined) out += `   <point/>\n`;
          else if (ch.ellipse !== undefined) out += `   <ellipse/>\n`;
          else if (ch.properties !== undefined) {
            out += `   <properties>\n`;
            for (const p of ch.properties) {
              if (p.property === undefined) continue;
              const pa = p[":@"];
              const typeAttr = pa["@_type"] ? ` type="${pa["@_type"]}"` : "";
              out += `    <property name="${pa["@_name"]}"${typeAttr} value="${pa["@_value"]}"/>\n`;
            }
            out += `   </properties>\n`;
          }
        }
        out += `  </object>\n`;
      } else {
        out += `  <object ${attrStr}/>\n`;
      }
    }
    out += ` </objectgroup>\n`;
  }
  out += `</map>\n`;
  return out;
}
