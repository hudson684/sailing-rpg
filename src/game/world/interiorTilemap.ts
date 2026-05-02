import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { interiorTilemapKey } from "../assets/keys";
import { tilesetImageKeyFor } from "./chunkManager";
import { ShapeCollider } from "./shapeCollision";
import {
  parseInteriorSpawns,
  type InteriorEntrySpawn,
  type InteriorExitSpawn,
  type RepairTargetSpawn,
  type SeatSpawn,
  type WorkstationSpawn,
} from "./spawns";
import { TileRegistry } from "./tileRegistry";
import { businessIdForInteriorKey } from "../business/registry";
import { useBusinessStore } from "../business/businessStore";

const INTERIOR_OVERHEAD_LAYERS = new Set(["props_high", "roof"]);
const INTERIOR_OVERHEAD_DEPTH_BASE = 1_000_000;

export interface InteriorTilemap {
  key: string;
  tilemap: Phaser.Tilemaps.Tilemap;
  layers: Phaser.Tilemaps.TilemapLayer[];
  registry: TileRegistry;
  shapes: ShapeCollider;
  exits: InteriorExitSpawn[];
  entries: InteriorEntrySpawn[];
  repairTargets: RepairTargetSpawn[];
  workstations: WorkstationSpawn[];
  seats: SeatSpawn[];
  /** Per-tile images extracted from layers flagged with the `y-sort` custom
   *  property — each one gets its own depth so it sorts against the player
   *  (and other entities) by world y. */
  ySortImages: Phaser.GameObjects.Image[];
  /** Unsubscribes the visibility-gating subscription from `useBusinessStore`.
   *  Called by `destroyInteriorTilemap`. */
  unsubscribe: () => void;
}

/** Parse a layer name's visibility-gate suffix. Three forms are recognised:
 *
 *   `<base>`                          — ungated, always visible.
 *   `<base>@tier:<nodeId>`            — additive: visible iff `nodeId` is
 *                                       unlocked. Use for things that simply
 *                                       appear on upgrade and don't replace
 *                                       anything (e.g. extra props, decor).
 *   `<base>@slot:<slotId>`            — slot base: the broken/default state
 *                                       for a slot. Visible iff no variant
 *                                       of `slotId` is currently active.
 *   `<base>@slot:<slotId>:<nodeId>`   — slot variant: belongs to `slotId`,
 *                                       visible iff `nodeId` is unlocked.
 *                                       When several variants of the same
 *                                       slot are unlocked the LAST one in
 *                                       layer order wins (others + base
 *                                       hide). This makes multi-stage
 *                                       evolution (broken → patched →
 *                                       polished) and customisation
 *                                       (wooden vs stone) fall out of the
 *                                       same primitive — author the
 *                                       preferred variant later in the
 *                                       Tiled layer list.
 */
export type LayerGate =
  | { kind: "none"; base: string }
  | { kind: "tier"; base: string; nodeId: string }
  | { kind: "slot-base"; base: string; slotId: string }
  | { kind: "slot-variant"; base: string; slotId: string; nodeId: string };

const SLOT_RE = /^(.+)@slot:([A-Za-z0-9_]+)(?::([A-Za-z0-9_]+))?$/;
const TIER_RE = /^(.+)@tier:([A-Za-z0-9_]+)$/;

export function parseLayerGate(name: string): LayerGate {
  const slot = SLOT_RE.exec(name);
  if (slot) {
    const [, base, slotId, nodeId] = slot;
    return nodeId
      ? { kind: "slot-variant", base, slotId, nodeId }
      : { kind: "slot-base", base, slotId };
  }
  const tier = TIER_RE.exec(name);
  if (tier) return { kind: "tier", base: tier[1], nodeId: tier[2] };
  return { kind: "none", base: name };
}

function layerHasYSort(layerData: Phaser.Tilemaps.LayerData): boolean {
  const props = layerData.properties as unknown;
  if (!props) return false;
  if (Array.isArray(props)) {
    for (const p of props as Array<{ name?: string; value?: unknown }>) {
      if (p?.name === "y-sort" && p.value === true) return true;
    }
    return false;
  }
  if (typeof props === "object") {
    return (props as Record<string, unknown>)["y-sort"] === true;
  }
  return false;
}

