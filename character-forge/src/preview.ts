import type { Skeleton } from "./types";
import { computeWorld, matToCss } from "./rig";

export class RigPreview {
  private el: HTMLElement;
  private nodes = new Map<string, HTMLImageElement>();
  private skel: Skeleton | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  async load(skel: Skeleton, baseUrl: string): Promise<void> {
    this.skel = skel;
    this.el.innerHTML = "";
    this.el.style.width = `${skel.frameSize}px`;
    this.el.style.height = `${skel.frameSize}px`;
    this.nodes.clear();
    const sorted = [...skel.bones].sort((a, b) => a.z - b.z);
    const loaders: Promise<void>[] = [];
    for (const bone of sorted) {
      const img = new Image();
      img.src = `${baseUrl}/${bone.image}`;
      img.style.position = "absolute";
      img.style.left = "0";
      img.style.top = "0";
      img.style.transformOrigin = "0 0";
      img.style.imageRendering = "pixelated";
      this.el.appendChild(img);
      this.nodes.set(bone.id, img);
      loaders.push(
        new Promise<void>((resolve, reject) => {
          if (img.complete && img.naturalWidth > 0) resolve();
          else {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error(`Failed to load ${img.src}`));
          }
        }),
      );
    }
    await Promise.all(loaders);
  }

  apply(pose: Record<string, number>): void {
    if (!this.skel) return;
    const world = computeWorld(this.skel, pose);
    for (const bone of this.skel.bones) {
      const img = this.nodes.get(bone.id);
      if (!img) continue;
      img.style.transform = matToCss(world[bone.id]);
    }
  }
}
