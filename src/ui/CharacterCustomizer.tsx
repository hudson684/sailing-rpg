import { useEffect, useMemo, useRef, useState } from "react";
import { bus } from "../game/bus";
import { useSettingsStore } from "../game/store/settingsStore";
import { CF_FRAME_SIZE, type CfLayer } from "../game/entities/playerAnims";
import {
  CF_WARDROBE_LAYERS,
  CF_WARDROBE_OPTIONS,
  type CfWardrobe,
} from "../game/entities/playerWardrobe";
import {
  SKIN_PALETTES,
  SKIN_PALETTE_IDS,
  recolorPixels,
  type SkinPaletteId,
} from "../game/entities/playerSkin";
import "./CharacterCustomizer.css";

// Each CF frame is 64×64. The character pixels live in y=23..40 of each row;
// crop tight to the body for a clearer swatch.
const CHAR_CROP = { x: 16, y: 14, w: 32, h: 38 } as const;
const PREVIEW_SCALE = 6;
const SWATCH_SCALE = 3;

// Layer draw order — must match `CF_LAYERS` in playerAnims.ts (back→front).
const PREVIEW_LAYER_ORDER: CfLayer[] = [
  "base",
  "feet",
  "legs",
  "chest",
  "hands",
  "hair",
  "accessory",
];

// Filename for a (layer, variant) sheet. Mirrors BootScene's loader.
function sheetUrl(layer: CfLayer, variant: string): string {
  if (layer === "base") return `/sprites/character/cf/base.png`;
  return `/sprites/character/cf/${layer}-${variant}.png`;
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadSheet(layer: CfLayer, variant: string): Promise<HTMLImageElement> {
  const key = `${layer}:${variant}`;
  let p = imageCache.get(key);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`failed to load ${key}`));
      img.src = sheetUrl(layer, variant);
    });
    imageCache.set(key, p);
  }
  return p;
}

type PreviewLayers = Partial<Record<CfLayer, HTMLImageElement>> & {
  base: HTMLImageElement;
  hands: HTMLImageElement;
};

async function loadPreviewLayers(wardrobe: CfWardrobe): Promise<PreviewLayers> {
  // Hands and base are not user-pickable today — fixed defaults.
  const [base, hands] = await Promise.all([
    loadSheet("base", "default"),
    loadSheet("hands", "bare"),
  ]);
  const out: PreviewLayers = { base, hands };
  for (const layer of CF_WARDROBE_LAYERS) {
    const variant = wardrobe[layer];
    if (!variant) continue;
    out[layer] = await loadSheet(layer, variant);
  }
  return out;
}

/** Composite layered preview into a canvas at the chosen scale, recolored. */
function paintLayered(
  ctx: CanvasRenderingContext2D,
  layers: PreviewLayers,
  paletteId: SkinPaletteId,
  scale: number,
): void {
  const work = document.createElement("canvas");
  work.width = CF_FRAME_SIZE;
  work.height = CF_FRAME_SIZE;
  const wctx = work.getContext("2d")!;
  wctx.imageSmoothingEnabled = false;
  for (const layer of PREVIEW_LAYER_ORDER) {
    const img = layers[layer];
    if (!img) continue;
    // Frame 0 of each sheet is at (0, 0, 64, 64) — idle/forward first frame.
    wctx.drawImage(img, 0, 0, CF_FRAME_SIZE, CF_FRAME_SIZE, 0, 0, CF_FRAME_SIZE, CF_FRAME_SIZE);
  }
  // Skin recolor pass on the composited frame. recolorPixels handles both
  // Hana and CF source palettes — only the CF skin pixels match here.
  const data = wctx.getImageData(0, 0, CF_FRAME_SIZE, CF_FRAME_SIZE);
  recolorPixels(data.data, SKIN_PALETTES[paletteId]);
  wctx.putImageData(data, 0, 0);

  const dstW = CHAR_CROP.w * scale;
  const dstH = CHAR_CROP.h * scale;
  ctx.canvas.width = dstW;
  ctx.canvas.height = dstH;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, dstW, dstH);
  ctx.drawImage(
    work,
    CHAR_CROP.x, CHAR_CROP.y, CHAR_CROP.w, CHAR_CROP.h,
    0, 0, dstW, dstH,
  );
}

export interface CharacterCustomizerProps {
  mode: "create" | "edit";
  open: boolean;
  onClose: () => void;
}

