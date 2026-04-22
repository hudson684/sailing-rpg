// Vite plugin: dev-only POST endpoint that the in-game Edit Mode overlay
// uses to write JSON files directly into src/game/data/. Avoids a manual
// "download then drop into folder" step. The endpoint is only mounted in
// dev (configureServer), so production builds can never write to disk.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "..", "..", "src", "game", "data");

// Whitelist — the endpoint refuses any other filename so a stray POST
// can't clobber arbitrary project files.
const ALLOWED = new Set([
  "npcs.json",
  "enemies.json",
  "nodes.json",
  "shops.json",
  "itemInstances.json",
  "ships.json",
  "craftingStations.json",
  "interiorInstances.json",
]);

export default function editSavePlugin() {
  return {
    name: "sailing-edit-save",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__edit/save", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        try {
          const body = await readJson(req);
          if (!body || !Array.isArray(body.files)) throw new Error("Body must be { files: [...] }");
          const written = [];
          for (const f of body.files) {
            if (typeof f?.name !== "string" || typeof f?.content !== "string") {
              throw new Error("Each file needs string `name` and `content`.");
            }
            if (!ALLOWED.has(f.name)) {
              throw new Error(`Refusing to write disallowed filename: ${f.name}`);
            }
            const out = path.join(dataDir, f.name);
            await fs.writeFile(out, f.content, "utf8");
            written.push(f.name);
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, written }));
          // eslint-disable-next-line no-console
          console.log(`[edit-save] wrote: ${written.join(", ")}`);
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
        }
      });
    },
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : null);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
