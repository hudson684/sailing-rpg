// One-off helper: adds empty `building@id:rusty_anchor:state:<state>` tile
// layers and an `overlays` objectgroup to chunks 1_1 and 2_1, as scaffolding
// for the building-exterior state system. Run once per chunk; checks for
// existing layers so it's idempotent.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const STATES = ["rundown", "repaired", "upgraded"];
const BUILDING = "rusty_anchor";

function emptyCsv64x64() {
  const row = Array(64).fill(0).join(",") + ",";
  const last = Array(64).fill(0).join("");
  // Phaser/Tiled tolerate trailing comma on every row including last; we
  // match the project's convention of no trailing comma on the very last row.
  const rows = Array(63).fill(row).join("\n") + "\n" + Array(64).fill(0).join(",");
  void last;
  return rows;
}

function addToChunk(chunkPath) {
  const original = readFileSync(chunkPath, "utf8");
  let src = original;

  // Bump nextlayerid / nextobjectid as we add things.
  let nextLayerIdMatch = /nextlayerid="(\d+)"/.exec(src);
  if (!nextLayerIdMatch) throw new Error(`nextlayerid not found in ${chunkPath}`);
  let nextLayerId = Number(nextLayerIdMatch[1]);

  const csv = emptyCsv64x64();

  // Insert state layers right before the first `<objectgroup` tag (i.e. after
  // the last tile layer, before the `objects`/`COLLISION` groups).
  const firstOg = src.indexOf("<objectgroup");
  if (firstOg < 0) throw new Error(`no objectgroup found in ${chunkPath}`);

  const newLayers = [];
  for (const stateId of STATES) {
    const layerName = `building@id:${BUILDING}:state:${stateId}`;
    if (src.includes(`name="${layerName}"`)) continue;
    const id = nextLayerId++;
    newLayers.push(
      ` <layer id="${id}" name="${layerName}" width="64" height="64">\n` +
        `  <data encoding="csv">\n${csv}\n</data>\n </layer>\n`,
    );
  }

  // Insert overlays objectgroup if not present.
  let overlayInsert = "";
  if (!/<objectgroup [^>]*name="overlays"/.test(src)) {
    const id = nextLayerId++;
    overlayInsert = ` <objectgroup id="${id}" name="overlays"/>\n`;
  }

  const insertion = newLayers.join("") + overlayInsert;
  if (!insertion) {
    console.log(`${path.basename(chunkPath)}: nothing to add`);
    return;
  }

  // Splice the insertion + bump nextlayerid.
  const before = src.slice(0, firstOg);
  const after = src.slice(firstOg);
  src =
    before.replace(/nextlayerid="\d+"/, `nextlayerid="${nextLayerId}"`) +
    insertion +
    after;

  writeFileSync(chunkPath, src);
  console.log(`${path.basename(chunkPath)}: added ${newLayers.length} layer(s)${overlayInsert ? " + overlays group" : ""}`);
}

const targets = ["1_1.tmx", "2_1.tmx"].map((f) =>
  path.join(repoRoot, "maps", "chunks", f),
);
for (const t of targets) addToChunk(t);
