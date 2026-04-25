import * as Phaser from "phaser";
import { SaveController } from "./SaveController";
import * as saveSystems from "./systems";
import { ensureQuestSubsystem } from "../quests/activeQuestManager";
import { getPrefetchedEnvelope } from "./storeHydrate";

export const BOOT_CONTROLLER_REGISTRY_KEY = "saveController";

/** Construct and initialize the game-scoped SaveController behind the title
 *  screen: registers every saveable that writes to a module store (inventory,
 *  equipment, jobs, health, appearance, shops, flags, quests) and hydrates
 *  them from the envelope PreloadScene prefetched. Scene-bound saveables
 *  (player, ships, scene mode, ground/dropped items) are registered later by
 *  WorldScene, which then calls `controller.rehydrate()` to apply their slice.
 *
 *  Idempotent: returns the existing controller on subsequent calls (e.g. HMR).
 */
export async function bootSaveController(
  game: Phaser.Game,
): Promise<SaveController> {
  const existing = game.registry.get(BOOT_CONTROLLER_REGISTRY_KEY) as
    | SaveController
    | undefined;
  if (existing) return existing;

  const controller = new SaveController({
    // Placeholder hooks — WorldScene rebinds via setSceneHooks before
    // registering scene-bound systems + calling rehydrate().
    getSceneKey: () => "World",
    onApplied: () => {},
  });
  await controller.init();

  const q = ensureQuestSubsystem();
  controller.registerSystems([
    saveSystems.inventorySaveable(),
    saveSystems.equipmentSaveable(),
    saveSystems.jobsSaveable(),
    saveSystems.healthSaveable(),
    saveSystems.appearanceSaveable(),
    saveSystems.shopsSaveable(),
    // Flags MUST register before quests: hydrate order follows registration
    // order, and QuestManager.hydrate reads flags to reconcile cursors.
    q.flags,
    q.quests,
  ]);
  await controller.refreshMenu();

  const env = getPrefetchedEnvelope(game);
  if (env) controller.loadPrefetched(env);

  game.registry.set(BOOT_CONTROLLER_REGISTRY_KEY, controller);
  game.events.once(Phaser.Core.Events.DESTROY, () => {
    controller.shutdown();
    game.registry.remove(BOOT_CONTROLLER_REGISTRY_KEY);
  });
  return controller;
}

export function getBootedSaveController(
  game: Phaser.Game,
): SaveController | null {
  return (
    (game.registry.get(BOOT_CONTROLLER_REGISTRY_KEY) as
      | SaveController
      | undefined) ?? null
  );
}
