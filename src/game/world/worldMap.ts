import {
  ChunkManager,
  type Chunk,
  type WorldManifest,
} from "./chunkManager";
import type { ParsedSpawns } from "./spawns";

export interface WorldMap {
  manager: ChunkManager;
  /** Axis-aligned bounding box of authored chunks, in global tiles. */
  bounds: { minTx: number; minTy: number; maxTx: number; maxTy: number };
}

export interface LoadWorldOptions {
  scene: Phaser.Scene;
  manifest: WorldManifest;
  chunkKeyPrefix: string;
  /** Fires each time a chunk is instantiated (both up-front and as pending
   *  chunks stream in). Scene-level systems use this to register the
   *  chunk's authored spawns. */
  onChunkReady?: (chunk: Chunk, spawns: ParsedSpawns) => void;
}

export function loadWorld(opts: LoadWorldOptions): WorldMap {
  const manager = new ChunkManager(opts);
  manager.initialize();
  return {
    manager,
    bounds: manager.authoredBoundsTiles(),
  };
}
