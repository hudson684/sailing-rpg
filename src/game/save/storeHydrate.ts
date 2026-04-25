import * as Phaser from "phaser";
import type { SaveEnvelope } from "./envelope";
import { PREFETCHED_SAVE_REGISTRY_KEY } from "../scenes/PreloadScene";

export function getPrefetchedEnvelope(game: Phaser.Game): SaveEnvelope | null {
  if (!game.registry.has(PREFETCHED_SAVE_REGISTRY_KEY)) return null;
  return game.registry.get(PREFETCHED_SAVE_REGISTRY_KEY) as SaveEnvelope | null;
}

/** Extract the player's saved tile position from an envelope, if present, so
 *  WorldScene can construct the Player sprite at the correct spot instead of
 *  spawning at the default tile and teleporting after async hydrate. */
export function getSavedPlayerSpawn(
  env: SaveEnvelope | null,
): { x: number; y: number } | null {
  const block = env?.systems?.player;
  if (!block) return null;
  const data = block.data as { x?: unknown; y?: unknown } | undefined;
  if (typeof data?.x !== "number" || typeof data?.y !== "number") return null;
  return { x: data.x, y: data.y };
}
