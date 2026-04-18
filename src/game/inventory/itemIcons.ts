// Icon URLs for item ids. Kept separate from items.json because icons are
// bundler-resolved imports (Vite fingerprints the PNGs), so they can't live
// inside a plain JSON file. Emoji items use inline SVG data URLs.

import iconRope from "../../ui/icons/inventory/item_rope.png";
import iconWood from "../../ui/icons/inventory/item_wood.png";
import iconFish from "../../ui/icons/inventory/item_fish.png";
import iconCoin from "../../ui/icons/inventory/item_coin.png";
import iconCompass from "../../ui/icons/inventory/item_compass.png";
import iconHat from "../../ui/icons/inventory/item_hat.png";
import iconCoat from "../../ui/icons/inventory/item_coat.png";
import iconBoots from "../../ui/icons/inventory/item_boots.png";
import iconSword from "../../ui/icons/inventory/item_sword.png";
import iconRing from "../../ui/icons/inventory/item_ring.png";

function emojiIcon(glyph: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>` +
    `<text x='16' y='24' font-size='24' text-anchor='middle'` +
    ` font-family='Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif'>` +
    `${glyph}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const FALLBACK_ICON = emojiIcon("❓");

export const ITEM_ICONS: Record<string, string> = {
  rope: iconRope,
  plank: iconWood,
  fish: iconFish,
  coin: iconCoin,
  compass: iconCompass,
  tricorn: iconHat,
  sailors_coat: iconCoat,
  leather_boots: iconBoots,
  cutlass: iconSword,
  signet_ring: iconRing,
  sword: emojiIcon("⚔️"),
  pickaxe: emojiIcon("⛏️"),
  axe: emojiIcon("🪓"),
  fishing_rod: emojiIcon("🎣"),
  hopeite_ore: emojiIcon("🪨"),
  slime_goo: emojiIcon("🟢"),
  health_potion: emojiIcon("🧪"),
};

export function iconForItem(id: string): string {
  return ITEM_ICONS[id] ?? FALLBACK_ICON;
}
