import { ChunkManager, type WorldManifest } from "./chunkManager";
import type { ParsedSpawns } from "./spawns";

export interface WorldMap {
  manager: ChunkManager;
  spawns: ParsedSpawns;
  /** Axis-aligned bounding box of authored chunks, in global tiles. */
  bounds: { minTx: number; minTy: number; maxTx: number; maxTy: number };
}

export interface LoadWorldOptions {
  scene: Phaser.Scene;
  manifest: WorldManifest;
  chunkKeyPrefix: string;
}

export function loadWorld(opts: LoadWorldOptions): WorldMap {
  const manager = new ChunkManager(opts);
  const spawns = manager.initialize();
  return {
    manager,
    spawns,
    bounds: manager.authoredBoundsTiles(),
  };
}
