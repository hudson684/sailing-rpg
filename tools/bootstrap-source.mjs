// One-shot bootstrap: reads the initial Kenney-derived TMX (inline tileset,
// old layer names) and produces the proper authored sources:
//   maps/tilesets/roguelike.tsx  — external tileset with per-tile properties
//   maps/world.tmx               — rewritten to reference the external TSX,
//                                  renamed layers, and an `objects` layer with
//                                  ship_spawn + dock + item_spawn points.
//
// Run once (already executed during initial setup). Safe to re-run; it
// regenerates the source files from the seed TMX under maps/ plus the
// existing property data embedded in that TMX.

import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const srcTmx = path.join(repoRoot, "maps", "world.tmx");
const outTsx = path.join(repoRoot, "maps", "tilesets", "roguelike.tsx");

const LAYER_RENAME = {
  "Ground/terrain": "ground",
  "Ground overlay": "overlay",
  Objects: "props_low",
  "Doors/windows/roof": "props_high",
  "Roof object": "roof",
};
const COLLISION_LAYER_NAMES = new Set(["props_low", "props_high", "roof"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  trimValues: false,
});
const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  format: true,
  indentBy: " ",
  suppressEmptyNode: true,
});

const xml = readFileSync(srcTmx, "utf8");
const tree = parser.parse(xml);
const mapNode = findNode(tree, "map");
const mapChildren = mapNode.map;
const mapAttrs = mapNode[":@"];

const width = parseInt(mapAttrs["@_width"], 10);
const height = parseInt(mapAttrs["@_height"], 10);

// 1. Extract inline tileset info from the seed TMX
const tilesetEntry = mapChildren.find((c) => c.tileset);
const tilesetAttrs = tilesetEntry[":@"];
const firstGid = parseInt(tilesetAttrs["@_firstgid"], 10);
const tilesetChildren = tilesetEntry.tileset;

// Per-tile properties already defined on the tileset (currently: water markers)
const tilesetTileEntries = tilesetChildren.filter((c) => c.tile);
const waterTileIds = new Set();
for (const t of tilesetTileEntries) {
  const attrs = t[":@"];
  const tid = parseInt(attrs["@_id"], 10);
  const propsEntry = t.tile.find((x) => x.properties);
  if (!propsEntry) continue;
  for (const p of propsEntry.properties) {
    const pa = p[":@"];
    if (p.property !== undefined && pa?.["@_name"] === "water") waterTileIds.add(tid);
  }
}

// 2. Decode each layer's GIDs and rename layers
const layerEntries = mapChildren.filter((c) => c.layer);
const layers = [];
for (const l of layerEntries) {
  const attrs = l[":@"];
  const name = attrs["@_name"];
  const renamed = LAYER_RENAME[name] ?? name;
  const dataEntry = l.layer.find((x) => x.data);
  const dataAttrs = dataEntry[":@"];
  const encoding = dataAttrs["@_encoding"];
  const compression = dataAttrs["@_compression"];
  const text = (dataEntry.data[0]?.["#text"] ?? "").trim();
  if (encoding !== "base64") throw new Error(`Layer ${name} uses unexpected encoding ${encoding}`);
  let bytes = Buffer.from(text, "base64");
  if (compression === "zlib") bytes = inflateSync(bytes);
  else if (compression) throw new Error(`Unsupported compression: ${compression}`);
  const gids = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
  layers.push({ name: renamed, originalName: name, width, height, gids });
}

// 3. Derive `collides` set: union of non-zero tile IDs across collision layers
const collidesTileIds = new Set();
for (const layer of layers) {
  if (!COLLISION_LAYER_NAMES.has(layer.name)) continue;
  for (const gid of layer.gids) {
    if (gid === 0) continue;
    collidesTileIds.add(gid - firstGid);
  }
}

// 4. Emit external TSX with water + collides properties
const tsxXml = buildExternalTsx({
  name: tilesetAttrs["@_name"],
  tileWidth: parseInt(tilesetAttrs["@_tilewidth"], 10),
  tileHeight: parseInt(tilesetAttrs["@_tileheight"], 10),
  spacing: parseInt(tilesetAttrs["@_spacing"] ?? "0", 10),
  margin: parseInt(tilesetAttrs["@_margin"] ?? "0", 10),
  columns: parseInt(tilesetAttrs["@_columns"], 10),
  tileCount: parseInt(tilesetAttrs["@_tilecount"], 10),
  imageSource: "roguelikeSheet.png",
  imageWidth: 968,
  imageHeight: 526,
  waterTileIds,
  collidesTileIds,
});
writeFileSync(outTsx, tsxXml);

