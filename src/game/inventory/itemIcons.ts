// Icon URLs for item ids. Kept separate from items.json because icons are
// bundler-resolved imports (Vite fingerprints the PNGs), so they can't live
// inside a plain JSON file. Emoji items use inline SVG data URLs.

import iconRope from "../../ui/icons/inventory/item_rope.png";
import iconFish from "../../ui/icons/inventory/item_fish.png";
import iconCoin from "../../ui/icons/inventory/item_coin.png";
import iconCompass from "../../ui/icons/inventory/item_compass.png";
import iconHat from "../../ui/icons/inventory/item_hat.png";
import iconCoat from "../../ui/icons/inventory/item_coat.png";
import iconBoots from "../../ui/icons/inventory/item_boots.png";
import iconSword from "../../ui/icons/inventory/item_sword.png";
import iconSwordBasic from "../../ui/icons/inventory/item_sword_basic.png";
import iconPickaxe from "../../ui/icons/inventory/item_pickaxe.png";
import iconAxe from "../../ui/icons/inventory/item_axe.png";
import iconFishingRod from "../../ui/icons/inventory/item_fishing_rod.png";
import iconHopeiteOre from "../../ui/icons/inventory/item_hopeite_ore.png";
import iconSlimeGoo from "../../ui/icons/inventory/item_slime_goo.png";
import iconHealthPotion from "../../ui/icons/inventory/item_health_potion.png";
import iconRing from "../../ui/icons/inventory/item_ring.png";
import iconArrow from "../../ui/icons/inventory/item_arrow.png";
import iconBow from "../../ui/icons/inventory/item_bow.png";
import iconPlank from "../../ui/icons/inventory/item_plank.png";

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
  plank: iconPlank,
  fish: iconFish,
  coin: iconCoin,
  compass: iconCompass,
  tricorn: iconHat,
  sailors_coat: iconCoat,
  leather_boots: iconBoots,
  cutlass: iconSword,
  signet_ring: iconRing,
  sword: iconSwordBasic,
  pickaxe: iconPickaxe,
  axe: iconAxe,
  fishing_rod: iconFishingRod,
  hopeite_ore: iconHopeiteOre,
  slime_goo: iconSlimeGoo,
  health_potion: iconHealthPotion,
  bow: iconBow,
  arrow: iconArrow,
  hopeite_ingot: emojiIcon("🧈"),
  hopeite_sword: iconSword,
  hopeite_pickaxe: iconPickaxe,
  hopeite_axe: iconAxe,
  smithing_hammer: emojiIcon("🔨"),
};

export function iconForItem(id: string): string {
  return ITEM_ICONS[id] ?? FALLBACK_ICON;
}
