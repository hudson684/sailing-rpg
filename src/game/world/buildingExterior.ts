import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { useBusinessStore } from "../business/businessStore";
import { businesses } from "../business/registry";

/** Per-state visibility gating for building exteriors painted into world chunks.
 *
 *  Layers in a chunk TMJ named with the form
 *
 *    `building@id:<bid>:state:<sid>`   — a state variant for building bid
 *    `building@id:<bid>`               — the default state for building bid
 *                                        (shown when no variant is active)
 *
 *  are recognised as state layers. The runtime subscribes to
 *  `useBusinessStore` and shows the latest variant in author order whose
 *  state id is present in the building's `unlockedNodes`. If none are
 *  unlocked the default layer (if any) is shown; otherwise everything for
 *  that building is hidden.
 *
 *  Layers without this naming aren't touched. */
export type BuildingLayerGate =
  | { kind: "none" }
  | { kind: "state-base"; buildingId: string }
  | { kind: "state-variant"; buildingId: string; stateId: string };

const STATE_RE = /^building@id:([A-Za-z0-9_-]+)(?::state:([A-Za-z0-9_-]+))?$/;

export function parseBuildingLayerGate(name: string): BuildingLayerGate {
  const m = STATE_RE.exec(name);
  if (!m) return { kind: "none" };
  const [, buildingId, stateId] = m;
  return stateId
    ? { kind: "state-variant", buildingId, stateId }
    : { kind: "state-base", buildingId };
}

interface StateGroup {
  base: Phaser.Tilemaps.TilemapLayer[];
  variants: Array<{ stateId: string; layer: Phaser.Tilemaps.TilemapLayer }>;
}

/** Wire state-layer visibility for one chunk. Returns an unsubscribe fn. */
export function applyBuildingStateLayers(
  layers: Phaser.Tilemaps.TilemapLayer[],
): () => void {
  const groups = new Map<string, StateGroup>();
  for (const layer of layers) {
    const gate = parseBuildingLayerGate(layer.layer.name);
    if (gate.kind === "none") continue;
    const buildingId = gate.buildingId;
    if (!businesses.tryGet(buildingId)) {
      console.warn(
        `[buildingExterior] Layer '${layer.layer.name}' references unknown building '${buildingId}'.`,
      );
      continue;
    }
    let g = groups.get(buildingId);
    if (!g) {
      g = { base: [], variants: [] };
      groups.set(buildingId, g);
    }
    if (gate.kind === "state-base") g.base.push(layer);
    else g.variants.push({ stateId: gate.stateId, layer });
  }

  if (groups.size === 0) return () => {};

  const apply = () => {
    const state = useBusinessStore.getState();
    for (const [buildingId, g] of groups) {
      const unlocked = new Set(state.byId[buildingId]?.unlockedNodes ?? []);
      // Latest variant in author order whose stateId is unlocked wins.
      let activeIdx = -1;
      for (let i = 0; i < g.variants.length; i++) {
        if (unlocked.has(g.variants[i].stateId)) activeIdx = i;
      }
      const baseVisible = activeIdx === -1;
      for (const l of g.base) {
        l.setVisible(baseVisible);
        l.setData("gateActive", baseVisible);
      }
      for (let i = 0; i < g.variants.length; i++) {
        const visible = i === activeIdx;
        g.variants[i].layer.setVisible(visible);
        g.variants[i].layer.setData("gateActive", visible);
      }
    }
  };

  apply();
  const unsubscribe = useBusinessStore.subscribe(apply);
  return unsubscribe;
}

// ─── Overlay objects ──────────────────────────────────────────────────────

/** Visibility rule evaluated against a `BusinessState`. All present
 *  conditions must hold. */
export interface BuildingOverlayVisibility {
  /** When true, building must be owned. When false, must NOT be owned.
   *  Omit to ignore. */
  owned?: boolean;
  /** All listed node ids must be in `unlockedNodes`. */
  requiresNodes?: string[];
  /** None of the listed node ids may be in `unlockedNodes`. */
  forbidsNodes?: string[];
}

/** Optional gameplay hooks attached to an overlay. The data lives here so
 *  that Tiled stays a pure placement tool — the object only carries
 *  building/slot identifiers. */
export interface BuildingOverlayEffects {
  /** Flat reputation bonus while overlay is visible. Reserved — not yet
   *  consumed by the reputation system. */
  reputationBonus?: number;
  /** When the player presses E within range, show this prompt. Reserved. */
  interactionPrompt?: string;
}

export interface BuildingOverlayDef {
  building: string;
  slot: string;
  visibleWhen: BuildingOverlayVisibility;
  effects?: BuildingOverlayEffects;
}

const OVERLAY_DEFS = new Map<string, BuildingOverlayDef>();

function overlayKey(building: string, slot: string): string {
  return `${building}:${slot}`;
}

export function registerBuildingOverlay(def: BuildingOverlayDef): void {
  const k = overlayKey(def.building, def.slot);
  if (OVERLAY_DEFS.has(k)) {
    throw new Error(
      `Duplicate building overlay registration: (${def.building}, ${def.slot})`,
    );
  }
  if (!businesses.tryGet(def.building)) {
    throw new Error(
      `Building overlay references unknown building '${def.building}'.`,
    );
  }
  OVERLAY_DEFS.set(k, def);
}

