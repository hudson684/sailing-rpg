import * as Phaser from "phaser";

/**
 * Lightweight speech bubble that follows a character and auto-dismisses.
 * Intended for short, reactive, non-dialogue lines ("Just like Mum used to
 * make!"). Formal NPC conversations still belong to the DialogueDirector —
 * this is just a visual flourish.
 */

export interface SpeechBubbleOpts {
  /** Milliseconds the bubble stays fully visible before fading. */
  duration?: number;
  /** Pixels above the target's origin (feet) to anchor the tail tip. */
  offsetY?: number;
  /** Max text width in pixels before wrapping. */
  maxWidth?: number;
}

/**
 * Anything with live `x`/`y` getters works — Player, Phaser.Container,
 * CharacterSprite.container, NpcSprite.sprite, etc.
 */
export interface SpeechBubbleTarget {
  readonly x: number;
  readonly y: number;
}

const ACTIVE = new WeakMap<object, () => void>();

const BG_COLOR = 0xfdf6e3;
const BG_ALPHA = 1;
const LINE_COLOR = 0x1a1a1a;
const LINE_WIDTH = 2;
const PAD_X = 8;
const PAD_Y = 5;
const TAIL_HEIGHT = 6;
const TAIL_HALF_WIDTH = 4;

export function showSpeechBubble(
  scene: Phaser.Scene,
  target: SpeechBubbleTarget,
  text: string,
  opts: SpeechBubbleOpts = {},
): void {
  const duration = opts.duration ?? 1800;
  const offsetY = opts.offsetY ?? 40;
  const maxWidth = opts.maxWidth ?? 180;

  // Replace any bubble already riding this target so spammed triggers don't
  // stack up and obscure the character.
  const prev = ACTIVE.get(target);
  if (prev) prev();

  const container = scene.add.container(target.x, target.y - offsetY);
  container.setDepth(200000);

  const label = scene.add
    .text(0, 0, text, {
      fontFamily: "'Press Start 2P', 'Courier New', monospace",
      fontSize: "10px",
      color: "#1a1a1a",
      align: "center",
      wordWrap: { width: maxWidth, useAdvancedWrap: true },
      resolution: 2,
    })
    .setOrigin(0.5, 1);

  const textBounds = label.getBounds();
  const bodyW = Math.ceil(textBounds.width) + PAD_X * 2;
  const bodyH = Math.ceil(textBounds.height) + PAD_Y * 2;
  const left = -bodyW / 2;
  const right = bodyW / 2;
  const bottom = -TAIL_HEIGHT;
  const top = bottom - bodyH;

  label.setPosition(0, bottom - PAD_Y);

  const bg = scene.add.graphics();
  // Solid fill for body + tail (two shapes so the seam is covered by fills
  // on both sides — no visible line where they meet).
  bg.fillStyle(BG_COLOR, BG_ALPHA);
  bg.fillRect(left, top, bodyW, bodyH);
  bg.fillTriangle(-TAIL_HALF_WIDTH, bottom, TAIL_HALF_WIDTH, bottom, 0, 0);
  // Outline as a single connected polyline so the body's bottom edge breaks
  // cleanly around the tail instead of cutting across it.
  bg.lineStyle(LINE_WIDTH, LINE_COLOR, 1);
  bg.beginPath();
  bg.moveTo(left, top);
  bg.lineTo(right, top);
  bg.lineTo(right, bottom);
  bg.lineTo(TAIL_HALF_WIDTH, bottom);
  bg.lineTo(0, 0);
  bg.lineTo(-TAIL_HALF_WIDTH, bottom);
  bg.lineTo(left, bottom);
  bg.lineTo(left, top);
  bg.strokePath();

  container.add([bg, label]);

  // Pop-in: scale + fade from the tail tip so it looks like it sprouts off
  // the character's head.
  container.setScale(0.6);
  container.setAlpha(0);
  scene.tweens.add({
    targets: container,
    alpha: 1,
    scale: 1,
    duration: 140,
    ease: "Back.Out",
  });

  const follow = () => {
    container.x = target.x;
    container.y = target.y - offsetY;
  };
  scene.events.on(Phaser.Scenes.Events.UPDATE, follow);

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    scene.events.off(Phaser.Scenes.Events.UPDATE, follow);
    scene.tweens.killTweensOf(container);
    container.destroy();
    if (ACTIVE.get(target) === destroy) ACTIVE.delete(target);
  };

  scene.tweens.add({
    targets: container,
    alpha: 0,
    duration: 220,
    delay: duration,
    ease: "Sine.In",
    onComplete: destroy,
  });

  ACTIVE.set(target, destroy);
}
