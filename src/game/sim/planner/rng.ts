/** Tiny deterministic PRNG (mulberry32). Seeded plans reproduce on save/load
 *  and across spawn-dispatch retries. Not cryptographic. */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string into a 32-bit seed. Used to combine an agent id + dayCount
 *  into a stable seed without needing a crypto dep. */
export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function randInt(rng: Rng, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function randRange(rng: Rng, lo: number, hi: number): number {
  if (hi <= lo) return lo;
  return lo + rng() * (hi - lo);
}

/** Weighted pick (with replacement) — `pickWeighted(rng, items, w => w.weight)`. */
export function pickWeighted<T>(rng: Rng, items: readonly T[], weight: (t: T) => number): T | null {
  if (items.length === 0) return null;
  let total = 0;
  for (const it of items) total += Math.max(0, weight(it));
  if (total <= 0) return null;
  let pick = rng() * total;
  for (const it of items) {
    pick -= Math.max(0, weight(it));
    if (pick <= 0) return it;
  }
  return items[items.length - 1];
}
