// One-shot migration: merge the 2x2 groups of 32-tile chunks under
// maps/chunks/ into 64-tile chunks in place. Remaps per-chunk tileset
// firstgids into a unified list per merged chunk, preserves Tiled
// flip/rotate flag bits, unions layer names, and offsets object coords
// into their new quadrants. Updates maps/world.json (chunkSize, startChunk,
// authoredChunks) and removes the old 32-tile chunk files.
//
// Assumes the world is a clean grid starting at (0,0) whose dimensions are
// divisible by 2 in both axes. Bails out otherwise so we don't silently
// drop tiles.

import { readFileSync, writeFileSync, unlinkSync, existsSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const chunksDir = path.join(repoRoot, "maps", "chunks");
const manifestPath = path.join(repoRoot, "maps", "world.json");
const backupDir = path.join(repoRoot, "maps", "chunks.backup-32");

const OLD_SIZE = 32;
const NEW_SIZE = 64;
const FLAGS_MASK = 0xe0000000 >>> 0;
const ID_MASK = 0x1fffffff;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
});

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.chunkSize !== OLD_SIZE) {
  throw new Error(`Expected chunkSize=${OLD_SIZE} in manifest, got ${manifest.chunkSize}.`);
}

// Read + parse every authored chunk up front.
const byKey = new Map();
let maxCx = 0;
let maxCy = 0;
for (const key of manifest.authoredChunks) {
  const chunk = parseChunk(path.join(chunksDir, `${key}.tmx`));
  byKey.set(key, chunk);
  const [cx, cy] = key.split("_").map(Number);
  chunk.cx = cx;
  chunk.cy = cy;
  if (cx > maxCx) maxCx = cx;
  if (cy > maxCy) maxCy = cy;
}
const oldGridW = maxCx + 1;
const oldGridH = maxCy + 1;
if (oldGridW % 2 !== 0 || oldGridH % 2 !== 0) {
  throw new Error(`Old grid ${oldGridW}x${oldGridH} is not divisible by 2 — merge would drop chunks.`);
}
const newGridW = oldGridW / 2;
const newGridH = oldGridH / 2;

// Cache tilecount lookups per tsx source.
const tilecountCache = new Map();
function tilecountOf(sourceRel, chunkTmxDir) {
  if (tilecountCache.has(sourceRel)) return tilecountCache.get(sourceRel);
  const abs = path.resolve(chunkTmxDir, sourceRel);
  const xml = readFileSync(abs, "utf8");
  const m = xml.match(/\btilecount\s*=\s*"(\d+)"/);
  if (!m) throw new Error(`No tilecount in ${abs}`);
  const n = parseInt(m[1], 10);
  tilecountCache.set(sourceRel, n);
  return n;
}

// Stage merged chunks in memory first so we don't half-write then fail.
const mergedTmx = new Map();
const newAuthored = [];
let globalObjectId = 1;

