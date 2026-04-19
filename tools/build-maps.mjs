// Production map build: TMX + external TSX → TMJ with embedded tileset.
// Run via `npm run maps`. Also copies referenced tileset images into
// public/maps/ so the browser can fetch them alongside the TMJ.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { stampUidsInDir } from "./stamp-uids.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const mapsDir = path.join(repoRoot, "maps");
const chunksDir = path.join(mapsDir, "chunks");
const interiorsDir = path.join(mapsDir, "interiors");
const shipsDir = path.join(repoRoot, "ships");
const publicMapsDir = path.join(repoRoot, "public", "maps");

export { mapsDir, publicMapsDir, shipsDir };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
});

// Disambiguate output tileset image filenames when two source TSX files
// reference different images with the same basename (e.g. each theme pack
// ships its own `tilesets.png`). Keyed by the source image's absolute path
// so the same source always resolves to the same output name within a build.
// First imageAbs to claim a basename keeps it; later collisions get a
// deterministic suffix derived from the source's parent directory.
const imageOutRegistry = new Map(); // imageAbs (normalized) → outImage (e.g. "tilesets/foo.png")
const basenameOwners = new Map(); // basename → imageAbs (the first absolute path that claimed this basename)

function resolveOutImage(imageAbs) {
  const key = path.normalize(imageAbs);
  const cached = imageOutRegistry.get(key);
  if (cached) return cached;
  const base = path.basename(key);
  const owner = basenameOwners.get(base);
  let outName;
  if (!owner || owner === key) {
    basenameOwners.set(base, key);
    outName = base;
  } else {
    // Collision: derive a short stable suffix from the parent dir name so the
    // output filename stays human-readable. Sanitize for filesystem safety.
    const parent = path.basename(path.dirname(key)).replace(/[^a-zA-Z0-9_-]+/g, "_");
    const parsed = path.parse(base);
    outName = `${parsed.name}__${parent}${parsed.ext}`;
    // If that somehow also collides with a prior different source, keep adding
    // parent dirs until unique. Defensive; rare in practice.
    let probe = outName;
    let up = path.dirname(path.dirname(key));
    while (basenameOwners.has(probe) && basenameOwners.get(probe) !== key) {
      const next = path.basename(up).replace(/[^a-zA-Z0-9_-]+/g, "_");
      probe = `${parsed.name}__${next}_${probe}`;
      up = path.dirname(up);
      if (up === path.dirname(up)) break;
    }
    outName = probe;
    basenameOwners.set(outName, key);
  }
  const outImage = `tilesets/${outName}`;
  imageOutRegistry.set(key, outImage);
  return outImage;
}

// Run as CLI only when invoked directly (not when imported by the Vite plugin).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const check = process.argv.includes("--check");
  if (check) {
    // Fast CI mode: verify every spawn object has a uid and there are no
    // duplicates. Skips the TMX→TMJ emit so CI can run this cheaply.
    const chunkReports = stampUidsInDir(chunksDir, { check: true });
    const interiorReports = stampUidsInDir(interiorsDir, { check: true });
    const reports = [...chunkReports, ...interiorReports];
    const total = reports.reduce((n, r) => n + r.existingUids.length, 0);
    console.log(
      `maps:check ok — ${total} uid(s) across ${chunkReports.length} chunk(s) + ${interiorReports.length} interior(s).`,
    );
  } else {
    buildAll();
  }
}

