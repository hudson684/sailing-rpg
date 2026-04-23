/**
 * Minimal canvas-based renderer for Tiled TMJ maps. Draws only the
 * tile layers — no animations, no object layers, no y-sort, no
 * overhead-layer fade logic. Purpose: give the Phase 3 spawn editor
 * enough visual context to place entities.
 *
 * Limitations (follow-up work):
 * - Chunked world maps are not supported — this only handles
 *   finite-size interior TMJs (interiors/*.tmj, ships/*.tmj).
 * - Animated tiles render their first frame only.
 * - Overhead props_high / roof layers draw on top of markers; this
 *   is intentional until we port the fade logic.
 */

export interface TmjTileset {
  firstgid: number;
  image: string;
  imagewidth: number;
  imageheight: number;
  tilewidth: number;
  tileheight: number;
  columns: number;
  tilecount: number;
  spacing?: number;
  margin?: number;
}

export interface TmjLayer {
  name: string;
  type: string;
  width?: number;
  height?: number;
  data?: number[];
  visible?: boolean;
}

export interface TmjMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  tilesets: TmjTileset[];
  layers: TmjLayer[];
}

// Tiled flip-flag bits in the high nibble of a GID.
const FLIP_H = 0x80000000;
const FLIP_V = 0x40000000;
const FLIP_D = 0x20000000;
const GID_MASK = 0x1fffffff;

export async function loadTmj(path: string): Promise<TmjMap> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load TMJ ${path}: ${res.status}`);
  return (await res.json()) as TmjMap;
}

export async function loadTilesetImages(
  tmj: TmjMap,
): Promise<Map<number, HTMLImageElement>> {
  const byFirstGid = new Map<number, HTMLImageElement>();
  await Promise.all(
    tmj.tilesets.map(async (ts) => {
      const img = await loadImage(resolveAsset(ts.image));
      byFirstGid.set(ts.firstgid, img);
    }),
  );
  return byFirstGid;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image ${src}`));
    img.src = src;
  });
}

function resolveAsset(rel: string): string {
  // Tileset paths in the built TMJs are maps/-relative (the map build
  // pipeline rewrites them), so resolve against public/maps/.
  return `/maps/${rel.replace(/^\.?\/+/, "")}`;
}

export function renderMap(
  ctx: CanvasRenderingContext2D,
  tmj: TmjMap,
  images: Map<number, HTMLImageElement>,
  scale: number,
  offsetX = 0,
  offsetY = 0,
): void {
  const tw = tmj.tilewidth;
  const th = tmj.tileheight;
  ctx.imageSmoothingEnabled = false;

  const tilesetsByFirstGid = tmj.tilesets
    .slice()
    .sort((a, b) => b.firstgid - a.firstgid);

  for (const layer of tmj.layers) {
    if (layer.type !== "tilelayer") continue;
    if (layer.visible === false) continue;
    if (!layer.data || !layer.width || !layer.height) continue;
    for (let ty = 0; ty < layer.height; ty++) {
      for (let tx = 0; tx < layer.width; tx++) {
        const raw = layer.data[ty * layer.width + tx];
        if (!raw) continue;
        const gid = raw & GID_MASK;
        if (gid === 0) continue;
        const ts = tilesetsByFirstGid.find((t) => gid >= t.firstgid);
        if (!ts) continue;
        const img = images.get(ts.firstgid);
        if (!img) continue;
        const localId = gid - ts.firstgid;
        const sx = (localId % ts.columns) * (ts.tilewidth + (ts.spacing ?? 0)) + (ts.margin ?? 0);
        const sy = Math.floor(localId / ts.columns) * (ts.tileheight + (ts.spacing ?? 0)) + (ts.margin ?? 0);
        const dx = (offsetX + tx * tw) * scale;
        const dy = (offsetY + ty * th) * scale;
        const dw = ts.tilewidth * scale;
        const dh = ts.tileheight * scale;
        const flipped =
          (raw & FLIP_H) !== 0 || (raw & FLIP_V) !== 0 || (raw & FLIP_D) !== 0;
        if (!flipped) {
          ctx.drawImage(img, sx, sy, ts.tilewidth, ts.tileheight, dx, dy, dw, dh);
        } else {
          ctx.save();
          ctx.translate(dx + dw / 2, dy + dh / 2);
          if ((raw & FLIP_D) !== 0) {
            ctx.rotate(Math.PI / 2);
            ctx.scale(1, -1);
          }
          if ((raw & FLIP_H) !== 0) ctx.scale(-1, 1);
          if ((raw & FLIP_V) !== 0) ctx.scale(1, -1);
          ctx.drawImage(
            img,
            sx,
            sy,
            ts.tilewidth,
            ts.tileheight,
            -dw / 2,
            -dh / 2,
            dw,
            dh,
          );
          ctx.restore();
        }
      }
    }
  }
}
