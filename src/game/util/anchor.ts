import { Ship, type DockedPose, type Heading, type VesselDims } from "../entities/Ship";

const SEARCH_RADIUS = 6;

/** Find the best (closest) docked pose whose footprint is entirely anchorable. */
export function findAnchorPose(
  isAnchorable: (tx: number, ty: number) => boolean,
  shipX: number,
  shipY: number,
  currentHeading: Heading,
  dims: VesselDims,
  tileSize: number,
): DockedPose | null {
  const cx = shipX / tileSize;
  const cy = shipY / tileSize;

  let best: { pose: DockedPose; cost: number } | null = null;

  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
      for (let heading = 0 as Heading; heading < 4; heading = (heading + 1) as Heading) {
        const eastWest = heading === 1 || heading === 3;
        const bboxW = eastWest ? dims.tilesLong : dims.tilesWide;
        const bboxH = eastWest ? dims.tilesWide : dims.tilesLong;
        const txGuess = Math.round(cx + dx - bboxW / 2);
        const tyGuess = Math.round(cy + dy - bboxH / 2);
        const pose: DockedPose = { tx: txGuess, ty: tyGuess, heading };

        if (!isFootprintClear(pose, isAnchorable, dims)) continue;

        const center = Ship.bboxCenterPx(pose, dims);
        const dpx = center.x - shipX;
        const dpy = center.y - shipY;
        const distSq = dpx * dpx + dpy * dpy;
        // Heading delta: 0 / 1 / 2 / (1 for 3→0 wrap) quarter-turns.
        const rawDelta = Math.abs(heading - currentHeading);
        const headingDelta = Math.min(rawDelta, 4 - rawDelta);
        const cost = distSq + headingDelta * 2000;
        if (!best || cost < best.cost) best = { pose, cost };
        if (heading === 3) break;
      }
    }
  }

  return best?.pose ?? null;
}

function isFootprintClear(
  pose: DockedPose,
  isAnchorable: (tx: number, ty: number) => boolean,
  dims: VesselDims,
): boolean {
  const fp = Ship.footprint(pose, dims);
  for (const { x, y } of fp) {
    if (!isAnchorable(x, y)) return false;
  }
  return true;
}
