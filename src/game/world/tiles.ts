export const Tile = {
  Water: 0,
  Sand: 1,
  Grass: 2,
  Rock: 3,
  Dock: 4,
} as const;

export type TileId = (typeof Tile)[keyof typeof Tile];

export const TILE_COLORS: Record<TileId, number> = {
  [Tile.Water]: 0x1f4a78,
  [Tile.Sand]: 0xe8d18a,
  [Tile.Grass]: 0x3d8a4a,
  [Tile.Rock]: 0x4a4a52,
  [Tile.Dock]: 0x7a5230,
};

export function isWalkable(id: TileId): boolean {
  return id === Tile.Sand || id === Tile.Grass || id === Tile.Dock;
}

export function isWater(id: TileId): boolean {
  return id === Tile.Water;
}

export function isSolid(id: TileId): boolean {
  return id === Tile.Rock;
}
