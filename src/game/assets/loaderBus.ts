import * as Phaser from "phaser";

/**
 * Game-wide loader event bus. Lives on the Phaser game registry so any
 * scene (HUD overlay, debug panel, future loading-status UI) can subscribe
 * without coupling to the producer (currently `ChunkManager`'s background
 * tileset streaming).
 *
 * Event payloads are intentionally minimal — consumers display them as-is
 * or aggregate counts. Adding a new event = adding a discriminated union
 * arm; no schema migration required.
 */

export type LoaderEvent =
  | { kind: "stream-start"; reason: string; total: number }
  | { kind: "stream-progress"; progress: number }
  | { kind: "stream-complete"; reason: string };

const REGISTRY_KEY = "loaderBus";
const EVENT = "event";

export function getLoaderBus(scene: Phaser.Scene): Phaser.Events.EventEmitter {
  const registry = scene.game.registry;
  let bus = registry.get(REGISTRY_KEY) as Phaser.Events.EventEmitter | undefined;
  if (!bus) {
    bus = new Phaser.Events.EventEmitter();
    registry.set(REGISTRY_KEY, bus);
  }
  return bus;
}

export function emitLoaderEvent(scene: Phaser.Scene, event: LoaderEvent): void {
  getLoaderBus(scene).emit(EVENT, event);
}

export function onLoaderEvent(
  scene: Phaser.Scene,
  handler: (event: LoaderEvent) => void,
): () => void {
  const bus = getLoaderBus(scene);
  bus.on(EVENT, handler);
  return () => bus.off(EVENT, handler);
}
