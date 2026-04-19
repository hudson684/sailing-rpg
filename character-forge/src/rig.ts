import type { Skeleton } from "./types";

export type Mat = [number, number, number, number, number, number];

export const I: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m1: Mat, m2: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function translate(x: number, y: number): Mat {
  return [1, 0, 0, 1, x, y];
}

export function rotate(deg: number): Mat {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

export function computeWorld(
  skel: Skeleton,
  pose: Record<string, number>,
): Record<string, Mat> {
  const byId = new Map(skel.bones.map((b) => [b.id, b]));
  const out: Record<string, Mat> = {};
  const root = translate(skel.origin.x, skel.origin.y);
  function compute(id: string): Mat {
    const cached = out[id];
    if (cached) return cached;
    const bone = byId.get(id);
    if (!bone) throw new Error(`Unknown bone: ${id}`);
    const parentM = bone.parent ? compute(bone.parent) : root;
    const rot = (pose[bone.id] ?? 0) + bone.rest;
    const local = mul(
      translate(bone.joint.x, bone.joint.y),
      mul(rotate(rot), translate(-bone.pivot.x, -bone.pivot.y)),
    );
    const m = mul(parentM, local);
    out[id] = m;
    return m;
  }
  for (const b of skel.bones) compute(b.id);
  return out;
}

export function matToCss(m: Mat): string {
  return `matrix(${m[0]},${m[1]},${m[2]},${m[3]},${m[4]},${m[5]})`;
}
