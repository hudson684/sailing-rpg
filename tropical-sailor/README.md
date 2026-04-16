# Tropical Sailor

A top-down 2D sailing game built from scratch in **Godot 4.3+** (GDScript). All
visuals are drawn procedurally — no external art assets. Navigate a vibrant
tropical archipelago, dock at discovered ports, and let the trade winds carry
you between islands.

![icon](icon.svg)

## Features

- **Momentum-based sailing** — acceleration, drag, and turn responsiveness tied
  to current speed.
- **Dynamic wind system** — a global wind vector drifts with FastNoiseLite
  direction and oscillating strength. Sailing with the wind is fast; fighting
  it drops you to ~30% thrust.
- **Procedural world** — 6–10 organic islands scattered across an 8000 × 8000
  world, each with noise-based coastline, jungle interior, sandy beach, and
  shallow-water ring. 1–2 ports per island along the coast.
- **Dockable ports** — approach a port at low speed and press **E** to open
  the port menu. First-time visits trigger a "Discovered!" celebration.
- **Bright tropical ocean shader** — gentle sine waves and drifting sun glints.
- **Full HUD** — compass, wind direction + strength, speed gauge, circular
  minimap with nearby islands and ports, and center-bottom notifications.
- **Ambient polish** — seagulls fly across the view, port flags wave, ship
  leaves a fading wake trail.
- **Title screen** with animated ocean background and fade transition.

## Controls

| Action      | Keys            |
|-------------|-----------------|
| Raise sail  | **W** / **↑**   |
| Lower sail  | **S** / **↓**   |
| Turn left   | **A** / **←**   |
| Turn right  | **D** / **→**   |
| Dock        | **E**           |
| Pause / close menu | **Esc**  |

Mouse scroll wheel zooms the camera.

## Running the Game

1. Install **Godot 4.3** or later from <https://godotengine.org>.
2. Launch Godot → **Import** → select `tropical-sailor/project.godot`.
3. Press **F5** (or the ▶ play button) to run.

The game opens to the title screen. Press any key to begin sailing. Ports
appear as yellow dots on the minimap — steer toward one, slow down below 60
px/sec, and press **E** to dock.

## Project Structure

```
tropical-sailor/
├── project.godot        # Engine config, input map, autoloads
├── icon.svg
├── scenes/
│   ├── main.tscn        # Gameplay root
│   ├── ship.tscn        # Player vessel
│   ├── island.tscn      # Procedural island shell
│   ├── port.tscn        # Dockable port
│   ├── ocean.tscn       # Shader-animated background
│   ├── seagull.tscn     # Ambient wildlife
│   └── ui/
│       ├── hud.tscn
│       ├── port_menu.tscn
│       └── title_screen.tscn
├── scripts/
│   ├── game_manager.gd   # Autoload — discovered ports, names, seed
│   ├── wind_system.gd    # Autoload — global wind vector
│   ├── main.gd           # Gameplay coordinator
│   ├── ship.gd
│   ├── island.gd
│   ├── port.gd
│   ├── ocean.gd
│   ├── camera.gd
│   ├── world_generator.gd
│   ├── hud.gd
│   ├── port_menu.gd
│   ├── title_screen.gd
│   └── seagull.gd
└── assets/
    └── ocean.gdshader    # Procedural ocean shader
```

## Autoloads

Registered in `project.godot`:

- **GameManager** — discovered ports, tropical name pools, world seed, paused
  state.
- **WindSystem** — global wind direction/strength and
  `get_thrust_multiplier(heading)` helper used by the ship.

## Design Notes

- Ship uses `CharacterBody2D.move_and_collide` so beach collisions produce a
  bounce-back impulse and a sail-power penalty.
- The wake trail is a `Line2D` promoted to `top_level` so points stay in world
  space instead of rotating with the ship.
- Islands use three stacked `Polygon2D` layers (beach → interior → jungle) over
  a `Shallow` halo, with a `CollisionPolygon2D` matching the beach edge.
- The minimap, compass, wind indicator, and speed gauge all render via
  `_draw()` callbacks for crisp procedural visuals at any resolution.
- Viewport stretch mode is `viewport` with `keep` aspect, so the 1920×1080
  reference layout scales cleanly on any monitor.
