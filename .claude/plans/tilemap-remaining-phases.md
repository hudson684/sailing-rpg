# Tilemap pipeline — remaining phases

Phases 1–3 are shipped:

1. **Phase 1** — External TSX + TMX authoring, `build-maps.mjs` producing runtime TMJ with embedded tileset, `npm run maps` wired into dev/build.
2. **Phase 2** — `TileRegistry` (per-tile property lookup, any-layer-wins), `parseSpawns` (typed object-layer spawns: `ship_spawn`, `dock`, `item_spawn`), `worldMap` façade.
3. **Phase 3** — Chunked maps: 32×32 chunks under `maps/chunks/`, `maps/world.json` manifest, `ChunkManager` façade dispatching global-tile queries per owning chunk, unauthored tiles default to open ocean. Currently **eager** load of all authored chunks at boot; streaming is a later upgrade behind the same façade.

What remains below is the forward plan — refine as we go.

---

## Phase 4 — Wang auto-tile coastlines

**Goal.** Author coastlines by painting "land" on a single marker layer; a build-time pass expands those marks into the correct stitched coastline tiles using a Wang / marching-squares lookup. Authors stop placing individual corner/edge tiles by hand.

### Design

- **Author-side marker layer** — a simple layer (e.g. `coast_mark`) where the author stamps a single "is-land" GID. The layer is never rendered at runtime.
- **Tile classification in the TSX** — extend tile custom properties with `wangSet: "coast"` + `wangRole: "NW" | "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "inner_NW" | ...` (or corner-based with 2-bit corners for a 16-tile set). Tiles tagged with a role become the lookup targets.
- **Build-time expander in `tools/build-maps.mjs`** — for each chunk: read the marker layer, for each cell compute the 4-corner mask from its 2×2 neighbourhood (including neighbouring chunks via the manifest), pick the matching tile from the wangSet, and write to a real layer (`ground` or a new `coastline` layer). Strip the marker layer from the TMJ output so runtime never sees it.
- **Cross-chunk seams** — the expander MUST look at neighbouring-chunk cells at the border. Load neighbours lazily during build, or do one pass that keeps all source grids in memory (cheap at current scale).
- **Unauthored-chunk borders** — an unauthored neighbour is treated as ocean (empty mark), so coastlines terminate cleanly against the open ocean default.

### Deliverables

- `tools/wang.mjs` — pure expander (classification → tile index) with unit tests.
- `tools/build-maps.mjs` — integrate expander, strip marker layers before write.
- `maps/tilesets/roguelike.tsx` — role annotations for the existing coastline tiles.
- `maps/README.md` — document the `coast_mark` authoring workflow.

### Open questions

- 16-tile set (corner-based) vs 47-tile set (with inner/outer variants). 16-tile is simpler and looks fine for a first pass; 47-tile gives prettier inner corners. Start 16, upgrade later.
- Multiple wangSets (coast, dirt path, etc.) on the same chunk — the manifest should carry a list, not a singleton.

---

## Phase 5 — Vite plugin: HMR, type generation, validation

**Goal.** Collapse the `npm run maps` step into the dev loop: editing a TMX in Tiled triggers an incremental rebuild and hot-reloads the affected chunks without a full page refresh. Also generate typed constants for tile/item/spawn IDs so typos fail at `tsc`, not at runtime.

### Design

- **`vite-plugin-sailing-maps`** (local plugin under `tools/vite-plugin-sailing-maps/`):
  - On `configureServer`, watch `maps/**/*.tmx`, `maps/**/*.tsx`, `maps/world.json`.
  - On change, re-run the affected portion of `build-maps.mjs` (single-chunk rebuild where possible) and emit an HMR payload on a custom channel (`sailing:chunk-reload`) carrying `{cx, cy, url}`.
  - Client-side runtime listener calls `ChunkManager.reloadChunk(cx, cy)` — swaps tilemap data in place without re-entering the Phaser scene.
