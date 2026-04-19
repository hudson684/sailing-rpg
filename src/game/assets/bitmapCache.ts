/**
 * IndexedDB cache for decoded tileset `ImageBitmap`s.
 *
 * Problem this solves: the service worker already caches tileset PNG bytes, but
 * the browser still has to PNG-decode each one every cold start before the
 * first frame can render. For ~17 MB of tilesets that's a meaningful hitch on
 * mobile. `ImageBitmap` is structured-cloneable, so once we've decoded an
 * image we can persist it and skip decode on subsequent sessions.
 *
 * Invalidation is by build version: every `vite build` stamps a new
 * `__BUILD_VERSION__` constant, which we store alongside each entry. On
 * mismatch we drop the entry and re-decode. Coarse but correct — a redeploy
 * always fully refreshes the cache.
 *
 * Usage pattern — Phaser's preload is synchronous but IDB isn't, so callers
 * must `await warmBitmapCache(paths)` before starting the scene, then use
 * the synchronous `takeWarmBitmap(path)` inside preload.
 */
import { createStore, get, set, del } from "idb-keyval";

// Build-stamped via vite `define`. Changes every `vite build`; in dev it's
// stable per process start.
declare const __BUILD_VERSION__: string;

const DB_NAME = "sailing-rpg-bitmaps";
const STORE_NAME = "bitmaps";

interface Entry {
  v: string;
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

type CacheStats = { hits: number; misses: number; writes: number; errors: number };
const stats: CacheStats = { hits: 0, misses: 0, writes: 0, errors: 0 };

/** Bitmaps pulled from IDB during warm(). Populated by `warmBitmapCache` and
 *  drained by `takeWarmBitmap` so BootScene can read synchronously. */
const warmed = new Map<string, ImageBitmap>();

let store: ReturnType<typeof createStore> | null = null;
let storeUnavailable = false;
function getStore(): ReturnType<typeof createStore> | null {
  if (store) return store;
  if (storeUnavailable) return null;
  if (typeof indexedDB === "undefined" || typeof createImageBitmap === "undefined") {
    storeUnavailable = true;
    return null;
  }
  try {
    store = createStore(DB_NAME, STORE_NAME);
    return store;
  } catch {
    storeUnavailable = true;
    return null;
  }
}

async function readEntry(path: string): Promise<ImageBitmap | null> {
  const s = getStore();
  if (!s) return null;
  try {
    const entry = (await get(path, s)) as Entry | undefined;
    if (!entry) return null;
    if (entry.v !== __BUILD_VERSION__) {
      void del(path, s).catch(() => {});
      return null;
    }
    return entry.bitmap;
  } catch {
    stats.errors++;
    return null;
  }
}

/**
 * Bulk-load cached bitmaps for `paths` into an in-memory map for synchronous
 * consumption. Call before starting Phaser so BootScene.preload can read via
 * `takeWarmBitmap` without awaiting.
 */
export async function warmBitmapCache(paths: Iterable<string>): Promise<void> {
  const list = [...paths];
  if (list.length === 0) return;
  await Promise.all(
    list.map(async (p) => {
      const bm = await readEntry(p);
      if (bm) {
        warmed.set(p, bm);
        stats.hits++;
      } else {
        stats.misses++;
      }
    }),
  );
}

/** Synchronously take (and remove) a warmed bitmap. Returns null on miss. */
export function takeWarmBitmap(path: string): ImageBitmap | null {
  const bm = warmed.get(path);
  if (!bm) return null;
  warmed.delete(path);
  return bm;
}

/**
 * Decode `source` into an `ImageBitmap` and persist it. Safe to
 * fire-and-forget — errors are swallowed. Skipped if IDB/createImageBitmap
 * are unavailable.
 */
export async function putCachedBitmap(
  path: string,
  source: CanvasImageSource,
): Promise<void> {
  const s = getStore();
  if (!s) return;
  try {
    const bitmap = await createImageBitmap(source);
    const entry: Entry = {
      v: __BUILD_VERSION__,
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
    };
    await set(path, entry, s);
    stats.writes++;
  } catch {
    stats.errors++;
  }
}

export function getBitmapCacheStats(): Readonly<CacheStats> {
  return stats;
}
