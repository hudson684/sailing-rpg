import { useEffect, useMemo, useRef, useState } from "react";
import { bus } from "../game/bus";
import { useSettingsStore } from "../game/store/settingsStore";
import {
  PLAYER_ANIM_SHEETS,
  type PlayerAnimDir,
  type PlayerAnimState,
} from "../game/entities/playerAnims";
import {
  SKIN_PALETTES,
  SKIN_PALETTE_IDS,
  recolorPixels,
  type SkinPaletteId,
} from "../game/entities/playerSkin";
import "./CharacterCustomizer.css";

const FACING_OPTIONS: { id: PlayerAnimDir; label: string; flipX: boolean }[] = [
  { id: "down", label: "Down", flipX: false },
  { id: "side", label: "Right", flipX: false },
  { id: "up", label: "Up", flipX: false },
  { id: "side", label: "Left", flipX: true },
];

const STATE_OPTIONS: PlayerAnimState[] = ["idle", "walk", "attack"];

const PREVIEW_SCALE = 4;
const SWATCH_SCALE = 1;

function loadStateImage(state: PlayerAnimState): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${state}.png`));
    img.src = `/sprites/character/${state}.png`;
  });
}

/** Bake a single still frame into a canvas (for swatch buttons). */
function makeSwatchCanvas(img: HTMLImageElement, paletteId: SkinPaletteId): HTMLCanvasElement {
  const cfg = PLAYER_ANIM_SHEETS.idle;
  const size = cfg.frameSize;
  // Down-facing first frame: row index = cfg.rows.down, col 0.
  const sx = 0;
  const sy = cfg.rows.down * size;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, sx, sy, size, size, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size);
  recolorPixels(data.data, SKIN_PALETTES[paletteId]);
  ctx.putImageData(data, 0, 0);
  return canvas;
}

export interface CharacterCustomizerProps {
  mode: "create" | "edit";
  open: boolean;
  onClose: () => void;
}

export function CharacterCustomizer({ mode, open, onClose }: CharacterCustomizerProps) {
  const savedTone = useSettingsStore((s) => s.skinTone);
  const setSkinTone = useSettingsStore((s) => s.setSkinTone);
  const setCharacterCreated = useSettingsStore((s) => s.setCharacterCreated);

  const [previewTone, setPreviewTone] = useState<SkinPaletteId>(savedTone);
  const [stateIdx, setStateIdx] = useState(0);
  const [facingIdx, setFacingIdx] = useState(0);

  const [sheets, setSheets] = useState<Record<PlayerAnimState, HTMLImageElement> | null>(null);
  const [swatches, setSwatches] = useState<Record<SkinPaletteId, string> | null>(null);

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number | null>(null);

  // Reset preview tone to saved when the panel opens fresh.
  useEffect(() => {
    if (open) setPreviewTone(savedTone);
  }, [open, savedTone]);

  // Load all sheet images + bake swatch data URLs once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await Promise.all(STATE_OPTIONS.map(loadStateImage));
        if (cancelled) return;
        const map = {} as Record<PlayerAnimState, HTMLImageElement>;
        STATE_OPTIONS.forEach((s, i) => (map[s] = loaded[i]));
        setSheets(map);
        const sw = {} as Record<SkinPaletteId, string>;
        for (const id of SKIN_PALETTE_IDS) {
          sw[id] = makeSwatchCanvas(map.idle, id).toDataURL("image/png");
        }
        setSwatches(sw);
      } catch {
        // Non-fatal — UI degrades to label-only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Drive the preview animation.
  useEffect(() => {
    if (!sheets) return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const state = STATE_OPTIONS[stateIdx];
    const facing = FACING_OPTIONS[facingIdx];
    const cfg = PLAYER_ANIM_SHEETS[state];
    const size = cfg.frameSize;
    const cols = cfg.cols;
    const row = cfg.rows[facing.id];
    const fps = cfg.frameRate;

    canvas.width = size * PREVIEW_SCALE;
    canvas.height = size * PREVIEW_SCALE;
    ctx.imageSmoothingEnabled = false;

    // Pre-bake the row's frames into one strip canvas with the chosen tone,
    // then sample from it each tick — recolor cost is paid once per change.
    const strip = document.createElement("canvas");
    strip.width = size * cols;
    strip.height = size;
    const sctx = strip.getContext("2d")!;
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(sheets[state], 0, row * size, size * cols, size, 0, 0, size * cols, size);
    const data = sctx.getImageData(0, 0, size * cols, size);
    recolorPixels(data.data, SKIN_PALETTES[previewTone]);
    sctx.putImageData(data, 0, 0);

    const startedAt = performance.now();
    const totalFrames = cols;
    const frameMs = 1000 / fps;
    // Attack plays once and holds the last frame; idle/walk loop.
    const loop = cfg.repeat !== 0;

    const tick = (now: number) => {
      const elapsed = now - startedAt;
      let frame = Math.floor(elapsed / frameMs);
      frame = loop ? frame % totalFrames : Math.min(frame, totalFrames - 1);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      if (facing.flipX) {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(
        strip,
        frame * size, 0, size, size,
        0, 0, size * PREVIEW_SCALE, size * PREVIEW_SCALE,
      );
      ctx.restore();

      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);

    return () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
      animRef.current = null;
    };
  }, [sheets, stateIdx, facingIdx, previewTone]);

  // Hotkey + ESC to cancel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const dirty = previewTone !== savedTone;

  const onApply = () => {
    setSkinTone(previewTone);
    bus.emitTyped("skin:apply", previewTone);
    if (mode === "create") setCharacterCreated(true);
    onClose();
  };

  const onCancel = () => {
    if (mode === "create") {
      // First-run: still need to commit *something*; default tone is fine.
      setCharacterCreated(true);
    }
    onClose();
  };

  const previewSizePx = useMemo(
    () => PLAYER_ANIM_SHEETS.idle.frameSize * PREVIEW_SCALE,
    [],
  );
  const swatchSizePx = useMemo(
    () => PLAYER_ANIM_SHEETS.idle.frameSize * SWATCH_SCALE,
    [],
  );

  if (!open) return null;

  const stateLabel = STATE_OPTIONS[stateIdx];
  const facingLabel = FACING_OPTIONS[facingIdx].label;

  return (
    <div className="cust-backdrop" onClick={mode === "edit" ? onCancel : undefined}>
      <div className="px-panel cust-panel" onClick={(e) => e.stopPropagation()}>
        <div className="px-header">
          <span className="px-header-title">
            {mode === "create" ? "Create Character" : "Character"}
          </span>
          {mode === "edit" && (
            <button className="px-close" onClick={onCancel} aria-label="Close">×</button>
          )}
        </div>

        <div className="cust-body">
          <div className="cust-preview-col">
            <div className="cust-stage" style={{ width: previewSizePx, height: previewSizePx }}>
              <canvas ref={previewCanvasRef} className="cust-preview-canvas" />
            </div>
            <div className="cust-stepper">
              <button
                className="cust-arrow"
                onClick={() => setStateIdx((i) => (i - 1 + STATE_OPTIONS.length) % STATE_OPTIONS.length)}
                aria-label="Previous state"
              >‹</button>
              <span className="cust-stepper-label">{stateLabel}</span>
              <button
                className="cust-arrow"
                onClick={() => setStateIdx((i) => (i + 1) % STATE_OPTIONS.length)}
                aria-label="Next state"
              >›</button>
            </div>
            <div className="cust-stepper">
              <button
                className="cust-arrow"
                onClick={() => setFacingIdx((i) => (i - 1 + FACING_OPTIONS.length) % FACING_OPTIONS.length)}
                aria-label="Previous facing"
              >‹</button>
              <span className="cust-stepper-label">{facingLabel}</span>
              <button
                className="cust-arrow"
                onClick={() => setFacingIdx((i) => (i + 1) % FACING_OPTIONS.length)}
                aria-label="Next facing"
              >›</button>
            </div>
          </div>

          <div className="cust-options-col">
            <div className="cust-section">
              <div className="cust-section-title">Skin Tone</div>
              <div className="cust-swatch-grid">
                {SKIN_PALETTE_IDS.map((id) => {
                  const src = swatches?.[id];
                  const active = id === previewTone;
                  return (
                    <button
                      key={id}
                      className={`px-slot cust-swatch${active ? " px-slot-target" : ""}`}
                      onClick={() => setPreviewTone(id)}
                      title={id}
                      style={{ width: swatchSizePx + 20, height: swatchSizePx + 20 }}
                    >
                      {src ? (
                        <img src={src} width={swatchSizePx} height={swatchSizePx} alt={id} />
                      ) : (
                        <div className="cust-swatch-empty" style={{ width: swatchSizePx, height: swatchSizePx }} />
                      )}
                      <span className="cust-swatch-label">{id}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="cust-section cust-section-muted">
              <div className="cust-section-title">Hair</div>
              <div className="cust-section-coming">Coming soon</div>
            </div>
          </div>
        </div>

        <div className="cust-actions">
          {mode === "edit" && (
            <button className="px-btn px-btn-grey" onClick={onCancel}>Cancel</button>
          )}
          <button
            className="px-btn px-btn-green"
            onClick={onApply}
            disabled={mode === "edit" && !dirty}
          >
            {mode === "create" ? "Confirm" : "Apply"}
          </button>
        </div>
        <div className="px-footer">
          {mode === "edit" ? "C: toggle · ESC: cancel" : "Pick a look — you can change it any time"}
        </div>
      </div>
    </div>
  );
}
