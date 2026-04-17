# Maps

This is the **authoring** source for the game's maps. At runtime the game loads the **built** JSON (`.tmj`) files from `public/maps/`, produced by `npm run maps`.

## Layout

```
maps/
├── world.tmx                   # hand-authored map (edit in Tiled)
└── tilesets/
    ├── roguelike.tsx           # external tileset with per-tile properties
    └── roguelikeSheet.png      # tileset spritesheet
```

At build time, `tools/build-maps.mjs` produces:

```
public/maps/
├── world.tmj                   # runtime JSON with embedded tileset
└── tilesets/
    └── roguelikeSheet.png      # copied from maps/tilesets/
```

`npm run dev` and `npm run build` invoke `npm run maps` automatically.

## Conventions

### Tile layers (in render order, bottom to top)

| Name         | Purpose                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `ground`     | Base terrain (grass, sand, water, stone).                                |
| `overlay`    | Blended decals (puddles, dirt patches) on top of ground.                 |
| `props_low`  | Stand-on-able / walk-around props (fences, rocks, tables).               |
| `props_high` | Props that occlude the player (tree canopies, roof eaves).               |
| `roof`       | Fully above the player (solid roofs).                                    |

### Tile custom properties (authored in the TSX)

| Property   | Type | Meaning                                                               |
| ---------- | ---- | --------------------------------------------------------------------- |
| `water`    | bool | Sailable by the ship, not walkable on foot.                           |
| `collides` | bool | Blocks player movement. Applies from any layer.                       |

Walkability is "any layer wins": a water tile anywhere in the stack makes the cell water; a `collides` tile anywhere in the stack blocks the player.

### Object layer: `objects`

All gameplay-significant positions live in this object layer. Each object has a `type` and typed custom properties.

| Type         | Required properties                            | Notes                                              |
| ------------ | ---------------------------------------------- | -------------------------------------------------- |
| `ship_spawn` | `heading: string` (`"N" \| "E" \| "S" \| "W"`) | Top-left tile corner; 3×2 footprint at heading E/W. |
| `dock`       | —                                              | Player spawn / landing tile adjacent to the ship.  |
| `item_spawn` | `itemId: string`, `quantity: int`              | Point object. `itemId` must exist in `ITEMS`.      |

## Editing workflow

1. Open `maps/world.tmx` in Tiled (or `maps/tilesets/roguelike.tsx` to edit tile properties).
2. Save.
3. `npm run maps` (or just run `npm run dev` — it rebuilds first).
