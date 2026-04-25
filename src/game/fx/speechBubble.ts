import * as Phaser from "phaser";

/**
 * Lightweight speech bubble that follows a character and auto-dismisses.
 * Intended for short, reactive, non-dialogue lines ("Just like Mum used to
 * make!"). Formal NPC conversations still belong to the DialogueDirector —
 * this is just a visual flourish.
 *
 * Visuals match the rest of the pixel UI: a wooden 9-slice frame
 * (`ui-panel-tan`, the same texture HTML panels use via `border-image`)
 * with a parchment-filled tail in matching colors.
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

const PANEL_TEXTURE = "ui-panel-tan";
// panel-tan.png is 48×48 with 16px pixel-art corners — same slice values
// the HTML panels use in pixel-ui.css.
const SLICE = 16;
// Inner parchment + outer wood colors sampled from the panel art so the
// hand-drawn tail matches the 9-slice body seamlessly.
const PARCHMENT = 0xf1d6ac;
const WOOD_DARK = 0x6a3a1f;
const PAD_X = 10;
const PAD_Y = 8;
const TAIL_HEIGHT = 8;
const TAIL_HALF_WIDTH = 6;
const MIN_BODY = SLICE * 2 + 4;

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
      fontFamily: "'Pixelify Sans', 'Press Start 2P', 'Courier New', monospace",
      fontSize: "12px",
      color: "#2a1b17",
      align: "center",
      wordWrap: { width: maxWidth, useAdvancedWrap: true },
      resolution: 2,
    })
    .setOrigin(0.5, 1);

  const textBounds = label.getBounds();
  const bodyW = Math.max(MIN_BODY, Math.ceil(textBounds.width) + PAD_X * 2);
  const bodyH = Math.max(MIN_BODY, Math.ceil(textBounds.height) + PAD_Y * 2);
  const left = -bodyW / 2;
  const bottom = -TAIL_HEIGHT;
  const top = bottom - bodyH;

  label.setPosition(0, bottom - PAD_Y);

  const body = scene.add.nineslice(
    left + bodyW / 2,
    top + bodyH / 2,
    PANEL_TEXTURE,
    undefined,
    bodyW,
    bodyH,
    SLICE,
    SLICE,
    SLICE,
    SLICE,
  );

  // Tail: filled parchment triangle with a dark-wood outline. Drawn so the
  // top edge sits 1px inside the body's bottom slice — the panel's bottom
  // border has its own wood line, so overlapping by a pixel hides any seam
  // between the slice's parchment fill and the tail.
  const tail = scene.add.graphics();
  const tailTop = bottom + 1;
  tail.fillStyle(PARCHMENT, 1);
  tail.fillTriangle(-TAIL_HALF_WIDTH, tailTop, TAIL_HALF_WIDTH, tailTop, 0, 0);
  tail.lineStyle(2, WOOD_DARK, 1);
  tail.beginPath();
  tail.moveTo(-TAIL_HALF_WIDTH, tailTop);
  tail.lineTo(0, 0);
  tail.lineTo(TAIL_HALF_WIDTH, tailTop);
  tail.strokePath();

  container.add([body, tail, label]);

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
