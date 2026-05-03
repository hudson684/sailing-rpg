// Validate that every Tiled `npcSpawnPoint.spawnGroupId` references a
// known entry in `src/game/sim/data/spawnGroups.json`.
//
// Standalone entry point (CLI): `node tools/validate-spawn-refs.mjs`. Also
// exported (`validateSpawnRefs`) for use from `tools/build-maps.mjs` so the
// regular `npm run maps` build catches authoring drift.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const spawnGroupsPath = path.join(
  repoRoot,
  "src",
  "game",
  "sim",
  "data",
  "spawnGroups.json",
);
const chunksDir = path.join(repoRoot, "public", "maps", "chunks");

function loadSpawnGroupIds() {
  const raw = JSON.parse(readFileSync(spawnGroupsPath, "utf8"));
  return new Set(Object.keys(raw));
}

function listChunkTmjPaths() {
  try {
    return readdirSync(chunksDir)
      .filter((f) => f.endsWith(".tmj"))
      .map((f) => path.join(chunksDir, f));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

/** Inspect every chunk TMJ for `npcSpawnPoint` objects; return any whose
 *  `spawnGroupId` doesn't resolve. Exposed for use from build-maps.mjs's
 *  validateWorld(). */
export function validateSpawnRefs() {
  const known = loadSpawnGroupIds();
  const errors = [];
  for (const tmjPath of listChunkTmjPaths()) {
    const tmj = JSON.parse(readFileSync(tmjPath, "utf8"));
    const chunkKey = path
      .basename(tmjPath)
      .replace(/\.tmj$/, "");
    for (const layer of tmj.layers ?? []) {
      if (layer.type !== "objectgroup") continue;
      for (const obj of layer.objects ?? []) {
        if (obj.type !== "npcSpawnPoint") continue;
        const props = Object.fromEntries(
          (obj.properties ?? []).map((p) => [p.name, p.value]),
        );
        const spawnGroupId = String(props.spawnGroupId ?? "");
        const tx = Math.floor((obj.x ?? 0) / (tmj.tilewidth ?? 16));
        const ty = Math.floor((obj.y ?? 0) / (tmj.tileheight ?? 16));
        if (!spawnGroupId) {
          errors.push(
            `chunk ${chunkKey}: npcSpawnPoint at (${tx},${ty}) is missing 'spawnGroupId' property.`,
          );
          continue;
        }
        if (!known.has(spawnGroupId)) {
          errors.push(
            `chunk ${chunkKey}: npcSpawnPoint at (${tx},${ty}) references unknown spawnGroupId '${spawnGroupId}'. Known: ${[...known].join(", ") || "(none)"}.`,
          );
        }
      }
    }
  }
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("validate-spawn-refs.mjs")) {
  const errors = validateSpawnRefs();
  if (errors.length === 0) {
    console.log("validate-spawn-refs: ok");
    process.exit(0);
  }
  console.error(`validate-spawn-refs failed:\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}
