import { ITEMS } from "../inventory/items";
import type { Equipped } from "../equipment/operations";
import type { Player } from "./Player";
import type { CfLayer } from "./playerAnims";
import { useGameStore } from "../store/gameStore";
import { useSettingsStore } from "../store/settingsStore";
import { CF_WARDROBE_LAYERS } from "./playerWardrobe";

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

/** Apply the persisted wardrobe + equipment to `player` immediately, then keep
 *  it in sync by subscribing to the relevant stores. Returns an unsubscribe
 *  function — call it on scene shutdown. Both WorldScene and InteriorScene
 *  build their own Player instance per scene start, so each scene calls this
 *  in `create()` to bind that scene-local Player to the global stores. */
export function bindPlayerVisualSubscriptions(player: Player): () => void {
  const initialWardrobe = useSettingsStore.getState().wardrobe;
  for (const layer of CF_WARDROBE_LAYERS) {
    player.setBaselineLayer(layer, initialWardrobe[layer] ?? null);
  }
  syncPlayerVisualsFromEquipment(player, useGameStore.getState().equipment.equipped);

  const unsubEquipment = useGameStore.subscribe((state, prev) => {
    if (state.equipment.equipped === prev.equipment.equipped) return;
    syncPlayerVisualsFromEquipment(player, state.equipment.equipped);
  });
  const unsubWardrobe = useSettingsStore.subscribe((state, prev) => {
    if (state.wardrobe === prev.wardrobe) return;
    for (const layer of CF_WARDROBE_LAYERS) {
      const next = state.wardrobe[layer] ?? null;
      const previous = prev.wardrobe[layer] ?? null;
      if (next !== previous) player.setBaselineLayer(layer, next);
    }
    // Re-overlay equipment so a wardrobe change to a slot occupied by gear
    // doesn't visually drop the equipped item.
    syncPlayerVisualsFromEquipment(player, useGameStore.getState().equipment.equipped);
  });

  return () => {
    unsubEquipment();
    unsubWardrobe();
  };
}
