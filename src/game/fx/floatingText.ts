import * as Phaser from "phaser";

export type FloatingTextKind = "damage-enemy" | "damage-player" | "damage-node" | "heal" | "xp";

interface FloatOpts {
  kind?: FloatingTextKind;
  /** Slight horizontal jitter so stacked hits don't overlap perfectly. */
  jitter?: boolean;
}

const COLORS: Record<FloatingTextKind, { fill: string; stroke: string }> = {
  "damage-enemy":  { fill: "#fff4c2", stroke: "#3a1a08" }, // creamy yellow
  "damage-player": { fill: "#ff6868", stroke: "#3a0808" }, // angry red
  "damage-node":   { fill: "#ffffff", stroke: "#2a1a08" }, // chip white
  "heal":          { fill: "#9bff9b", stroke: "#0a3a0a" }, // green
  "xp":            { fill: "#ffd84a", stroke: "#3a2608" }, // golden
};

/** Spawn a cartoony damage number that floats up and fades out. */
export function spawnFloatingNumber(
  scene: Phaser.Scene,
  x: number,
  y: number,
  amount: number,
  opts: FloatOpts = {},
): void {
  const kind = opts.kind ?? "damage-enemy";
  const colors = COLORS[kind];
  const text =
    kind === "xp"
      ? `+${amount}xp`
      : amount === 0
        ? "MISS"
        : kind === "heal"
          ? `+${amount}`
          : `${amount}`;

  const jx = opts.jitter === false ? 0 : (Math.random() - 0.5) * 14;
  const startX = x + jx;
  const startY = y;

  const label = scene.add
    .text(startX, startY, text, {
      fontFamily: "Impact, 'Arial Black', sans-serif",
      fontSize: amount >= 10 ? "26px" : "22px",
      fontStyle: "bold",
      color: colors.fill,
      stroke: colors.stroke,
      strokeThickness: 5,
      align: "center",
    })
    .setOrigin(0.5, 1)
    .setDepth(100000)
    .setScrollFactor(1)
    .setShadow(2, 2, "rgba(0,0,0,0.55)", 3, false, true);

  // Pop in: scale from 0.4 → 1.15 → 1.0
  label.setScale(0.4);
  scene.tweens.add({
    targets: label,
    scale: 1.15,
    duration: 110,
    ease: "Back.Out",
    onComplete: () => {
      scene.tweens.add({ targets: label, scale: 1.0, duration: 80, ease: "Sine.Out" });
    },
  });

  // Float up + fade.
  scene.tweens.add({
    targets: label,
    y: startY - 36,
    duration: 750,
    ease: "Sine.Out",
  });
  scene.tweens.add({
    targets: label,
    alpha: 0,
    duration: 350,
    delay: 500,
    ease: "Sine.In",
    onComplete: () => label.destroy(),
  });
}
