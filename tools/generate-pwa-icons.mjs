import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "public", "pwa");

// A minimal pixel-art-ish sailing icon: ocean gradient + sail + hull.
// Kept simple so it renders cleanly at small sizes.
const makeSvg = (size, { padding }) => {
  const inset = Math.round(size * padding);
  const inner = size - inset * 2;
  const waterTop = Math.round(inset + inner * 0.65);
  const hullY = waterTop - Math.round(inner * 0.04);
  const hullW = Math.round(inner * 0.55);
  const hullH = Math.round(inner * 0.1);
  const hullX = Math.round(size / 2 - hullW / 2);
  const mastX = Math.round(size / 2);
  const mastTop = Math.round(inset + inner * 0.12);
  const sailW = Math.round(inner * 0.42);
  return `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2f6fb8"/>
      <stop offset="100%" stop-color="#7fbde8"/>
    </linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a4f86"/>
      <stop offset="100%" stop-color="#0c2c4c"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="#0c2c4c"/>
  <rect x="${inset}" y="${inset}" width="${inner}" height="${inner}" fill="url(#sky)"/>
  <rect x="${inset}" y="${waterTop}" width="${inner}" height="${size - waterTop - inset}" fill="url(#sea)"/>
  <!-- mast -->
  <rect x="${mastX - Math.max(2, Math.round(size / 128))}" y="${mastTop}" width="${Math.max(4, Math.round(size / 64))}" height="${hullY - mastTop}" fill="#3a2a1a"/>
  <!-- sail (right triangle) -->
  <polygon points="${mastX},${mastTop} ${mastX + sailW},${hullY} ${mastX},${hullY}" fill="#f5efe0" stroke="#c9bfa5" stroke-width="${Math.max(1, Math.round(size / 256))}"/>
  <!-- hull -->
  <path d="M ${hullX} ${hullY} L ${hullX + hullW} ${hullY} L ${hullX + hullW - hullH} ${hullY + hullH} L ${hullX + hullH} ${hullY + hullH} Z" fill="#6b3f1f" stroke="#3a2a1a" stroke-width="${Math.max(1, Math.round(size / 256))}"/>
</svg>`;
};

async function render(name, size, opts) {
  const svg = makeSvg(size, opts);
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const target = resolve(out, name);
  await writeFile(target, buf);
  console.log(`wrote ${target}`);
}

await mkdir(out, { recursive: true });
await render("icon-192.png", 192, { padding: 0.04 });
await render("icon-512.png", 512, { padding: 0.04 });
// Maskable icons need a safe zone of ~10% on every side.
await render("icon-maskable-512.png", 512, { padding: 0.18 });
await render("apple-touch-icon.png", 180, { padding: 0.04 });