// 5. Rewrite maps/world.tmx: external TSX ref + renamed layers + objects layer
const newTmx = buildRewrittenTmx({
  mapAttrs,
  firstGid,
  tsxSource: "tilesets/roguelike.tsx",
  layers,
  waterTileIds,
  collidesTileIds,
});
writeFileSync(srcTmx, newTmx);

console.log(
  `Wrote roguelike.tsx (${waterTileIds.size} water, ${collidesTileIds.size} collides) and refactored world.tmx (${layers.length} layers).`,
);

// ───────────────────────────── helpers ─────────────────────────────

function findNode(tree, name) {
  for (const n of tree) if (n[name] !== undefined) return n;
  throw new Error(`Missing node ${name}`);
}

import { deflateSync } from "node:zlib";

function encodeLayerZlib(gids) {
  const buf = Buffer.alloc(gids.length * 4);
  for (let i = 0; i < gids.length; i++) buf.writeUInt32LE(gids[i], i * 4);
  return deflateSync(buf).toString("base64");
}

function buildExternalTsx(t) {
  const tiles = [];
  const ids = new Set([...t.waterTileIds, ...t.collidesTileIds]);
  const sorted = [...ids].sort((a, b) => a - b);
  for (const id of sorted) {
    const props = [];
    if (t.waterTileIds.has(id)) props.push({ name: "water", type: "bool", value: "true" });
    if (t.collidesTileIds.has(id)) props.push({ name: "collides", type: "bool", value: "true" });
    tiles.push({ id, props });
  }
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  out += `<tileset version="1.10" tiledversion="1.12.1" name="${t.name}" tilewidth="${t.tileWidth}" tileheight="${t.tileHeight}" spacing="${t.spacing}" margin="${t.margin}" tilecount="${t.tileCount}" columns="${t.columns}">\n`;
  out += ` <image source="${t.imageSource}" width="${t.imageWidth}" height="${t.imageHeight}"/>\n`;
  for (const tile of tiles) {
    out += ` <tile id="${tile.id}">\n`;
    out += `  <properties>\n`;
    for (const p of tile.props) {
      out += `   <property name="${p.name}" type="${p.type}" value="${p.value}"/>\n`;
    }
    out += `  </properties>\n`;
    out += ` </tile>\n`;
  }
  out += `</tileset>\n`;
  return out;
}