- **Type generation**:
  - Extract from TSX: tile IDs that carry a `name` property → emit `src/generated/tileIds.ts` with a const map.
  - Extract from `ITEMS`: already typed, nothing to do.
  - Extract object types from TSX/TMX: emit `src/generated/spawnTypes.ts` with a union.
  - Regenerate on file change; commit the generated files for painless first-run.
- **Validation** (fail fast at build time):
  - Every authored chunk has a `ground` layer.
  - Every `item_spawn` object's `itemId` exists in `ITEMS`.
  - Exactly one `ship_spawn` and one `dock` across the whole world.
  - Every `ship_spawn` tile and the 3×2 footprint around it is water.
  - Referenced tileset image files exist.

### Deliverables

- `tools/vite-plugin-sailing-maps/index.mjs`
- `src/generated/` directory, wired into `tsconfig` includes.
- Build-time validator with a single `validateWorld(manifest)` entry used by both the CLI (`npm run maps`) and the plugin.

### Open questions

- Granularity of HMR: chunk-level is cleanest; tile-level is overkill. Start chunk-level.
- Should the plugin also handle TSX edits? Yes — a property change on a tile should re-emit all chunks (cheap) and reload them all.

---

## Phase 6 — Debug overlays

**Goal.** Visual debugging for walkability, chunk boundaries, spawn points, and anchor search.

### Design

- **Toggle via `F1`-style keys** (or a single cycling `F2` that rotates through overlays).
- **Overlays** (each a Phaser `Graphics` layer at a high depth):
  - `walkability` — tint every tile red if `isBlocked`, blue if `isWater`, transparent if land-walkable. Updates lazily: only tiles inside the current camera view.
  - `chunkGrid` — draw chunk borders + `cx,cy` labels.
  - `spawns` — coloured markers at each ship/dock/item spawn with type labels.
  - `anchorSearch` — when at the helm, overlay the current candidate poses from `findAnchorPose` with cost gradient (green = cheapest, red = rejected).
- **Overlay manager** under `src/game/debug/DebugOverlays.ts` with an `attach(scene)` API. Overlays opt-in to `update()` ticks.

### Deliverables

- `src/game/debug/DebugOverlays.ts` + one file per overlay.
- Minimal HUD line showing active overlay name.
- Key bindings documented in `maps/README.md` or a new `docs/debug.md`.

### Open questions

- Ship React HUD toggle vs Phaser-only? Phaser-only is fine — debug UX lives with the game.

---

## Phase 3.5 (deferred) — Real chunk streaming

Phase 3 loads every authored chunk eagerly. Once worlds grow past ~64 chunks, flip on real streaming:

- 3×3 load window around the player's current chunk; 5×5 keep-alive (hysteresis).
- Chunks fetched via `this.load.tilemapTiledJSON` on demand (Phaser's loader is idempotent by key).
- On eviction, destroy the chunk's `TilemapLayer`s and forget its `TileRegistry`.
- Item spawns owned by chunks: when a chunk loads, emit its `ItemSpawn`s to the scene; when it unloads, despawn them. Chunk-owned ground items survive pickup/drop via a persistent set on `ChunkManager` (drops re-emit on reload).
- `ship_spawn` / `dock` stay singletons — force-load the `startChunk` at boot, keep it loaded.

The `ChunkManager` façade is already shaped to absorb this — queries default to ocean for any chunk not currently resident, which is the same rule streaming needs.

---

## Non-goals / parking lot

- Procedural world generation beyond ocean fill. If/when we add it, it lives behind `ChunkManager.ensureChunk(cx, cy)` and writes back into the same in-memory cache as streamed chunks.
- Multi-tileset support. Current pipeline assumes one tileset per world. When a 32×32 art set arrives, swap the tileset, don't add a second one — keeps GID math trivial.
- Runtime map editing. Out of scope; Tiled + HMR is the authoring loop.