/** Replace a tilemap layer's visible render with per-tile Image game objects
 *  whose depth = the tile's bottom world y. The underlying tilemap layer is
 *  kept (for collision/registry queries) but hidden. */
function extractYSortImages(
  scene: Phaser.Scene,
  layer: Phaser.Tilemaps.TilemapLayer,
  renderScale: number,
): Phaser.GameObjects.Image[] {
  const out: Phaser.GameObjects.Image[] = [];
  const tmap = layer.tilemap;
  for (let ty = 0; ty < tmap.height; ty++) {
    for (let tx = 0; tx < tmap.width; tx++) {
      const tile = layer.getTileAt(tx, ty);
      if (!tile || tile.index < 0) continue;
      const tileset = tile.tileset;
      if (!tileset) continue;
      const coords = tileset.getTileTextureCoordinates(tile.index) as
        | { x: number; y: number }
        | null;
      if (!coords) continue;
      const imageKey = tileset.image?.key;
      if (!imageKey) continue;
      const tw = tileset.tileWidth;
      const th = tileset.tileHeight;
      const frameName = `ysort:${tile.index}`;
      const texture = scene.textures.get(imageKey);
      if (!texture.has(frameName)) {
        texture.add(frameName, 0, coords.x, coords.y, tw, th);
      }
      const wx = tx * tmap.tileWidth * renderScale;
      const wy = ty * tmap.tileHeight * renderScale;
      const img = scene.add
        .image(wx, wy, imageKey, frameName)
        .setOrigin(0, 0)
        .setScale(renderScale)
        .setDepth(wy + th * renderScale);
      out.push(img);
    }
  }
  layer.setVisible(false);
  return out;
}

/** Build an interior tilemap from a cached TMJ. Shared by WorldScene (legacy
 *  load path pre-scene-split) and InteriorScene. */
