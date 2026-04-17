// Vite plugin: watches maps/** and rebuilds all authored chunks on change,
// then triggers a full page reload. Replaces `npm run maps &&` in the dev
// script — `vite` alone is now enough. A full rebuild of 16 chunks runs in
// tens of ms, so incremental single-chunk rebuild is not worth the cost of
// tracking cross-world invariants (exactly one ship_spawn, etc.) partially.
//
// Validation failures don't kill the process — they surface via the Vite
// dev-server error overlay so the author can fix the TMX in place and save.

import path from "node:path";
import { buildAll, mapsDir } from "../build-maps.mjs";

export default function sailingMapsPlugin() {
  let server = null;

  const rebuild = (reason) => {
    const t0 = Date.now();
    try {
      buildAll();
      log(`rebuilt (${Date.now() - t0}ms) — ${reason}`);
      server?.ws.send({ type: "full-reload", path: "*" });
    } catch (err) {
      reportError(err);
    }
  };

  return {
    name: "sailing-maps",
    buildStart() {
      // Ensure public/maps/ is fresh before Vite serves the first request.
      try {
        buildAll();
      } catch (err) {
        reportError(err);
      }
    },
    configureServer(_server) {
      server = _server;
      server.watcher.add(path.join(mapsDir, "**"));
      const onChange = (file) => {
        const abs = path.resolve(file);
        if (!abs.startsWith(mapsDir)) return;
        const rel = path.relative(mapsDir, abs).replace(/\\/g, "/");
        if (rel.endsWith(".tmj")) return; // emitted output, ignore
        // Only rebuild for files the build actually reads.
        if (rel === "world.json" || rel.startsWith("tilesets/") || /^chunks\/\d+_\d+\.tmx$/.test(rel)) {
          rebuild(rel);
        }
      };
      server.watcher.on("change", onChange);
      server.watcher.on("add", onChange);
      server.watcher.on("unlink", onChange);
    },
  };

  function reportError(err) {
    const msg = err?.message ?? String(err);
    console.error(`[sailing-maps] ${msg}`);
    server?.ws.send({
      type: "error",
      err: { message: `[sailing-maps] ${msg}`, stack: err?.stack ?? "" },
    });
  }

  function log(msg) {
    console.log(`[sailing-maps] ${msg}`);
  }
}
