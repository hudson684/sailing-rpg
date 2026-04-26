import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error — local plugin, no types
import sailingMaps from "./tools/vite-plugin-sailing-maps/index.mjs";
// @ts-expect-error — local plugin, no types
import editSave from "./tools/vite-plugin-edit-save/index.mjs";
// @ts-expect-error — local plugin, no types
import editorWrite from "./tools/editor-write-plugin.mjs";

function versionServiceWorker(): Plugin {
  return {
    name: "version-sw",
    apply: "build",
    async closeBundle() {
      const swPath = resolve("dist/sw.js");
      const src = await readFile(swPath, "utf8");
      const version = Date.now().toString(36);
      await writeFile(swPath, src.replace("__SW_VERSION__", version));
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [
    react(),
    sailingMaps(),
    editSave(),
    ...(mode === "development" ? [editorWrite()] : []),
    versionServiceWorker(),
  ],
  server: {
    host: true,
    port: 5173,
    watch: {
      ignored: [
        "**/assets-source/**",
        "**/tmp-ui-probe/**",
        "**/.git/**",
        "**/node_modules/**",
      ],
    },
  },
  build: {
    target: "es2022",
    // Phaser ships as a single ~1.35 MB pre-bundled ESM file with no
    // tree-shaking hooks; for a game that's normal, so silence the warning.
    chunkSizeWarningLimit: 1500,
  },
}));
