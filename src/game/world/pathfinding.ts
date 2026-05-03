import { TILE_SIZE } from "../constants";

/** A pixel-space waypoint along a path. Tile-center for intermediate hops,
 *  exact requested pixel for the final waypoint. */
export interface Waypoint {
  x: number;
  y: number;
}

export interface PathfindOptions {
  /** Walkability oracle — given a pixel position, returns whether an entity
   *  can stand on that tile. The pathfinder samples tile centers so the
   *  oracle should be tile-stable (i.e. consistent across the same tile). */
  isWalkablePx: (px: number, py: number) => boolean;
  /** Where the agent is now. Tile is computed as `floor(x / TILE_SIZE)`. */
  fromPx: Waypoint;
  /** Where the agent wants to end up. The exact pixel is preserved as the
   *  final waypoint, so callers get pixel-precision arrival even though the
   *  search itself is tile-coarse. */
  toPx: Waypoint;
  /** Maximum tiles to expand before giving up. Defaults to 8192 — enough
   *  to fully explore a 64×64 interior or chunk-bounded outdoor zone with
   *  headroom, small enough to keep worst-case search sub-millisecond on
   *  JS. Bump up for very large maps; consider switching to A* with a
   *  heuristic instead. */
  maxNodes?: number;
  /** Allow the goal tile itself to be non-walkable (counters, stoves,
   *  bars). Defaults to true: callers pass workstation tiles directly and
   *  agents arrive within ARRIVE_RADIUS via their movement code's stuck
   *  detector. Set false when the agent must physically stand on the goal
   *  (e.g. seats). */
  allowNonWalkableGoal?: boolean;
}

/** Returns a walkable pixel inside the given tile, or null if no sample
 *  point passes the oracle. Tries the center first, then four mid-edge
 *  points (¼ inset from each side). Used both as a binary "is this tile
 *  traversable" check and as the entry-point snapper during path
 *  reconstruction.
 *
 *  Why this isn't just a center sample: doorway tiles are commonly
 *  authored with a collision shape covering the lintel/jambs (top half +
 *  sides) while leaving the lower threshold open. The tile center sits
 *  inside the lintel shape and reports blocked, but the player walks
 *  through the open lower portion. Center-only sampling would prune
 *  those doorways from the BFS *and* — if the tile's traversability is
 *  somehow detected by edge sampling — would still aim agents at the
 *  blocked center pixel during path-following. By snapping each waypoint
 *  to whichever sample passed, agents get steered through the open
 *  threshold instead of into the lintel.
 *
 *  Note: this only proves *some* part of the tile is walkable. Whether
 *  the agent can actually reach that part from a neighbor tile is a
 *  separate connectivity check — see `lineWalkable` below. */
function tileEntryPx(
  tx: number,
  ty: number,
  isWalkablePx: (px: number, py: number) => boolean,
): Waypoint | null {
  const cx = (tx + 0.5) * TILE_SIZE;
  const cy = (ty + 0.5) * TILE_SIZE;
  const off = TILE_SIZE * 0.25;
  if (isWalkablePx(cx, cy)) return { x: cx, y: cy };
  if (isWalkablePx(cx, cy + off)) return { x: cx, y: cy + off };
  if (isWalkablePx(cx, cy - off)) return { x: cx, y: cy - off };
  if (isWalkablePx(cx - off, cy)) return { x: cx - off, y: cy };
  if (isWalkablePx(cx + off, cy)) return { x: cx + off, y: cy };
  return null;
}

/** Sample the straight line between two waypoints and verify every probe
 *  point is walkable. Used to reject BFS transitions where the straight
 *  walk between two tiles' waypoint pixels would clip through a collision
 *  shape — most commonly a long horizontal piece of furniture (bar, rug
 *  with collision, bench) that has a sliver of walkable space at top and
 *  bottom but is solid in the middle. Without this check, multi-sample
 *  traversability would happily accept the tile and the agent would dead-
 *  end at the actual obstacle.
 *
 *  Samples 4 evenly-spaced interior points (skipping the endpoints, since
 *  those are the waypoints themselves and already pass). Adjacent tiles
 *  are at most √2 × TILE_SIZE apart, so 4 samples (~5px on a 16px tile)
 *  catch any obstacle wider than a few pixels — fine-grained enough for
 *  authored collision but cheap enough to run on every BFS edge. */
