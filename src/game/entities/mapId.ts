/** Identifies which map an entity is currently on. The registry indexes
 *  entities by this so a scene can ask "who is on my map?" in O(1).
 *
 *  - `world`    — the open world (non-chunked view; chunks can still host
 *                 entities identified via the `chunk` variant once we wire it)
 *  - `interior` — a standalone interior tilemap keyed by its filename stem
 *  - `chunk`    — reserved for future per-chunk scoping (e.g. spawning
 *                 enemies only when the player is near); nothing emits it yet
 */
export type MapId =
  | { kind: "world" }
  | { kind: "interior"; key: string }
  | { kind: "chunk"; cx: number; cy: number };

export type MapIdKey = string;

export function mapIdKey(m: MapId): MapIdKey {
  switch (m.kind) {
    case "world":
      return "world";
    case "interior":
      return `interior:${m.key}`;
    case "chunk":
      return `chunk:${m.cx},${m.cy}`;
  }
}

export function mapIdEquals(a: MapId, b: MapId): boolean {
  return mapIdKey(a) === mapIdKey(b);
}