/** Read & parse maps/world.json. Throws if missing. */
export function readManifest() {
  const manifestPath = path.join(mapsDir, "world.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing maps/world.json manifest — run tools/migrate-to-chunks.mjs first.`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

/** Write public/maps/world.json with the given tileset-image union and
 *  optional interior/ship map indices. */
function writeManifest(manifest, tilesetImages, interiors, ships) {
  const outManifest = {
    ...manifest,
    tilesetImages: [...tilesetImages].sort(),
    ...(interiors && Object.keys(interiors).length > 0 ? { interiors } : {}),
    ...(ships && Object.keys(ships).length > 0 ? { ships } : {}),
  };
  const outManifestPath = path.join(publicMapsDir, "world.json");
  mkdirSync(path.dirname(outManifestPath), { recursive: true });
  writeFileSync(outManifestPath, JSON.stringify(outManifest));
}

/** List interior TMX basenames (without `.tmx`). Empty if dir absent. */
function listInteriorKeys() {
  return listTmxKeys(interiorsDir);
}

/** List ship TMX basenames (without `.tmx`), e.g. `galleon-n`. Empty if dir absent. */
function listShipKeys() {
  return listTmxKeys(shipsDir);
}

function listTmxKeys(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".tmx"))
      .map((f) => f.replace(/\.tmx$/, ""))
      .sort();
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

export function buildAll() {
  // Stamp any missing uids into source TMX before reading for TMJ emit. New
  // uids land in the working tree — commit them alongside the Tiled changes
  // that introduced the objects.
  const stampReports = [
    ...stampUidsInDir(chunksDir, { check: false }),
    ...stampUidsInDir(interiorsDir, { check: false }),
  ];
  const stampedTotal = stampReports.reduce((n, r) => n + r.stamped, 0);
  if (stampedTotal > 0) {
    console.log(
      `Stamped ${stampedTotal} uid(s) into source TMX:\n${stampReports
        .filter((r) => r.stamped > 0)
        .map((r) => `  - ${path.basename(r.file)}: +${r.stamped}`)
        .join("\n")}`,
    );
  }

  const manifest = readManifest();
  const tilesetImages = new Set();
  const summaries = [];
  for (const key of manifest.authoredChunks) {
    const summary = buildChunk(key);
    for (const img of summary.tilesetImages) tilesetImages.add(img);
    summaries.push(summary);
  }

  const interiorKeys = listInteriorKeys();
  const interiors = {};
  for (const key of interiorKeys) {
    const tmjRel = path.join("interiors", `${key}.tmj`);
    const summary = buildMap(path.join("interiors", `${key}.tmx`), tmjRel);
    for (const img of summary.tilesetImages) tilesetImages.add(img);
    interiors[key] = { path: `interiors/${key}.tmj` };
  }

  const shipKeys = listShipKeys();
  const ships = {};
  for (const key of shipKeys) {
    const outRel = path.join("ships", `${key}.tmj`);
    const summary = buildMap(`${key}.tmx`, outRel, { srcRoot: shipsDir });
    for (const img of summary.tilesetImages) tilesetImages.add(img);
    ships[key] = { path: `ships/${key}.tmj` };
  }

  writeManifest(manifest, tilesetImages, interiors, ships);
  validateWorld(manifest, summaries);
  console.log(
    `Wrote manifest + ${manifest.authoredChunks.length} chunk TMJ file(s) + ${interiorKeys.length} interior + ${shipKeys.length} ship TMJ file(s); ${tilesetImages.size} tileset image(s).`,
  );
}

/** Rebuild a single chunk. Re-writes public/maps/world.json with the updated
 *  tileset-image union (recomputed from all authored chunks' emitted TMJ). */
export function buildChunk(key) {
  const summary = buildMap(path.join("chunks", `${key}.tmx`), path.join("chunks", `${key}.tmj`));
  return { key, ...summary };
}

/** After a single-chunk rebuild, refresh the manifest's tilesetImages union
 *  by re-reading every emitted TMJ. Cheap — 16 tiny JSON files today. */
export function refreshManifestImages() {
  const manifest = readManifest();
  const tilesetImages = new Set();
  for (const key of manifest.authoredChunks) {
    const tmjPath = path.join(publicMapsDir, "chunks", `${key}.tmj`);
    if (!existsSync(tmjPath)) continue;
    const tmj = JSON.parse(readFileSync(tmjPath, "utf8"));
    for (const ts of tmj.tilesets ?? []) if (ts.image) tilesetImages.add(ts.image);
  }
  const interiors = {};
  for (const key of listInteriorKeys()) {
    const tmjPath = path.join(publicMapsDir, "interiors", `${key}.tmj`);
    if (!existsSync(tmjPath)) continue;
    const tmj = JSON.parse(readFileSync(tmjPath, "utf8"));
    for (const ts of tmj.tilesets ?? []) if (ts.image) tilesetImages.add(ts.image);
    interiors[key] = { path: `interiors/${key}.tmj` };
  }
  const ships = {};
  for (const key of listShipKeys()) {
    const tmjPath = path.join(publicMapsDir, "ships", `${key}.tmj`);
    if (!existsSync(tmjPath)) continue;
    const tmj = JSON.parse(readFileSync(tmjPath, "utf8"));
    for (const ts of tmj.tilesets ?? []) if (ts.image) tilesetImages.add(ts.image);
    ships[key] = { path: `ships/${key}.tmj` };
  }
  writeManifest(manifest, tilesetImages, interiors, ships);
}

/** Validate build-time invariants. Throws on any violation. */
export function validateWorld(manifest, summaries) {
  const errors = [];
  for (const s of summaries) {
    if (!s.hasAnyTileLayer) errors.push(`Chunk ${s.key}: has no tile layers.`);
    for (const item of s.itemSpawns) {
      if (!item.itemId) errors.push(`Chunk ${s.key}: item_spawn at (${item.tx},${item.ty}) has empty itemId.`);
      if (!Number.isFinite(item.quantity) || item.quantity < 1) {
        errors.push(`Chunk ${s.key}: item_spawn at (${item.tx},${item.ty}) has invalid quantity ${item.quantity}.`);
      }
    }
  }
  const ships = summaries.flatMap((s) => s.shipSpawns.map((o) => ({ ...o, key: s.key })));
  const docks = summaries.flatMap((s) => s.dockSpawns.map((o) => ({ ...o, key: s.key })));
  if (ships.length !== 1) {
    errors.push(`Expected exactly 1 ship_spawn across world, found ${ships.length}${ships.length ? ` (chunks: ${ships.map((s) => s.key).join(", ")})` : ""}.`);
  }
  if (docks.length !== 1) {
    errors.push(`Expected exactly 1 dock across world, found ${docks.length}${docks.length ? ` (chunks: ${docks.map((d) => d.key).join(", ")})` : ""}.`);
  }
  // Every item_spawn must have a uid (pipeline normally stamps it, but a
  // hand-authored TMX that slipped past would surface here too).
  const allUids = new Map();
  for (const s of summaries) {
    for (const item of s.itemSpawns) {
      if (!item.uid) {
        errors.push(`Chunk ${s.key}: item_spawn at (${item.tx},${item.ty}) missing uid.`);
        continue;
      }
      if (allUids.has(item.uid)) {
        errors.push(`Duplicate uid '${item.uid}' in chunks ${allUids.get(item.uid)} and ${s.key}.`);
      } else {
        allUids.set(item.uid, s.key);
      }
    }
  }
  // startChunk should reference an authored chunk.
  if (manifest.startChunk) {
    const startKey = `${manifest.startChunk.cx}_${manifest.startChunk.cy}`;
    if (!manifest.authoredChunks.includes(startKey)) {
      errors.push(`startChunk ${startKey} is not in authoredChunks.`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`World validation failed:\n  - ${errors.join("\n  - ")}`);
  }
}

export function buildMap(tmxRelPath, outRelPath, opts = {}) {
  const srcRoot = opts.srcRoot ?? mapsDir;
  const tmxPath = path.join(srcRoot, tmxRelPath);
  const tmxXml = readFileSync(tmxPath, "utf8");
  const tree = parser.parse(tmxXml);
  const mapNode = findNode(tree, "map");
  const mapAttrs = mapNode[":@"];
  const mapChildren = mapNode.map;

  const width = int(mapAttrs["@_width"]);
  const height = int(mapAttrs["@_height"]);
  const tileWidth = int(mapAttrs["@_tilewidth"]);
  const tileHeight = int(mapAttrs["@_tileheight"]);

  // Resolve each tileset reference (external or inline).
  const tilesets = [];
  for (const c of mapChildren) {
    if (c.tileset === undefined) continue;
    const attrs = c[":@"];
    const firstGid = int(attrs["@_firstgid"]);
    const source = attrs["@_source"];
    if (source) {
      const tsxPath = path.resolve(path.dirname(tmxPath), source);
      tilesets.push({ firstGid, ...loadExternalTsx(tsxPath) });
    } else {
      tilesets.push({ firstGid, ...inlineTilesetToTiled(attrs, c.tileset) });
    }
  }

  // Decode layer data from base64 + zlib into plain integer arrays. Tiled's
  // TMJ format accepts base64+zlib too, but keeping it decoded makes the file
  // trivially inspectable in source and easy for other tools to consume.
  const layers = [];
  let layerOrder = 0;
  for (const c of mapChildren) {
    if (c.layer !== undefined) {
      const attrs = c[":@"];
      const dataEntry = c.layer.find((x) => x.data);
      const dataAttrs = dataEntry[":@"];
      const encoding = dataAttrs["@_encoding"];
      const compression = dataAttrs["@_compression"];
      const text = (dataEntry.data[0]?.["#text"] ?? "").trim();
      let gids;
      if (encoding === "csv") {
        if (compression) throw new Error(`CSV layer unexpectedly has compression ${compression}`);
        gids = text
          .split(/,/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => Number(BigInt(s) & 0xffffffffn));
      } else if (encoding === "base64") {
        let bytes = Buffer.from(text, "base64");
        if (compression === "zlib") bytes = inflateSync(bytes);
        else if (compression === "gzip") bytes = inflateSync(bytes); // node handles gzip too
        else if (compression) throw new Error(`Compression ${compression} unsupported`);
        gids = new Array(bytes.length / 4);
        for (let i = 0; i < gids.length; i++) gids[i] = bytes.readUInt32LE(i * 4);
      } else {
        throw new Error(`Layer encoding ${encoding} unsupported`);
      }
      layers.push({
        type: "tilelayer",
        id: int(attrs["@_id"]),
        name: attrs["@_name"],
        width: int(attrs["@_width"]),
        height: int(attrs["@_height"]),
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
        data: gids,
        order: layerOrder++,
      });
    } else if (c.objectgroup !== undefined) {
      const attrs = c[":@"];
      const objects = [];
      for (const child of c.objectgroup) {
        if (child.object === undefined) continue;
        objects.push(objectToTiled(child[":@"], child.object));
      }
      layers.push({
        type: "objectgroup",
        id: int(attrs["@_id"]),
        name: attrs["@_name"],
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
        objects,
        order: layerOrder++,
      });
    }
  }
  layers.sort((a, b) => a.order - b.order).forEach((l) => delete l.order);

  const tmj = {
    compressionlevel: -1,
    type: "map",
    version: "1.10",
    tiledversion: "1.12.1",
    orientation: mapAttrs["@_orientation"] ?? "orthogonal",
    renderorder: mapAttrs["@_renderorder"] ?? "right-down",
    infinite: false,
    width,
    height,
    tilewidth: tileWidth,
    tileheight: tileHeight,
    nextlayerid: int(mapAttrs["@_nextlayerid"] ?? layers.length + 1),
    nextobjectid: int(mapAttrs["@_nextobjectid"] ?? 1),
    tilesets: tilesets.map(({ firstGid, data, imageCopyFrom, imageCopyTo }) => {
      // Image path in output TMJ is relative to the TMJ file's location.
      if (imageCopyFrom && imageCopyTo) {
        mkdirSync(path.dirname(imageCopyTo), { recursive: true });
        copyFileSync(imageCopyFrom, imageCopyTo);
      }
      return { firstgid: firstGid, ...data };
    }),
    layers,
  };

  const outPath = path.join(publicMapsDir, outRelPath ?? tmxRelPath.replace(/\.tmx$/, ".tmj"));
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(tmj));

  // Summary for the validator + manifest refresh.
  const tilesetImages = tmj.tilesets.map((t) => t.image).filter(Boolean);
  const hasAnyTileLayer = layers.some((l) => l.type === "tilelayer");
  const shipSpawns = [];
  const dockSpawns = [];
  const itemSpawns = [];
  for (const l of layers) {
    if (l.type !== "objectgroup") continue;
    for (const obj of l.objects) {
      const props = Object.fromEntries((obj.properties ?? []).map((p) => [p.name, p.value]));
      const tx = Math.floor((obj.x ?? 0) / tileWidth);
      const ty = Math.floor((obj.y ?? 0) / tileHeight);
      if (obj.type === "ship_spawn") shipSpawns.push({ tx, ty });
      else if (obj.type === "dock") dockSpawns.push({ tx, ty });
      else if (obj.type === "item_spawn") {
        itemSpawns.push({
          tx,
          ty,
          uid: String(props.uid ?? ""),
          itemId: String(props.itemId ?? ""),
          quantity: Number(props.quantity ?? 1),
        });
      }
    }
  }
  return { tilesetImages, hasAnyTileLayer, shipSpawns, dockSpawns, itemSpawns };
}

function loadExternalTsx(tsxPath) {
  const xml = readFileSync(tsxPath, "utf8");
  const tree = parser.parse(xml);
  const tsNode = findNode(tree, "tileset");
  const attrs = tsNode[":@"];
  const children = tsNode.tileset;
  const imgEntry = children.find((x) => x.image);
  if (!imgEntry) {
    throw new Error(
      `Tileset '${tsxPath}' has no top-level <image> — it's an image-collection tileset (one image per tile), which the runtime doesn't support. Use the composite-sheet variant of this tileset instead (typically named without the '-sprites' suffix).`,
    );
  }
  const imgAttrs = imgEntry[":@"];
  const imageRel = imgAttrs["@_source"];
  const imageAbs = path.resolve(path.dirname(tsxPath), imageRel);
  // The output TMJ references tileset images via a relative path from the
  // TMJ's own location in public/maps/. Different TSX sources may share a
  // basename (each theme pack ships its own `tilesets.png`), so we route
  // through a registry that disambiguates by source path — otherwise the
  // two images would clobber each other on disk and one of the tilesets
  // would render from the wrong image.
  const outImage = resolveOutImage(imageAbs);
  const imageCopyTo = path.join(publicMapsDir, outImage);

  const tiles = [];
  for (const t of children) {
    if (t.tile === undefined) continue;
    const tAttrs = t[":@"];
    const id = int(tAttrs["@_id"]);
    const propsEntry = t.tile.find((x) => x.properties);
    const animEntry = t.tile.find((x) => x.animation);
    const ogEntry = t.tile.find((x) => x.objectgroup);
    const tileOut = { id };
    if (propsEntry) {
      const properties = [];
      for (const p of propsEntry.properties) {
        if (p.property === undefined) continue;
        const pa = p[":@"];
        properties.push({
          name: pa["@_name"],
          type: pa["@_type"] ?? "string",
          value: coerce(pa["@_type"], pa["@_value"]),
        });
      }
      if (properties.length > 0) tileOut.properties = properties;
    }
    if (animEntry) {
      const animation = [];
      for (const f of animEntry.animation) {
        if (f.frame === undefined) continue;
        const fa = f[":@"];
        animation.push({ tileid: int(fa["@_tileid"]), duration: int(fa["@_duration"]) });
      }
      if (animation.length > 0) tileOut.animation = animation;
    }
    if (ogEntry) {
      const ogAttrs = ogEntry[":@"] ?? {};
      const objects = [];
      for (const child of ogEntry.objectgroup) {
        if (child.object === undefined) continue;
        objects.push(objectToTiled(child[":@"], child.object));
      }
      if (objects.length > 0) {
        tileOut.objectgroup = {
          draworder: ogAttrs["@_draworder"] ?? "index",
          objects,
        };
      }
    }
    if (tileOut.properties || tileOut.animation || tileOut.objectgroup) tiles.push(tileOut);
  }

  return {
    data: {
      name: attrs["@_name"],
      tilewidth: int(attrs["@_tilewidth"]),
      tileheight: int(attrs["@_tileheight"]),
      spacing: int(attrs["@_spacing"] ?? "0"),
      margin: int(attrs["@_margin"] ?? "0"),
      columns: int(attrs["@_columns"]),
      tilecount: int(attrs["@_tilecount"]),
      image: outImage,
      imagewidth: int(imgAttrs["@_width"]),
      imageheight: int(imgAttrs["@_height"]),
      tiles,
    },
    imageCopyFrom: imageAbs,
    imageCopyTo,
  };
}

function inlineTilesetToTiled(_attrs, _children) {
  throw new Error("Inline tilesets are not supported — author with external TSX.");
}

function objectToTiled(attrs, children) {
  const obj = {
    id: int(attrs["@_id"]),
    name: attrs["@_name"] ?? "",
    type: attrs["@_type"] ?? "",
    x: num(attrs["@_x"] ?? "0"),
    y: num(attrs["@_y"] ?? "0"),
    width: num(attrs["@_width"] ?? "0"),
    height: num(attrs["@_height"] ?? "0"),
    rotation: num(attrs["@_rotation"] ?? "0"),
    visible: true,
  };
  const childArr = children ?? [];
  if (childArr.some((c) => c.point !== undefined)) obj.point = true;
  if (childArr.some((c) => c.ellipse !== undefined)) obj.ellipse = true;
  const polyEntry = childArr.find((c) => c.polygon !== undefined);
  if (polyEntry) obj.polygon = parsePoints(polyEntry[":@"]?.["@_points"]);
  const polylineEntry = childArr.find((c) => c.polyline !== undefined);
  if (polylineEntry) obj.polyline = parsePoints(polylineEntry[":@"]?.["@_points"]);
  const propsEntry = childArr.find((c) => c.properties);
  if (propsEntry) {
    obj.properties = [];
    for (const p of propsEntry.properties) {
      if (p.property === undefined) continue;
      const pa = p[":@"];
      obj.properties.push({
        name: pa["@_name"],
        type: pa["@_type"] ?? "string",
        value: coerce(pa["@_type"], pa["@_value"]),
      });
    }
  }
  return obj;
}

/** Parse Tiled's `points="x1,y1 x2,y2 …"` into `[{x,y}, …]`. */
function parsePoints(s) {
  if (!s) return [];
  return s
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x, y };
    });
}

function coerce(type, value) {
  if (value === undefined || value === null) return "";
  if (type === "bool") return value === "true" || value === true;
  if (type === "int") return parseInt(value, 10);
  if (type === "float") return parseFloat(value);
  return String(value);
}

function int(v) {
  return parseInt(v, 10);
}
function num(v) {
  return Number(v);
}

function findNode(tree, name) {
  for (const n of tree) if (n[name] !== undefined) return n;
  throw new Error(`Missing node ${name}`);
}

// Silence unused-var warnings about existsSync (left available for callers).
void existsSync;