function lineWalkable(
  a: Waypoint,
  b: Waypoint,
  isWalkablePx: (px: number, py: number) => boolean,
): boolean {
  const samples = 4;
  for (let i = 1; i <= samples; i++) {
    const t = i / (samples + 1);
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    if (!isWalkablePx(px, py)) return false;
  }
  return true;
}

/** Octile distance — admissible, consistent heuristic for 8-connected
 *  grids with axial cost 1 and diagonal cost √2. Equals the cost of the
 *  shortest path on an empty grid: as many diagonals as possible
 *  (cheaper per-tile-of-progress than two axials), then straight axial
 *  steps to cover the remaining gap. */
function octileDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/** Binary min-heap over `[tx, ty, fScore]` triplets, ordered by fScore.
 *  The open set in A* is hammered with push/pop so a proper heap matters:
 *  for a 4000-node search a sorted-array fallback is O(n²) total
 *  (~16M ops) while a heap stays O(n log n) (~50k ops). Implemented inline
 *  to avoid pulling in a third-party priority-queue dependency. */
type HeapNode = [number, number, number]; // [tx, ty, fScore]

class MinHeap {
  private items: HeapNode[] = [];
  size(): number { return this.items.length; }
  push(node: HeapNode): void {
    this.items.push(node);
    this.siftUp(this.items.length - 1);
  }
  pop(): HeapNode | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      this.siftDown(0);
    }
    return top;
  }
  private siftUp(i: number): void {
    const items = this.items;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (items[i][2] < items[p][2]) {
        const tmp = items[i];
        items[i] = items[p];
        items[p] = tmp;
        i = p;
      } else break;
    }
  }
  private siftDown(i: number): void {
    const items = this.items;
    const n = items.length;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let best = i;
      if (l < n && items[l][2] < items[best][2]) best = l;
      if (r < n && items[r][2] < items[best][2]) best = r;
      if (best === i) break;
      const tmp = items[i];
      items[i] = items[best];
      items[best] = tmp;
      i = best;
    }
  }
}

/** Tile-based 8-connected A* pathfinder. Returns a list of pixel waypoints
 *  the agent should walk through — excluding the starting tile. Returns
 *  `null` when the goal is unreachable or the search exceeds `maxNodes`.
 *
 *  Cost model: axial moves cost 1, diagonal moves cost √2. Heuristic is
 *  octile distance to the goal — admissible and consistent, so A* finds
 *  the optimal path without ever revisiting a node from a worse parent.
 *
 *  Corner-cutting is disallowed: a diagonal step from (x,y) to (x+dx,y+dy)
 *  requires both adjacent axial neighbors `(x+dx, y)` and `(x, y+dy)` to
 *  be walkable too. Without this, agents can squeeze diagonally through
 *  the 1-pixel gap where two perpendicular walls meet.
 *
 *  Each tile transition is also gated on the line-of-sight check between
 *  the source and destination entry waypoints, so partially-blocked tiles
 *  (bars, benches, rugs with collision shapes) don't get walked through
 *  even when a sliver of them is technically walkable. See `lineWalkable`. */
