/**
 * Resolves def sprite definitions (from npcs/enemies/nodes JSON) into a
 * source rectangle on a cached image — enough for the editor to draw
 * one "idle" frame per entity. Layered character models and ships are
 * not resolved here; the caller falls back to a colored marker.
 */

export interface SpriteFrame {
  image: HTMLImageElement;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

const cache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  let p = cache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load ${src}`));
      img.src = src;
    });
    cache.set(src, p);
  }
  return p;
}

/** NPC: prefer `sprite.idle` if present; skip if layered-only.
 *  Directional NPCs nest per-direction sheets — fall back to `idle.side`
 *  (or `down` if no side) so the editor still shows one frame. */
export async function loadNpcFrame(def: unknown): Promise<SpriteFrame | null> {
  type Sheet = { sheet?: string; frameWidth?: number; frameHeight?: number; start?: number };
  const d = def as {
    sprite?: { idle?: Sheet & { side?: Sheet; down?: Sheet; up?: Sheet } };
  };
  const idleEntry = d.sprite?.idle;
  if (!idleEntry) return null;
  const idle: Sheet = idleEntry.sheet
    ? idleEntry
    : idleEntry.side ?? idleEntry.down ?? idleEntry.up ?? {};
  if (!idle.sheet || !idle.frameWidth || !idle.frameHeight) return null;
  const image = await loadImage(`/${idle.sheet.replace(/^\/+/, "")}`);
  const cols = Math.max(1, Math.floor(image.width / idle.frameWidth));
  const start = idle.start ?? 0;
  return {
    image,
    sx: (start % cols) * idle.frameWidth,
    sy: Math.floor(start / cols) * idle.frameHeight,
    sw: idle.frameWidth,
    sh: idle.frameHeight,
  };
}

/** Enemy: sprite sheet with `anims.idle.row` pointing at the row. */
export async function loadEnemyFrame(def: unknown): Promise<SpriteFrame | null> {
  const d = def as {
    sprite?: {
      sheet?: string;
      frameWidth?: number;
      frameHeight?: number;
      sheetCols?: number;
      anims?: { idle?: { row?: number } };
    };
  };
  const s = d.sprite;
  if (!s?.sheet || !s.frameWidth || !s.frameHeight) return null;
  const image = await loadImage(`/${s.sheet.replace(/^\/+/, "")}`);
  const row = s.anims?.idle?.row ?? 0;
  return {
    image,
    sx: 0,
    sy: row * s.frameHeight,
    sw: s.frameWidth,
    sh: s.frameHeight,
  };
}

/** Node: simple strip; first frame. */
export async function loadNodeFrame(def: unknown): Promise<SpriteFrame | null> {
  const d = def as {
    sprite?: { sheet?: string; frameWidth?: number; frameHeight?: number };
  };
  const s = d.sprite;
  if (!s?.sheet || !s.frameWidth || !s.frameHeight) return null;
  const image = await loadImage(`/${s.sheet.replace(/^\/+/, "")}`);
  return { image, sx: 0, sy: 0, sw: s.frameWidth, sh: s.frameHeight };
}

/** Decoration: same shape as node — first frame of a horizontal strip. */
export async function loadDecorationFrame(def: unknown): Promise<SpriteFrame | null> {
  return loadNodeFrame(def);
}
