import type { Animation, Skeleton } from "./types";
import { poseAt } from "./animator";
import { computeWorld } from "./rig";

export type BakedLayer = { boneId: string; canvas: HTMLCanvasElement };

export async function loadImages(
  skel: Skeleton,
  baseUrl: string,
): Promise<Map<string, HTMLImageElement>> {
  const out = new Map<string, HTMLImageElement>();
  await Promise.all(
    skel.bones.map(
      (bone) =>
        new Promise<void>((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => {
            out.set(bone.id, img);
            resolve();
          };
          img.onerror = () =>
            reject(new Error(`Failed to load ${baseUrl}/${bone.image}`));
          img.src = `${baseUrl}/${bone.image}`;
        }),
    ),
  );
  return out;
}

export function bakeLayers(
  skel: Skeleton,
  anim: Animation,
  images: Map<string, HTMLImageElement>,
): BakedLayer[] {
  const fs = skel.frameSize;
  const out: BakedLayer[] = [];
  for (const bone of skel.bones) {
    const canvas = document.createElement("canvas");
    canvas.width = fs * anim.frames;
    canvas.height = fs;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.imageSmoothingEnabled = false;
    const img = images.get(bone.id);
    if (img) {
      for (let f = 0; f < anim.frames; f++) {
        const pose = poseAt(anim, f);
        const world = computeWorld(skel, pose);
        const m = world[bone.id];
        ctx.save();
        ctx.translate(f * fs, 0);
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        ctx.drawImage(img, 0, 0);
        ctx.restore();
      }
    }
    out.push({ boneId: bone.id, canvas });
  }
  return out;
}

export function bakeComposite(
  skel: Skeleton,
  anim: Animation,
  images: Map<string, HTMLImageElement>,
): HTMLCanvasElement {
  const fs = skel.frameSize;
  const canvas = document.createElement("canvas");
  canvas.width = fs * anim.frames;
  canvas.height = fs;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  ctx.imageSmoothingEnabled = false;
  const sorted = [...skel.bones].sort((a, b) => a.z - b.z);
  for (let f = 0; f < anim.frames; f++) {
    const pose = poseAt(anim, f);
    const world = computeWorld(skel, pose);
    for (const bone of sorted) {
      const img = images.get(bone.id);
      if (!img) continue;
      const m = world[bone.id];
      ctx.save();
      ctx.translate(f * fs, 0);
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    }
  }
  return canvas;
}