export function getBuildingOverlay(
  building: string,
  slot: string,
): BuildingOverlayDef | null {
  return OVERLAY_DEFS.get(overlayKey(building, slot)) ?? null;
}

function evaluateOverlayVisibility(
  rule: BuildingOverlayVisibility,
  buildingId: string,
): boolean {
  const state = useBusinessStore.getState().byId[buildingId];
  if (!state) return false;
  if (rule.owned === true && !state.owned) return false;
  if (rule.owned === false && state.owned) return false;
  const unlocked = new Set(state.unlockedNodes);
  if (rule.requiresNodes) {
    for (const n of rule.requiresNodes) if (!unlocked.has(n)) return false;
  }
  if (rule.forbidsNodes) {
    for (const n of rule.forbidsNodes) if (unlocked.has(n)) return false;
  }
  return true;
}

interface OverlayObject {
  building: string;
  slot: string;
  /** Pixel x in chunk-local coords (top-left of the object). */
  px: number;
  /** Pixel y. Tiled stores tile-objects' y at the BOTTOM-left; caller has
   *  already converted to top-left. */
  py: number;
  gid: number;
}

/** Parse the `overlays` object layer of a chunk tilemap into typed entries.
 *  Tiled stores tile-objects (those placed by gid) with y at the bottom-left
 *  of the object — we normalise to top-left so callers match `setOrigin(0,0)`
 *  for placement. */
function parseOverlayObjects(
  tilemap: Phaser.Tilemaps.Tilemap,
): OverlayObject[] {
  const layer = tilemap.getObjectLayer("overlays");
  if (!layer) return [];
  const out: OverlayObject[] = [];
  type RawObj = {
    type?: string;
    x?: number;
    y?: number;
    gid?: number;
    height?: number;
    properties?: Array<{ name: string; value: unknown }>;
  };
  for (const raw of layer.objects as RawObj[]) {
    if (raw.type !== "overlay") continue;
    const props: Record<string, unknown> = {};
    for (const p of raw.properties ?? []) props[p.name] = p.value;
    const building = String(props.building ?? "");
    const slot = String(props.slot ?? "");
    const gid = raw.gid ?? 0;
    if (!building || !slot) {
      console.warn(
        "[buildingExterior] overlay object missing building/slot properties; skipping.",
      );
      continue;
    }
    const px = raw.x ?? 0;
    const py = (raw.y ?? 0) - (raw.height ?? 0);
    out.push({ building, slot, px, py, gid });
  }
  return out;
}

/** Wire overlay sprites for one chunk. Returns an unsubscribe fn. */
export function applyBuildingOverlays(
  scene: Phaser.Scene,
  tilemap: Phaser.Tilemaps.Tilemap,
  chunkPxX: number,
  chunkPxY: number,
): () => void {
  const objects = parseOverlayObjects(tilemap);
  if (objects.length === 0) return () => {};

  const renderScale = TILE_SIZE / tilemap.tileWidth;
  type Entry = {
    obj: OverlayObject;
    def: BuildingOverlayDef;
    image: Phaser.GameObjects.Image | null;
  };
  const entries: Entry[] = [];

  for (const obj of objects) {
    const def = getBuildingOverlay(obj.building, obj.slot);
    if (!def) {
      if (!businesses.tryGet(obj.building)) {
        console.warn(
          `[buildingExterior] overlay (${obj.building}, ${obj.slot}): unknown building.`,
        );
      } else {
        console.warn(
          `[buildingExterior] overlay (${obj.building}, ${obj.slot}): unknown slot for building.`,
        );
      }
      continue;
    }
    entries.push({ obj, def, image: null });
  }

  const ensureImage = (entry: Entry): void => {
    if (entry.image) return;
    const { gid, px, py } = entry.obj;
    if (!gid) return;
    // Resolve gid → bound tileset. Phaser exposes Tilemap#tilesets as an
    // array; the matching tileset is the one with the largest firstgid <= gid.
    let bound: Phaser.Tilemaps.Tileset | null = null;
    for (const ts of tilemap.tilesets) {
      if (ts.firstgid <= gid && (!bound || ts.firstgid > bound.firstgid)) {
        bound = ts;
      }
    }
    if (!bound || !bound.image) return;
    const localId = gid - bound.firstgid;
    const coords = bound.getTileTextureCoordinates(localId) as
      | { x: number; y: number }
      | null;
    if (!coords) return;
    const imageKey = bound.image.key;
    const tw = bound.tileWidth;
    const th = bound.tileHeight;
    const frameName = `overlay:${imageKey}:${localId}`;
    const texture = scene.textures.get(imageKey);
    if (!texture.has(frameName)) {
      texture.add(frameName, 0, coords.x, coords.y, tw, th);
    }
    const wx = chunkPxX + px * renderScale;
    const wy = chunkPxY + py * renderScale;
    entry.image = scene.add
      .image(wx, wy, imageKey, frameName)
      .setOrigin(0, 0)
      .setScale(renderScale)
      .setDepth(wy + th * renderScale);
  };

  const apply = () => {
    for (const entry of entries) {
      const visible = evaluateOverlayVisibility(
        entry.def.visibleWhen,
        entry.obj.building,
      );
      if (visible) {
        ensureImage(entry);
        if (entry.image) entry.image.setVisible(true);
      } else if (entry.image) {
        entry.image.setVisible(false);
      }
    }
  };

  apply();
  const unsubscribe = useBusinessStore.subscribe(apply);
  return unsubscribe;
}
