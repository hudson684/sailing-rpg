import type { Animation, AnimationsManifest, Skeleton } from "./types";
import { poseAt } from "./animator";
import { RigPreview } from "./preview";
import { bakeComposite, bakeLayers, loadImages } from "./baker";

const charSel = document.getElementById("character-select") as HTMLSelectElement;
const animSel = document.getElementById("anim-select") as HTMLSelectElement;
const fpsInput = document.getElementById("fps-input") as HTMLInputElement;
const bakeBtn = document.getElementById("bake-btn") as HTMLButtonElement;
const rigEl = document.getElementById("rig") as HTMLElement;
const bakeOut = document.getElementById("bake-preview") as HTMLElement;

const preview = new RigPreview(rigEl);

let currentSkel: Skeleton | null = null;
let currentAnim: Animation | null = null;
let baseUrl = "";

const characters = ["sample"];

async function selectCharacter(name: string): Promise<void> {
  baseUrl = `/characters/${name}`;
  const skel = (await fetch(`${baseUrl}/skeleton.json`).then((r) => r.json())) as Skeleton;
  currentSkel = skel;
  await preview.load(skel, baseUrl);
  const manifest = (await fetch(`${baseUrl}/animations.json`).then((r) => r.json())) as AnimationsManifest;
  animSel.innerHTML = manifest.animations
    .map((a) => `<option value="${a}">${a}</option>`)
    .join("");
  await selectAnim(manifest.animations[0]);
}

async function selectAnim(name: string): Promise<void> {
  if (!currentSkel) return;
  const anim = (await fetch(`${baseUrl}/anims/${name}.json`).then((r) => r.json())) as Animation;
  currentAnim = anim;
}

charSel.addEventListener("change", () => void selectCharacter(charSel.value));
animSel.addEventListener("change", () => void selectAnim(animSel.value));

bakeBtn.addEventListener("click", async () => {
  if (!currentSkel || !currentAnim) return;
  bakeBtn.disabled = true;
  try {
    bakeOut.innerHTML = "";
    const images = await loadImages(currentSkel, baseUrl);
    const composite = bakeComposite(currentSkel, currentAnim, images);
    appendBake(`${currentAnim.name}.composite.png`, composite);
    const layers = bakeLayers(currentSkel, currentAnim, images);
    for (const layer of layers) {
      appendBake(`${currentAnim.name}.${layer.boneId}.png`, layer.canvas);
    }
  } finally {
    bakeBtn.disabled = false;
  }
});

function appendBake(name: string, canvas: HTMLCanvasElement): void {
  const wrap = document.createElement("div");
  wrap.className = "bake-item";
  const label = document.createElement("div");
  label.className = "label";
  const url = canvas.toDataURL("image/png");
  label.innerHTML = `<span>${name}</span><span>${canvas.width}×${canvas.height}</span>`;
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.textContent = "download";
  wrap.appendChild(label);
  wrap.appendChild(canvas);
  wrap.appendChild(link);
  bakeOut.appendChild(wrap);
}

let last = performance.now();
let frameAcc = 0;
function tick(now: number): void {
  const dt = (now - last) / 1000;
  last = now;
  if (currentSkel && currentAnim) {
    const fps = Number(fpsInput.value) || currentAnim.fps;
    frameAcc += dt * fps;
    const f = Math.floor(frameAcc) % currentAnim.frames;
    preview.apply(poseAt(currentAnim, f));
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

(async () => {
  charSel.innerHTML = characters.map((c) => `<option value="${c}">${c}</option>`).join("");
  await selectCharacter(characters[0]);
})();