export function pathfindPx(opts: PathfindOptions): Waypoint[] | null {
  const {
    isWalkablePx,
    fromPx,
    toPx,
    maxNodes = 8192,
    allowNonWalkableGoal = true,
  } = opts;

  const startTx = Math.floor(fromPx.x / TILE_SIZE);
  const startTy = Math.floor(fromPx.y / TILE_SIZE);
  const goalTx = Math.floor(toPx.x / TILE_SIZE);
  const goalTy = Math.floor(toPx.y / TILE_SIZE);

  if (startTx === goalTx && startTy === goalTy) {
    return [{ x: toPx.x, y: toPx.y }];
  }

  // key "x,y" → parent key. `null` for the start tile.
  const parents = new Map<string, string | null>();
  // key → cheapest known path cost from start. Updated when a better
  // parent is found.
  const gScore = new Map<string, number>();
  // key → walkable pixel chosen as the agent's entry point for that tile.
  const entries = new Map<string, Waypoint>();
  // Closed set: tiles whose optimal path has been finalized. With a
  // consistent heuristic the first time a tile is popped from the heap is
  // guaranteed-optimal; subsequent stale heap entries get skipped here.
  const closed = new Set<string>();

  const startKey = `${startTx},${startTy}`;
  parents.set(startKey, null);
  gScore.set(startKey, 0);
  entries.set(startKey, { x: fromPx.x, y: fromPx.y });

  const open = new MinHeap();
  open.push([startTx, startTy, octileDistance(startTx, startTy, goalTx, goalTy)]);

  // [dx, dy, cost] — first 4 are axial (cost 1), last 4 are diagonal (√2).
  const dirs: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];

  let goalReached = false;
  while (open.size() > 0 && closed.size < maxNodes) {
    const popped = open.pop()!;
    const [x, y] = popped;
    const fromKey = `${x},${y}`;
    if (closed.has(fromKey)) continue; // stale heap entry
    closed.add(fromKey);
    if (x === goalTx && y === goalTy) {
      goalReached = true;
      break;
    }
    const curG = gScore.get(fromKey)!;
    const fromEntry = entries.get(fromKey)!;

    for (const [dx, dy, stepCost] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (closed.has(key)) continue;

      // Diagonal moves require both axial neighbors to be walkable, else
      // we'd let agents slip through the corner of a wall junction.
      if (dx !== 0 && dy !== 0) {
        if (!tileEntryPx(x + dx, y, isWalkablePx)) continue;
        if (!tileEntryPx(x, y + dy, isWalkablePx)) continue;
      }

      const isGoal = nx === goalTx && ny === goalTy;
      let dstEntry: Waypoint;
      if (isGoal && allowNonWalkableGoal) {
        // Goal tile may be a non-walkable workstation; aim at the caller's
        // exact pixel and let ARRIVE_RADIUS in the movement layer absorb
        // the last few pixels of drift.
        dstEntry = { x: toPx.x, y: toPx.y };
      } else {
        const e = tileEntryPx(nx, ny, isWalkablePx);
        if (!e) continue;
        dstEntry = e;
      }

      // Same line-of-sight gate as before — rejects routes that would
      // clip a partially-blocked tile (bar, bench) even if its walkable
      // sample is reachable in isolation.
      if (!lineWalkable(fromEntry, dstEntry, isWalkablePx)) continue;

      const tentativeG = curG + stepCost;
      const existingG = gScore.get(key);
      if (existingG !== undefined && tentativeG >= existingG) continue;

      gScore.set(key, tentativeG);
      parents.set(key, fromKey);
      entries.set(key, dstEntry);
      const f = tentativeG + octileDistance(nx, ny, goalTx, goalTy);
      open.push([nx, ny, f]);
    }
  }

  if (!goalReached) return null;

  // Reconstruct path from goal back to start using the recorded entry
  // points, so each waypoint sits on the same walkable pixel that A*
  // proved was reachable from the previous tile.
  const path: Waypoint[] = [];
  let cursor: string | null = `${goalTx},${goalTy}`;
  while (cursor) {
    const entry = entries.get(cursor);
    if (entry) path.unshift(entry);
    cursor = parents.get(cursor) ?? null;
  }
  // Drop the start tile (agent is already standing there).
  path.shift();
  if (path.length === 0) return [{ x: toPx.x, y: toPx.y }];
  return path;
}

/** Returns true when `path`'s endpoint no longer matches `target` — i.e.
 *  the agent's destination has changed and the cached path needs to be
 *  recomputed. Used by walker loops to avoid re-pathing every frame.
 *  1px tolerance absorbs floating-point drift in target coordinates. */
export function pathStale(
  path: Waypoint[] | null,
  target: Waypoint,
): boolean {
  if (!path || path.length === 0) return true;
  const last = path[path.length - 1];
  return Math.abs(last.x - target.x) > 1 || Math.abs(last.y - target.y) > 1;
}
