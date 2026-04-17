import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error — local plugin, no types
import sailingMaps from "./tools/vite-plugin-sailing-maps/index.mjs";

export default defineConfig({
  plugins: [react(), sailingMaps()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: "es2022",
  },
});