export function CharacterCustomizer({ mode, open, onClose }: CharacterCustomizerProps) {
  const savedTone = useSettingsStore((s) => s.skinTone);
  const savedWardrobe = useSettingsStore((s) => s.wardrobe);
  const setSkinTone = useSettingsStore((s) => s.setSkinTone);
  const setWardrobe = useSettingsStore((s) => s.setWardrobe);
  const setCharacterCreated = useSettingsStore((s) => s.setCharacterCreated);

  const [previewTone, setPreviewTone] = useState<SkinPaletteId>(savedTone);
  const [previewWardrobe, setPreviewWardrobe] = useState<CfWardrobe>(savedWardrobe);

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [layers, setLayers] = useState<PreviewLayers | null>(null);

  // Reset previews when re-opened.
  useEffect(() => {
    if (open) {
      setPreviewTone(savedTone);
      setPreviewWardrobe(savedWardrobe);
    }
  }, [open, savedTone, savedWardrobe]);

  // Load every sheet ever needed for the swatches up front (small set).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Warm the cache for every variant in CF_WARDROBE_OPTIONS so swatch
      // canvases render synchronously thereafter.
      const tasks: Promise<unknown>[] = [
        loadSheet("base", "default"),
        loadSheet("hands", "bare"),
      ];
      for (const layer of CF_WARDROBE_LAYERS) {
        const opts = CF_WARDROBE_OPTIONS[layer] ?? [];
        for (const variant of opts) tasks.push(loadSheet(layer, variant));
      }
      await Promise.all(tasks);
      if (!cancelled) {
        // Trigger a render once images are warm (so swatches paint).
        setLayers((prev) => prev ?? null);
        setPreviewWardrobe((w) => ({ ...w }));
      }
    })().catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  // Reload composite layers whenever the preview wardrobe changes.
  useEffect(() => {
    let cancelled = false;
    void loadPreviewLayers(previewWardrobe)
      .then((l) => { if (!cancelled) setLayers(l); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [previewWardrobe]);

  // Repaint preview when layers or skin tone change.
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !layers) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    paintLayered(ctx, layers, previewTone, PREVIEW_SCALE);
  }, [layers, previewTone]);

  // ESC closes (edit mode only — create mode forces a confirm).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (mode === "edit") onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, mode]);

  const dirty =
    previewTone !== savedTone ||
    CF_WARDROBE_LAYERS.some((l) => previewWardrobe[l] !== savedWardrobe[l]);

  const onApply = () => {
    if (previewTone !== savedTone) {
      setSkinTone(previewTone);
      bus.emitTyped("skin:apply", previewTone);
    }
    setWardrobe(previewWardrobe);
    if (mode === "create") setCharacterCreated(true);
    onClose();
  };

  const onCancel = () => {
    if (mode === "create") setCharacterCreated(true);
    onClose();
  };

  const previewSize = useMemo(
    () => ({ w: CHAR_CROP.w * PREVIEW_SCALE, h: CHAR_CROP.h * PREVIEW_SCALE }),
    [],
  );

  if (!open) return null;

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
            <div
              className="cust-stage"
              style={{ width: previewSize.w + 24, height: previewSize.h + 24 }}
            >
              <canvas ref={previewCanvasRef} className="cust-preview-canvas" />
            </div>
          </div>

          <div className="cust-options-col">
            <div className="cust-section">
              <div className="cust-section-title">Skin Tone</div>
              <div className="cust-swatch-grid">
                {SKIN_PALETTE_IDS.map((id) => {
                  const active = id === previewTone;
                  return (
                    <button
                      key={id}
                      className={`px-slot cust-swatch${active ? " px-slot-target" : ""}`}
                      onClick={() => setPreviewTone(id)}
                      title={id}
                    >
                      <ToneChip palette={id} />
                      <span className="cust-swatch-label">{id}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {CF_WARDROBE_LAYERS.map((layer) => {
              const opts = CF_WARDROBE_OPTIONS[layer] ?? [];
              if (opts.length === 0) return null;
              const current = previewWardrobe[layer] ?? null;
              const optional = layer === "accessory";
              return (
                <div key={layer} className="cust-section">
                  <div className="cust-section-title">{layer}</div>
                  <div className="cust-swatch-grid">
                    {optional && (
                      <button
                        className={`px-slot cust-swatch${current === null ? " px-slot-target" : ""}`}
                        onClick={() => setPreviewWardrobe((w) => ({ ...w, [layer]: null }))}
                        title="None"
                      >
                        <div
                          className="cust-swatch-empty"
                          style={{ width: CHAR_CROP.w * SWATCH_SCALE, height: CHAR_CROP.h * SWATCH_SCALE }}
                        />
                        <span className="cust-swatch-label">none</span>
                      </button>
                    )}
                    {opts.map((variant) => {
                      const active = current === variant;
                      return (
                        <button
                          key={variant}
                          className={`px-slot cust-swatch${active ? " px-slot-target" : ""}`}
                          onClick={() => setPreviewWardrobe((w) => ({ ...w, [layer]: variant }))}
                          title={variant}
                        >
                          <VariantChip
                            layer={layer}
                            variant={variant}
                            tone={previewTone}
                          />
                          <span className="cust-swatch-label">{variant}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
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

/** Tiny canvas chip showing the bare base + chosen tone — for skin swatch. */
function ToneChip({ palette }: { palette: SkinPaletteId }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    void Promise.all([loadSheet("base", "default"), loadSheet("hands", "bare")])
      .then(([base, hands]) => {
        paintLayered(ctx, { base, hands }, palette, SWATCH_SCALE);
      })
      .catch(() => { /* non-fatal */ });
  }, [palette]);
  return <canvas ref={ref} />;
}

/** Tiny canvas chip showing base + this single layer/variant. */
function VariantChip({
  layer,
  variant,
  tone,
}: {
  layer: CfLayer;
  variant: string;
  tone: SkinPaletteId;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    void Promise.all([
      loadSheet("base", "default"),
      loadSheet("hands", "bare"),
      loadSheet(layer, variant),
    ])
      .then(([base, hands, sheet]) => {
        const layers: PreviewLayers = { base, hands };
        layers[layer] = sheet;
        paintLayered(ctx, layers, tone, SWATCH_SCALE);
      })
      .catch(() => { /* non-fatal */ });
  }, [layer, variant, tone]);
  return <canvas ref={ref} />;
}