function buildRewrittenTmx({ mapAttrs, firstGid, tsxSource, layers, waterTileIds }) {
  const w = parseInt(mapAttrs["@_width"], 10);
  const h = parseInt(mapAttrs["@_height"], 10);

  // Find a good ship_spawn: first 3×2 water block with walkable land west of it.
  // Walkable land = non-water, non-collides in the corresponding ground-derived mask.
  const ground = layers.find((l) => l.name === "ground");
  const waterMask = new Uint8Array(w * h);
  for (let i = 0; i < ground.gids.length; i++) {
    const gid = ground.gids[i];
    if (gid && waterTileIds.has(gid - firstGid)) waterMask[i] = 1;
  }
  // Collision mask: any tile present in a collision layer at that cell
  const collideMask = new Uint8Array(w * h);
  for (const layer of layers) {
    if (!COLLISION_LAYER_NAMES.has(layer.name)) continue;
    for (let i = 0; i < layer.gids.length; i++) if (layer.gids[i] !== 0) collideMask[i] = 1;
  }

  let shipSpawn = null;
  outer: for (let y = 0; y < h - 1; y++) {
    for (let x = 1; x < w - 2; x++) {
      let ok = true;
      for (let dx = 0; dx < 3 && ok; dx++)
        for (let dy = 0; dy < 2 && ok; dy++)
          if (!waterMask[(y + dy) * w + (x + dx)]) ok = false;
      if (!ok) continue;
      const lx = x - 1;
      const landOk =
        !waterMask[y * w + lx] &&
        !collideMask[y * w + lx] &&
        !waterMask[(y + 1) * w + lx] &&
        !collideMask[(y + 1) * w + lx];
      if (landOk) {
        shipSpawn = { tx: x, ty: y, heading: "E", dockX: lx, dockY: y };
        break outer;
      }
    }
  }
  if (!shipSpawn) throw new Error("No ship spawn location found in world.tmx");

  // Scatter item_spawn points — reuse the dock as flood-fill seed.
  const reachable = new Uint8Array(w * h);
  const stack = [[shipSpawn.dockX, shipSpawn.dockY]];
  reachable[shipSpawn.dockY * w + shipSpawn.dockX] = 1;
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const i = ny * w + nx;
      if (reachable[i] || waterMask[i] || collideMask[i]) continue;
      reachable[i] = 1;
      stack.push([nx, ny]);
    }
  }

  const itemSpawns = [
    { itemId: "rope", quantity: 1 },
    { itemId: "rope", quantity: 2 },
    { itemId: "plank", quantity: 1 },
    { itemId: "plank", quantity: 3 },
    { itemId: "fish", quantity: 1 },
    { itemId: "coin", quantity: 5 },
    { itemId: "coin", quantity: 12 },
    { itemId: "compass", quantity: 1 },
  ];
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const candidates = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (reachable[y * w + x]) candidates.push({ x, y });
  const used = new Set();
  const placed = [];
  for (const spawn of itemSpawns) {
    for (let tries = 0; tries < 40; tries++) {
      const c = candidates[Math.floor(rand() * candidates.length)];
      const k = `${c.x},${c.y}`;
      if (used.has(k)) continue;
      used.add(k);
      placed.push({ ...spawn, x: c.x, y: c.y });
      break;
    }
  }

  // Emit TMX
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  out += `<map version="1.10" tiledversion="1.12.1" orientation="orthogonal" renderorder="right-down"`;
  out += ` width="${w}" height="${h}" tilewidth="${mapAttrs["@_tilewidth"]}" tileheight="${mapAttrs["@_tileheight"]}"`;
  out += ` infinite="0" nextlayerid="${layers.length + 2}" nextobjectid="${placed.length + 3}">\n`;
  out += ` <tileset firstgid="${firstGid}" source="${tsxSource}"/>\n`;

  let layerId = 1;
  for (const layer of layers) {
    out += ` <layer id="${layerId++}" name="${layer.name}" width="${w}" height="${h}">\n`;
    out += `  <data encoding="base64" compression="zlib">\n`;
    out += `   ${encodeLayerZlib(layer.gids)}\n`;
    out += `  </data>\n`;
    out += ` </layer>\n`;
  }

  let objectId = 1;
  out += ` <objectgroup id="${layerId}" name="objects">\n`;
  // Tiled pixel coords: x = tx*tileWidth, y = ty*tileHeight (top-left corner)
  const tw = parseInt(mapAttrs["@_tilewidth"], 10);
  const th = parseInt(mapAttrs["@_tileheight"], 10);

  out += `  <object id="${objectId++}" name="ship_spawn" type="ship_spawn" x="${shipSpawn.tx * tw}" y="${shipSpawn.ty * th}" width="${3 * tw}" height="${2 * th}">\n`;
  out += `   <properties>\n`;
  out += `    <property name="heading" value="${shipSpawn.heading}"/>\n`;
  out += `   </properties>\n`;
  out += `  </object>\n`;

  out += `  <object id="${objectId++}" name="dock" type="dock" x="${shipSpawn.dockX * tw}" y="${shipSpawn.dockY * th}" width="${tw}" height="${th}"/>\n`;

  for (const s of placed) {
    out += `  <object id="${objectId++}" type="item_spawn" x="${s.x * tw + tw / 2}" y="${s.y * th + th / 2}">\n`;
    out += `   <point/>\n`;
    out += `   <properties>\n`;
    out += `    <property name="itemId" value="${s.itemId}"/>\n`;
    out += `    <property name="quantity" type="int" value="${s.quantity}"/>\n`;
    out += `   </properties>\n`;
    out += `  </object>\n`;
  }
  out += ` </objectgroup>\n`;
  out += `</map>\n`;
  return out;
}
