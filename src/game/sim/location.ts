export type Facing = "up" | "down" | "left" | "right";

export type SceneKey = `chunk:${string}` | `interior:${string}`;

export interface WorldLocation {
  readonly sceneKey: SceneKey;
  readonly tileX: number;
  readonly tileY: number;
  readonly facing: Facing;
}

export function isChunkScene(key: SceneKey): boolean {
  return key.startsWith("chunk:");
}

export function isInteriorScene(key: SceneKey): boolean {
  return key.startsWith("interior:");
}

export function chunkScene(chunkId: string): SceneKey {
  return `chunk:${chunkId}` as SceneKey;
}

export function interiorScene(interiorId: string): SceneKey {
  return `interior:${interiorId}` as SceneKey;
}

export function sameScene(a: WorldLocation, b: WorldLocation): boolean {
  return a.sceneKey === b.sceneKey;
}

export function tileDistance(a: WorldLocation, b: WorldLocation): number {
  if (!sameScene(a, b)) return Infinity;
  const dx = a.tileX - b.tileX;
  const dy = a.tileY - b.tileY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function tileManhattan(a: WorldLocation, b: WorldLocation): number {
  if (!sameScene(a, b)) return Infinity;
  return Math.abs(a.tileX - b.tileX) + Math.abs(a.tileY - b.tileY);
}
