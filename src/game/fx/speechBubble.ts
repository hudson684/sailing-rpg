import * as Phaser from "phaser";

/**
 * Lightweight speech bubble that follows a character and auto-dismisses.
 * Intended for short, reactive, non-dialogue lines ("Just like Mum used
 * to make!"). Formal NPC conversations still belong to the
 * DialogueDirector — this is just a visual flourish.
 *
 * Drawn with `Graphics` rather than the 9-slice panel art so the bubble
 * stays crisp at any size and we don't depend on the texture's slice
 * geometry. A clean sans-serif at high resolution renders sharper than
 * the pixel font when overlaid on a busy world tile.
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

const FILL = 0xfffaf0;
const FILL_ALPHA = 0.96;
const STROKE = 0x2a1b17;
const STROKE_WIDTH = 1;
const SHADOW = 0x000000;
const SHADOW_ALPHA = 0.18;
const SHADOW_OFFSET = 2;
const CORNER_RADIUS = 5;
const PAD_X = 7;
const PAD_Y = 5;
const TAIL_HEIGHT = 7;
const TAIL_HALF_WIDTH = 5;

export function showSpeechBubble(
  scene: Phaser.Scene,
  target: SpeechBubbleTarget,
  text: string,
  opts: SpeechBubbleOpts = {},
): void {
  const duration = opts.duration ?? 1800;
  const offsetY = opts.offsetY ?? 40;
  const maxWidth = opts.maxWidth ?? 160;

  // Replace any bubble already riding this target so spammed triggers
  // don't stack up and obscure the character.
  const prev = ACTIVE.get(target);
  if (prev) prev();

  const container = scene.add.container(target.x, target.y - offsetY);
  container.setDepth(200000);

  const label = scene.add
    .text(0, 0, text, {
      fontFamily:
        "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      fontSize: "11px",
      color: "#1a1410",
      align: "center",
      wordWrap: { width: maxWidth, useAdvancedWrap: true },
      // High-DPI render so the sans-serif glyphs stay sharp when the
      // game scales up on big monitors. Tied to devicePixelRatio so
      // we don't waste fillrate on integer-DPR screens.
      resolution: Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1))),
    })
    .setOrigin(0.5, 1);

  // Body geometry — sized purely from text, no min-size forcing.
  const textBounds = label.getBounds();
  const bodyW = Math.ceil(textBounds.width) + PAD_X * 2;
  const bodyH = Math.ceil(textBounds.height) + PAD_Y * 2;
  const left = -bodyW / 2;
  const bottom = -TAIL_HEIGHT;
  const top = bottom - bodyH;

  // Anchor the text origin (bottom-center) `PAD_Y` above the body's
  // bottom edge so the line of text lands `PAD_Y` from each side.
  label.setPosition(0, bottom - PAD_Y);

  // Drop shadow + filled rounded rect with a 1px stroke, drawn in one
  // Graphics object so they share the same depth/move/destroy handle.
  const body = scene.add.graphics();
  // Soft shadow.
  body.fillStyle(SHADOW, SHADOW_ALPHA);
  body.fillRoundedRect(
    left + SHADOW_OFFSET,
    top + SHADOW_OFFSET,
    bodyW,
    bodyH,
    CORNER_RADIUS,
  );
  body.fillTriangle(
    -TAIL_HALF_WIDTH + SHADOW_OFFSET,
    bottom + SHADOW_OFFSET,
    TAIL_HALF_WIDTH + SHADOW_OFFSET,
    bottom + SHADOW_OFFSET,
    0 + SHADOW_OFFSET,
    0 + SHADOW_OFFSET,
  );
  // Body fill.
  body.fillStyle(FILL, FILL_ALPHA);
  body.fillRoundedRect(left, top, bodyW, bodyH, CORNER_RADIUS);
  // Tail fill, slightly inset on top so the body's stroke can ride
  // across cleanly.
  body.fillTriangle(-TAIL_HALF_WIDTH, bottom, TAIL_HALF_WIDTH, bottom, 0, 0);

  // Outline. Phaser doesn't have a single "rounded rect with notch" path
  // primitive, so trace it manually: rounded rect on top, triangle tail
  // skipping the bottom segment under the tail mouth.
  body.lineStyle(STROKE_WIDTH, STROKE, 1);
  body.beginPath();
  // Top-left → top-right
  body.moveTo(left + CORNER_RADIUS, top);
  body.lineTo(left + bodyW - CORNER_RADIUS, top);
  body.arc(
    left + bodyW - CORNER_RADIUS,
    top + CORNER_RADIUS,
    CORNER_RADIUS,
    -Math.PI / 2,
    0,
  );
  // Right side → bottom-right corner
  body.lineTo(left + bodyW, bottom - CORNER_RADIUS);
  body.arc(
    left + bodyW - CORNER_RADIUS,
    bottom - CORNER_RADIUS,
    CORNER_RADIUS,
    0,
    Math.PI / 2,
  );
  // Bottom edge to start of tail mouth
  body.lineTo(TAIL_HALF_WIDTH, bottom);
  // Tail right edge → tip → left edge
  body.lineTo(0, 0);
  body.lineTo(-TAIL_HALF_WIDTH, bottom);
  // Bottom edge from tail mouth to bottom-left corner
  body.lineTo(left + CORNER_RADIUS, bottom);
  body.arc(
    left + CORNER_RADIUS,
    bottom - CORNER_RADIUS,
    CORNER_RADIUS,
    Math.PI / 2,
    Math.PI,
  );
  // Left edge → top-left corner
  body.lineTo(left, top + CORNER_RADIUS);
  body.arc(
    left + CORNER_RADIUS,
    top + CORNER_RADIUS,
    CORNER_RADIUS,
    Math.PI,
    -Math.PI / 2,
  );
  body.strokePath();

  container.add([body, label]);

  // Pop-in: scale + fade from the tail tip so it looks like it sprouts
  // off the character's head.
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