export function buildInteriorTilemap(
  scene: Phaser.Scene,
  key: string,
): InteriorTilemap | null {
  const cacheKey = interiorTilemapKey(key);
  if (!scene.cache.tilemap.exists(cacheKey)) {
    console.error(`No cached interior tilemap '${cacheKey}'.`);
    return null;
  }
  const tilemap = scene.make.tilemap({ key: cacheKey });
  const cached = scene.cache.tilemap.get(cacheKey) as
    | { data?: unknown & { tilesets?: Array<{ name: string; image: string }> } }
    | undefined;
  const rawTilesets = cached?.data?.tilesets ?? [];
  const imageByName = new Map(rawTilesets.map((t) => [t.name, t.image]));

  const boundTilesets: Phaser.Tilemaps.Tileset[] = [];
  for (const tsDef of tilemap.tilesets) {
    const imagePath = imageByName.get(tsDef.name);
    if (!imagePath) {
      throw new Error(`Interior '${key}': no image path for tileset '${tsDef.name}'.`);
    }
    const bound = tilemap.addTilesetImage(tsDef.name, tilesetImageKeyFor(imagePath));
    if (!bound) {
      throw new Error(`Interior '${key}': failed to bind tileset '${tsDef.name}'.`);
    }
    boundTilesets.push(bound);
  }

  const renderScale = TILE_SIZE / tilemap.tileWidth;
  const layers: Phaser.Tilemaps.TilemapLayer[] = [];
  const ySortImages: Phaser.GameObjects.Image[] = [];

  /** A handle to something we can flip visibility on. For y-sort layers the
   *  underlying tile layer is hidden permanently and the per-tile Images
   *  carry visibility instead, so we abstract over both via setVisible. */
  type Toggleable = { setVisible: (v: boolean) => unknown };

  /** Additive gates (`@tier:`): targets show when their nodeId is unlocked. */
  const tierTargets = new Map<string, Toggleable[]>();
  /** Slot gates: a slot has an optional base (shown when no variant is
   *  active) and zero-or-more variants in author order. The latest unlocked
   *  variant wins. */
  const slots = new Map<
    string,
    {
      base: Toggleable[];
      variants: Array<{ nodeId: string; targets: Toggleable[] }>;
    }
  >();
  const ensureSlot = (slotId: string) => {
    let s = slots.get(slotId);
    if (!s) {
      s = { base: [], variants: [] };
      slots.set(slotId, s);
    }
    return s;
  };

  tilemap.layers.forEach((layerData, idx) => {
    const gate = parseLayerGate(layerData.name);
    const layer = tilemap.createLayer(layerData.name, boundTilesets, 0, 0) as
      | Phaser.Tilemaps.TilemapLayer
      | null;
    if (!layer) return;
    if (renderScale !== 1) layer.setScale(renderScale);
    const overhead = INTERIOR_OVERHEAD_LAYERS.has(gate.base.toLowerCase());
    layer.setDepth(overhead ? INTERIOR_OVERHEAD_DEPTH_BASE + idx : idx);
    layers.push(layer);

    let targets: Toggleable[] = [layer];
    if (layerHasYSort(layerData)) {
      const imgs = extractYSortImages(scene, layer, renderScale);
      for (const img of imgs) ySortImages.push(img);
      targets = imgs;
    }

    switch (gate.kind) {
      case "none":
        break;
      case "tier": {
        const arr = tierTargets.get(gate.nodeId) ?? [];
        arr.push(...targets);
        tierTargets.set(gate.nodeId, arr);
        break;
      }
      case "slot-base":
        ensureSlot(gate.slotId).base.push(...targets);
        break;
      case "slot-variant":
        ensureSlot(gate.slotId).variants.push({
          nodeId: gate.nodeId,
          targets,
        });
        break;
    }
  });

  const registry = new TileRegistry(tilemap);
  const shapes = new ShapeCollider({
    tilemap,
    tileLayers: layers,
    rawTmj: cached?.data,
    renderScale,
  });
  const { exits, entries, repairTargets, workstations, seats } = parseInteriorSpawns(tilemap);

  // ─── Visibility gating ──────────────────────────────────────────────────
  // Look up the business that "owns" this interior. If none, every gated
  // layer stays hidden — no business → no unlocks possible.
  const ownerId = businessIdForInteriorKey(key);

  const applyVisibility = (unlocked: ReadonlySet<string>) => {
    for (const [nodeId, targets] of tierTargets) {
      const visible = unlocked.has(nodeId);
      for (const t of targets) t.setVisible(visible);
    }
    for (const slot of slots.values()) {
      // Latest variant in author order wins. This makes both linear tiers
      // (broken → patched → polished) and customisation forks resolve via
      // the same rule: author the preferred option later in the layer list.
      let activeIdx = -1;
      for (let i = 0; i < slot.variants.length; i++) {
        if (unlocked.has(slot.variants[i].nodeId)) activeIdx = i;
      }
      const baseVisible = activeIdx === -1;
      for (const t of slot.base) t.setVisible(baseVisible);
      for (let i = 0; i < slot.variants.length; i++) {
        const visible = i === activeIdx;
        for (const t of slot.variants[i].targets) t.setVisible(visible);
      }
    }
  };

  const initialUnlocked = ownerId
    ? new Set(useBusinessStore.getState().get(ownerId)?.unlockedNodes ?? [])
    : new Set<string>();
  applyVisibility(initialUnlocked);

  let lastSig = serializeUnlocked(initialUnlocked);
  const unsubscribe = ownerId
    ? useBusinessStore.subscribe((s) => {
        const cur = s.byId[ownerId]?.unlockedNodes ?? [];
        const set = new Set(cur);
        const sig = serializeUnlocked(set);
        if (sig === lastSig) return;
        lastSig = sig;
        applyVisibility(set);
      })
    : () => {};

  return {
    key,
    tilemap,
    layers,
    registry,
    shapes,
    exits,
    entries,
    repairTargets,
    workstations,
    seats,
    ySortImages,
    unsubscribe,
  };
}

function serializeUnlocked(set: ReadonlySet<string>): string {
  return [...set].sort().join("|");
}

export function destroyInteriorTilemap(t: InteriorTilemap): void {
  t.unsubscribe();
  for (const img of t.ySortImages) img.destroy();
  for (const layer of t.layers) layer.destroy();
  t.tilemap.destroy();
}

export function interiorPixelSize(t: InteriorTilemap): { w: number; h: number } {
  return {
    w: t.tilemap.width * TILE_SIZE,
    h: t.tilemap.height * TILE_SIZE,
  };
}
