// Vite plugin: dev-only POST endpoint for the /editor React tools.
// Accepts { path: string, content: string } where `path` must resolve
// inside src/game/data/ and end in .json. Directory traversal is
// rejected. Mounted only in dev via apply: "serve" + an explicit mode
// check in vite.config.ts.
//
// Separate from tools/vite-plugin-edit-save/ — that plugin serves the
// in-game Edit Mode overlay and uses a fixed filename whitelist. This
// one is driven by the React editor, which needs to author new data
// files (quests.json, dialogue.json, …) not enumerated in advance.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const dataDir = path.resolve(repoRoot, "src", "game", "data");

export default function editorWritePlugin() {
  return {
    name: "sailing-editor-write",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__editor/read", async (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const rel = url.searchParams.get("path");
          if (!rel) throw new Error("Missing ?path=");
          const target = resolveSafe(rel);
          const content = await fs.readFile(target, "utf8");
          res.setHeader("Content-Type", "application/json");
          res.end(content);
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
        }
      });

      server.middlewares.use("/__editor/write", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        try {
          const body = await readJson(req);
          if (!body || typeof body.path !== "string" || typeof body.content !== "string") {
            throw new Error("Body must be { path: string, content: string }");
          }
          const target = resolveSafe(body.path);
          await fs.writeFile(target, body.content, "utf8");
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, path: path.relative(repoRoot, target) }));
          // eslint-disable-next-line no-console
          console.log(`[editor-write] wrote: ${path.relative(repoRoot, target)}`);
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
        }
      });
    },
  };
}

function resolveSafe(inputPath) {
  const normalized = inputPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const resolved = path.resolve(repoRoot, normalized);
  const rel = path.relative(dataDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes src/game/data: ${inputPath}`);
  }
  if (path.extname(resolved) !== ".json") {
    throw new Error(`Only .json files are writable: ${inputPath}`);
  }
  return resolved;
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
