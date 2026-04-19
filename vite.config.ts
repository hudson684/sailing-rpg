import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error — local plugin, no types
import sailingMaps from "./tools/vite-plugin-sailing-maps/index.mjs";
// @ts-expect-error — local plugin, no types
import editSave from "./tools/vite-plugin-edit-save/index.mjs";

export default defineConfig({
  plugins: [react(), sailingMaps(), editSave()],
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
  },
});