for (let ncy = 0; ncy < newGridH; ncy++) {
  for (let ncx = 0; ncx < newGridW; ncx++) {
    const quadrants = [];
    for (let qy = 0; qy < 2; qy++) {
      for (let qx = 0; qx < 2; qx++) {
        const ocx = ncx * 2 + qx;
        const ocy = ncy * 2 + qy;
        const key = `${ocx}_${ocy}`;
        const chunk = byKey.get(key);
        if (!chunk) continue;
        quadrants.push({ qx, qy, chunk });
      }
    }
    if (quadrants.length === 0) continue;

    // Unified tileset list: iterate quadrants in order, dedupe by source.
    const unifiedTilesets = []; // { source, firstgid, tilecount }
    const sourceToIndex = new Map();
    for (const { chunk } of quadrants) {
      for (const ts of chunk.tilesets) {
        if (sourceToIndex.has(ts.source)) continue;
        const tc = tilecountOf(ts.source, chunksDir);
        sourceToIndex.set(ts.source, unifiedTilesets.length);
        unifiedTilesets.push({ source: ts.source, tilecount: tc, firstgid: 0 });
      }
    }
    // Assign new firstgids sequentially.
    {
      let nextGid = 1;
      for (const ts of unifiedTilesets) {
        ts.firstgid = nextGid;
        nextGid += ts.tilecount;
      }
    }

    // Union layer names in order-of-first-appearance.
    const layerOrder = [];
    const seenLayers = new Set();
    for (const { chunk } of quadrants) {
      for (const l of chunk.layers) {
        if (!seenLayers.has(l.name)) {
          seenLayers.add(l.name);
          layerOrder.push(l.name);
        }
      }
    }

    // Build 64x64 gid arrays per layer.
    const mergedLayers = layerOrder.map((name) => ({
      name,
      gids: new Uint32Array(NEW_SIZE * NEW_SIZE),
    }));
    const layerByName = new Map(mergedLayers.map((l) => [l.name, l]));

    for (const { qx, qy, chunk } of quadrants) {
      // Sort chunk tilesets by firstgid descending for gid->tileset lookup.
      const sorted = [...chunk.tilesets].sort((a, b) => b.firstgid - a.firstgid);
      const remap = (gid) => {
        if (gid === 0) return 0;
        const flags = gid & FLAGS_MASK;
        const bare = gid & ID_MASK;
        let ts = null;
        for (const cand of sorted) if (cand.firstgid <= bare) { ts = cand; break; }
        if (!ts) throw new Error(`No tileset for gid ${bare} in chunk ${chunk.cx}_${chunk.cy}`);
        const tileIndex = bare - ts.firstgid;
        const unifiedIdx = sourceToIndex.get(ts.source);
        const nts = unifiedTilesets[unifiedIdx];
        if (tileIndex < 0 || tileIndex >= nts.tilecount) {
          throw new Error(
            `Tile index ${tileIndex} out of range for ${ts.source} (count ${nts.tilecount}) in chunk ${chunk.cx}_${chunk.cy}`,
          );
        }
        return (flags | (nts.firstgid + tileIndex)) >>> 0;
      };

      const xOff = qx * OLD_SIZE;
      const yOff = qy * OLD_SIZE;
      for (const layer of chunk.layers) {
        const dst = layerByName.get(layer.name);
        for (let ly = 0; ly < OLD_SIZE; ly++) {
          for (let lx = 0; lx < OLD_SIZE; lx++) {
            const srcIdx = ly * OLD_SIZE + lx;
            const g = layer.gids[srcIdx];
            if (g === 0) continue;
            const dstIdx = (yOff + ly) * NEW_SIZE + (xOff + lx);
            dst.gids[dstIdx] = remap(g);
          }
        }
      }
    }

    // Objects: offset by quadrant pixel size, reassign ids.
    const mergedObjects = [];
    for (const { qx, qy, chunk } of quadrants) {
      const pxOff = { x: qx * OLD_SIZE * chunk.tileWidth, y: qy * OLD_SIZE * chunk.tileHeight };
      for (const obj of chunk.objects) {
        const attrs = { ...obj.attrs };
        if (attrs["@_x"] !== undefined) attrs["@_x"] = Number(attrs["@_x"]) + pxOff.x;
        if (attrs["@_y"] !== undefined) attrs["@_y"] = Number(attrs["@_y"]) + pxOff.y;
        attrs["@_id"] = globalObjectId++;
        // Remap gid attribute on object (tile objects) if present.
        if (attrs["@_gid"] !== undefined) {
          // Reuse the per-chunk remap logic.
          const sorted = [...chunk.tilesets].sort((a, b) => b.firstgid - a.firstgid);
          const gid = Number(attrs["@_gid"]) >>> 0;
          const flags = gid & FLAGS_MASK;
          const bare = gid & ID_MASK;
          const ts = sorted.find((t) => t.firstgid <= bare);
          if (!ts) throw new Error(`No tileset for object gid ${bare}`);
          const tileIndex = bare - ts.firstgid;
          const nts = unifiedTilesets[sourceToIndex.get(ts.source)];
          attrs["@_gid"] = ((flags | (nts.firstgid + tileIndex)) >>> 0).toString();
        }
        mergedObjects.push({ attrs, children: obj.children });
      }
    }

    // Pick a representative tileWidth/tileHeight (they're all 32).
    const { tileWidth, tileHeight } = quadrants[0].chunk;
    const tmx = buildChunkTmx({
      width: NEW_SIZE,
      height: NEW_SIZE,
      tileWidth,
      tileHeight,
      tilesets: unifiedTilesets,
      layers: mergedLayers,
      objects: mergedObjects,
    });
    const newKey = `${ncx}_${ncy}`;
    mergedTmx.set(newKey, tmx);
    newAuthored.push(newKey);
  }
}

// Back up old chunks dir, then write new files and refresh manifest.
if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
mkdirSync(backupDir, { recursive: true });
for (const key of manifest.authoredChunks) {
  const src = path.join(chunksDir, `${key}.tmx`);
  const dst = path.join(backupDir, `${key}.tmx`);
  renameSync(src, dst);
}

for (const [key, tmx] of mergedTmx) {
  writeFileSync(path.join(chunksDir, `${key}.tmx`), tmx);
}

const newStart = {
  cx: Math.floor(manifest.startChunk.cx / 2),
  cy: Math.floor(manifest.startChunk.cy / 2),
};
const newManifest = { ...manifest, chunkSize: NEW_SIZE, startChunk: newStart, authoredChunks: newAuthored };
writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2) + "\n");

console.log(
  `Merged ${manifest.authoredChunks.length} chunks (${oldGridW}x${oldGridH} @ ${OLD_SIZE}) ` +
    `into ${newAuthored.length} chunks (${newGridW}x${newGridH} @ ${NEW_SIZE}). ` +
    `Old chunks moved to ${path.relative(repoRoot, backupDir)}.`,
);

// ───────────────────────── helpers ─────────────────────────

