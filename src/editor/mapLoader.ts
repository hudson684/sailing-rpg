import { loadTilesetImages, loadTmj, renderMap, type TmjMap } from "./TmjCanvas";

export type MapKind = "world" | "interior" | "ship";

export interface MapView {
  id: string;
  kind: MapKind;
  /** Width in tiles (of the composed map). */
  widthTiles: number;
  /** Height in tiles. */
  heightTiles: number;
  /** Pixel size of one tile at 1x. All sub-tilemaps share this. */
  tilePixel: number;
  /** Paints every tile layer into `ctx` at the given render scale. The
   *  canvas is assumed to already be cleared to the editor background. */
  renderTiles: (ctx: CanvasRenderingContext2D, scale: number) => void;
}

export interface WorldManifest {
  chunkSize: number;
  tileWidth: number;
  tileHeight: number;
  authoredChunks: string[];
  interiors?: Record<string, { path: string }>;
  ships?: Record<string, { path: string }>;
}

export async function fetchManifest(): Promise<WorldManifest> {
  const res = await fetch("/maps/world.json");
  if (!res.ok) throw new Error(`Failed to load world.json: ${res.status}`);
  return (await res.json()) as WorldManifest;
}

export async function loadWorldView(manifest: WorldManifest): Promise<MapView> {
  const size = manifest.chunkSize;
  const tile = manifest.tileWidth;
  // Compute bounding box over authored chunks.
  let maxCx = 0;
  let maxCy = 0;
  for (const key of manifest.authoredChunks) {
    const [cx, cy] = key.split("_").map(Number);
    if (cx > maxCx) maxCx = cx;
    if (cy > maxCy) maxCy = cy;
  }
  const widthTiles = (maxCx + 1) * size;
  const heightTiles = (maxCy + 1) * size;

  const chunks = await Promise.all(
    manifest.authoredChunks.map(async (key) => {
      const [cx, cy] = key.split("_").map(Number);
      const tmj = await loadTmj(`/maps/chunks/${key}.tmj`);
      const images = await loadTilesetImages(tmj);
      return { cx, cy, tmj, images };
    }),
  );

  return {
    id: "world",
    kind: "world",
    widthTiles,
    heightTiles,
    tilePixel: tile,
    renderTiles(ctx, scale) {
      for (const c of chunks) {
        renderMap(ctx, c.tmj, c.images, scale, c.cx * size * tile, c.cy * size * tile);
      }
    },
  };
}

export async function loadSingleTmjView(
  id: string,
  kind: "interior" | "ship",
  path: string,
): Promise<MapView> {
  const tmj = await loadTmj(`/maps/${path}`);
  const images = await loadTilesetImages(tmj);
  return singleTmjView(id, kind, tmj, images);
}

function singleTmjView(
  id: string,
  kind: "interior" | "ship",
  tmj: TmjMap,
  images: Map<number, HTMLImageElement>,
): MapView {
  return {
    id,
    kind,
    widthTiles: tmj.width,
    heightTiles: tmj.height,
    tilePixel: tmj.tilewidth,
    renderTiles(ctx, scale) {
      renderMap(ctx, tmj, images, scale);
    },
  };
}
