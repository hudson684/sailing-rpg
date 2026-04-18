import { ITEMS } from "../inventory/items";
import type { Equipped } from "../equipment/operations";
import type { Player } from "./Player";
import type { CfLayer } from "./playerAnims";

/**
 * CF layers that participate in equipment-driven visuals. Order is irrelevant
 * here — Player draws layers in the canonical CF_LAYERS order regardless of
 * the order we update them in. `base`, `hands`, `hair` are excluded because
 * they're driven by the customizer (skin / haircut / glove style), not by
 * what's worn in an equipment slot.
 */
const EQUIP_LAYERS: readonly CfLayer[] = [
  "feet",
  "legs",
  "chest",
  "accessory",
  "tool",
];

/**
 * Apply the current equipment loadout to the player's paper-doll. Walks every
 * equippable layer and either sets it to the variant declared by the equipped
 * item's `visualLayer`, or clears the layer if no equipped item claims it.
 * Items in the same family (e.g. two ringL/ringR) both contributing to the
 * same visual layer is not currently supported — last write wins.
 *
 * Idempotent: safe to call after every equipment-store mutation. Skips when
 * the player isn't using the layered CF renderer (legacy Hana sprite).
 */
export function syncPlayerVisualsFromEquipment(
  player: Player,
  equipped: Equipped,
): void {
  // Build a layer→variant map from the loadout.
  const next = new Map<CfLayer, string>();
  for (const itemId of Object.values(equipped)) {
    if (!itemId) continue;
    const def = ITEMS[itemId];
    if (!def?.visualLayer) continue;
    next.set(def.visualLayer.layer as CfLayer, def.visualLayer.variant);
  }
  for (const layer of EQUIP_LAYERS) {
    const variant = next.get(layer) ?? null;
    player.setLayerToEquipmentDefault(layer, variant);
  }
}
