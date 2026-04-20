/**
 * Phaser cache key constants and helpers shared across scenes and asset
 * loaders. Lives outside any one scene so the Boot/Preload/Title/World
 * triad can all reference the same keys without an import cycle.
 */

export const WORLD_MANIFEST_KEY = "worldManifest";
export const CHUNK_KEY_PREFIX = "chunk_";
export const INTERIOR_KEY_PREFIX = "interior_";

export const interiorTilemapKey = (key: string) => `${INTERIOR_KEY_PREFIX}${key}`;
export const itemIconTextureKey = (id: string) => `item_icon_${id}`;
