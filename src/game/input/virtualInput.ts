/**
 * Bridge between on-screen touch controls (React) and Phaser's keyboard.
 *
 * The UI calls `dispatchVirtualKey` on press/release. The active WorldScene
 * subscribes via `onVirtualKey` and forwards to `Key.processKeyDown/Up`,
 * which drives both `isDown` polling and registered `"down"` handlers.
 */
export type VirtualKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "attack"
  | "interact"
  | "sprint";

type Listener = (key: VirtualKey, pressed: boolean) => void;

const listeners = new Set<Listener>();

export function dispatchVirtualKey(key: VirtualKey, pressed: boolean): void {
  for (const l of listeners) l(key, pressed);
}

export function onVirtualKey(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
