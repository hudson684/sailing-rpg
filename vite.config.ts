import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
// @ts-expect-error — local plugin, no types
import sailingMaps from "./tools/vite-plugin-sailing-maps/index.mjs";
// @ts-expect-error — local plugin, no types
import editSave from "./tools/vite-plugin-edit-save/index.mjs";

// Changes every build; used by the bitmap cache (src/game/assets/bitmapCache.ts)
// to invalidate stored ImageBitmaps after a redeploy.
const BUILD_VERSION =
  process.env.SAILING_BUILD_VERSION ?? new Date().toISOString();

export default defineConfig({
  base: "./",
  define: {
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
  },
  plugins: [
    react(),
    sailingMaps(),
    editSave(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [
        "pwa/apple-touch-icon.png",
        "pwa/icon-192.png",
        "pwa/icon-512.png",
      ],
      manifest: {
        name: "Sailing RPG",
        short_name: "Sailing RPG",
        description: "Offline-playable sailing RPG.",
        theme_color: "#0c2c4c",
        background_color: "#0c2c4c",
        display: "fullscreen",
        orientation: "landscape",
        start_url: ".",
        scope: ".",
        icons: [
          { src: "pwa/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "pwa/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff,woff2,ttf,svg,ico}"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) =>
              request.destination === "image" && !url.pathname.includes("/pwa/"),
            handler: "CacheFirst",
            options: {
              cacheName: "sailing-rpg-images",
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.endsWith(".json"),
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "sailing-rpg-data",
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
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
  },
});
