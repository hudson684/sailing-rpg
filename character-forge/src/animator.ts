import type { Animation } from "./types";

export function poseAt(
  anim: Animation,
  frameIdx: number,
): Record<string, number> {
  const total = Math.max(1, anim.frames);
  const t = anim.loop
    ? (((frameIdx % total) + total) % total) / total
    : Math.min(frameIdx, total - 1) / Math.max(1, total - 1);
  const kfs = [...anim.keyframes].sort((a, b) => a.t - b.t);
  if (kfs.length === 0) return {};
  if (kfs.length === 1) return { ...(kfs[0].rot ?? {}) };
  let prev = kfs[0];
  let next = kfs[kfs.length - 1];
  for (let i = 0; i < kfs.length - 1; i++) {
    if (kfs[i].t <= t && kfs[i + 1].t >= t) {
      prev = kfs[i];
      next = kfs[i + 1];
      break;
    }
  }
  const span = Math.max(1e-6, next.t - prev.t);
  const u = (t - prev.t) / span;
  const ids = new Set([
    ...Object.keys(prev.rot ?? {}),
    ...Object.keys(next.rot ?? {}),
  ]);
  const out: Record<string, number> = {};
  for (const id of ids) {
    const a = prev.rot?.[id] ?? 0;
    const b = next.rot?.[id] ?? 0;
    out[id] = a + (b - a) * u;
  }
  return out;
}
