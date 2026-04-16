import { Tile, type TileId } from "../world/tiles";
import { Ship, type DockedPose, type Heading, headingToRotation, normalizeAngle } from "../entities/Ship";

const SEARCH_RADIUS = 6;

/** Find the best (closest) docked pose whose footprint is entirely water/dock-free. */
export function findAnchorPose(
  tiles: TileId[][],
  mapW: number,
  mapH: number,
  shipX: number,
  shipY: number,
  shipRot: number,
  tileSize: number,
): DockedPose | null {
  const cx = shipX / tileSize;
  const cy = shipY / tileSize;

  let best: { pose: DockedPose; cost: number } | null = null;

  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
      for (let heading = 0 as Heading; heading < 4; heading = (heading + 1) as Heading) {
        // Convert candidate bbox-center tile to top-left (tx, ty) for this heading
        const bboxW = heading === 1 || heading === 3 ? 3 : 2;
        const bboxH = heading === 1 || heading === 3 ? 2 : 3;
        const txGuess = Math.round(cx + dx - bboxW / 2);
        const tyGuess = Math.round(cy + dy - bboxH / 2);
        const pose: DockedPose = { tx: txGuess, ty: tyGuess, heading };

        if (!isFootprintClear(pose, tiles, mapW, mapH)) continue;

        const center = Ship.bboxCenterPx(pose);
        const dpx = center.x - shipX;
        const dpy = center.y - shipY;
        const distSq = dpx * dpx + dpy * dpy;
        const rotDelta = Math.abs(normalizeAngle(headingToRotation(heading) - shipRot));
        const cost = distSq + rotDelta * 400; // weight rotation delta
        if (!best || cost < best.cost) best = { pose, cost };
        if (heading === 3) break;
      }
    }
  }

  return best?.pose ?? null;
}

function isFootprintClear(pose: DockedPose, tiles: TileId[][], mapW: number, mapH: number): boolean {
  const fp = Ship.footprint(pose);
  for (const { x, y } of fp) {
    if (x < 0 || x >= mapW || y < 0 || y >= mapH) return false;
    if (tiles[y][x] !== Tile.Water) return false;
  }
  return true;
}