function parseChunk(file) {
  const xml = readFileSync(file, "utf8");
  const tree = parser.parse(xml);
  const mapNode = findNode(tree, "map");
  const mapAttrs = mapNode[":@"];
  const mapChildren = mapNode.map;
  const tileWidth = parseInt(mapAttrs["@_tilewidth"], 10);
  const tileHeight = parseInt(mapAttrs["@_tileheight"], 10);
  const width = parseInt(mapAttrs["@_width"], 10);
  const height = parseInt(mapAttrs["@_height"], 10);
  if (width !== OLD_SIZE || height !== OLD_SIZE) {
    throw new Error(`Chunk ${file} has dimensions ${width}x${height}, expected ${OLD_SIZE}`);
  }

  const tilesets = [];
  const layers = [];
  const objects = [];
  for (const c of mapChildren) {
    if (c.tileset !== undefined) {
      const a = c[":@"];
      tilesets.push({ firstgid: parseInt(a["@_firstgid"], 10), source: a["@_source"] });
    } else if (c.layer !== undefined) {
      const a = c[":@"];
      const dataEntry = c.layer.find((x) => x.data);
      const dataAttrs = dataEntry[":@"];
      const encoding = dataAttrs["@_encoding"];
      const compression = dataAttrs["@_compression"];
      const text = (dataEntry.data[0]?.["#text"] ?? "").trim();
      if (encoding !== "base64") throw new Error(`Layer encoding ${encoding} unsupported in ${file}`);
      let bytes = text.length > 0 ? Buffer.from(text, "base64") : Buffer.alloc(0);
      if (compression === "zlib") bytes = inflateSync(bytes);
      else if (compression === "gzip") throw new Error(`gzip unsupported`);
      else if (compression) throw new Error(`Compression ${compression} unsupported`);
      const gids = new Uint32Array(bytes.length / 4);
      for (let i = 0; i < gids.length; i++) gids[i] = bytes.readUInt32LE(i * 4);
      if (gids.length !== 0 && gids.length !== OLD_SIZE * OLD_SIZE) {
        throw new Error(`Layer ${a["@_name"]} in ${file} has ${gids.length} tiles, expected ${OLD_SIZE * OLD_SIZE}`);
      }
      if (gids.length === 0) {
        // Empty layer — treat as all-zero full-sized layer.
        layers.push({ name: a["@_name"], gids: new Uint32Array(OLD_SIZE * OLD_SIZE) });
      } else {
        layers.push({ name: a["@_name"], gids });
      }
    } else if (c.objectgroup !== undefined) {
      for (const child of c.objectgroup) {
        if (child.object === undefined) continue;
        objects.push({ attrs: child[":@"], children: child.object });
      }
    }
  }
  return { tileWidth, tileHeight, tilesets, layers, objects };
}

function findNode(tree, name) {
  for (const n of tree) if (n[name] !== undefined) return n;
  throw new Error(`Missing node ${name}`);
}

function encodeLayer(gids) {
  const buf = Buffer.alloc(gids.length * 4);
  for (let i = 0; i < gids.length; i++) buf.writeUInt32LE(gids[i], i * 4);
  return deflateSync(buf).toString("base64");
}

function escapeAttr(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildChunkTmx({ width, height, tileWidth, tileHeight, tilesets, layers, objects }) {
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  const nextLayerId = layers.length + 2;
  const nextObjectId = objects.length + 1;
  out += `<map version="1.10" tiledversion="1.12.1" orientation="orthogonal" renderorder="right-down"`;
  out += ` width="${width}" height="${height}" tilewidth="${tileWidth}" tileheight="${tileHeight}"`;
  out += ` infinite="0" nextlayerid="${nextLayerId}" nextobjectid="${nextObjectId}">\n`;
  for (const ts of tilesets) {
    out += ` <tileset firstgid="${ts.firstgid}" source="${escapeAttr(ts.source)}"/>\n`;
  }
  let lid = 1;
  for (const layer of layers) {
    out += ` <layer id="${lid++}" name="${escapeAttr(layer.name)}" width="${width}" height="${height}">\n`;
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
        .map(([k, v]) => `${k.slice(2)}="${escapeAttr(v)}"`)
        .join(" ");
      const inner = (obj.children ?? []).filter(
        (ch) => ch.point !== undefined || ch.ellipse !== undefined || ch.properties !== undefined,
      );
      if (inner.length > 0) {
        out += `  <object ${attrStr}>\n`;
        for (const ch of inner) {
          if (ch.point !== undefined) out += `   <point/>\n`;
          else if (ch.ellipse !== undefined) out += `   <ellipse/>\n`;
          else if (ch.properties !== undefined) {
            out += `   <properties>\n`;
            for (const p of ch.properties) {
              if (p.property === undefined) continue;
              const pa = p[":@"];
              const typeAttr = pa["@_type"] ? ` type="${escapeAttr(pa["@_type"])}"` : "";
              out += `    <property name="${escapeAttr(pa["@_name"])}"${typeAttr} value="${escapeAttr(pa["@_value"])}"/>\n`;
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
