import * as Phaser from "phaser";
import { onVirtualKey, type VirtualKey } from "./virtualInput";

/**
 * Route virtual-key dispatches (from mobile touch controls) into a scene's
 * Phaser `Key` objects. The same mechanism drives both `isDown` polling and
 * registered `"down"`/`"up"` listeners, so gameplay code never needs to
 * distinguish touch input from the keyboard.
 *
 * Each scene supplies a mapping of its own Key instances. Returns an
 * unsubscribe. The bridge also releases any still-pressed virtual keys on
 * the scene's SHUTDOWN event so a held touch doesn't leak across scenes.
 */
export function bindSceneToVirtualInput(
  scene: Phaser.Scene,
  mapping: Partial<Record<VirtualKey, Phaser.Input.Keyboard.Key>>,
): () => void {
  const pressed = new Set<VirtualKey>();

  const unsub = onVirtualKey((name, down) => {
    const key = mapping[name];
    if (!key) return;
    const event = {
      keyCode: key.keyCode,
      timeStamp: performance.now(),
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
      preventDefault: () => {},
      stopImmediatePropagation: () => {},
    } as unknown as KeyboardEvent;
    if (down) {
      key.onDown(event);
      pressed.add(name);
    } else {
      key.onUp(event);
      pressed.delete(name);
    }
  });

  const releaseAll = () => {
    for (const name of pressed) {
      const key = mapping[name];
      if (!key) continue;
      const event = {
        keyCode: key.keyCode,
        timeStamp: performance.now(),
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
        preventDefault: () => {},
        stopImmediatePropagation: () => {},
      } as unknown as KeyboardEvent;
      key.onUp(event);
    }
    pressed.clear();
  };

  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    unsub();
    releaseAll();
  });

  return () => {
    unsub();
    releaseAll();
  };
}
