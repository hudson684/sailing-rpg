import { TILE_SIZE } from "../constants";
import type { ChunkManager } from "./chunkManager";

const FOOTPRINT_TILESET = "Exterior_Five";
const FOOTPRINT_LOCAL_ID = 11;
const FOOTPRINT_LAYER = "beach_walk";
const BEACH_LAYER = "beach";
/** Delay between stepping on a tile and the footprint appearing. */
const FOOTPRINT_DELAY_MS = 150;
/** Time a fresh footprint stays at full opacity. */
const FOOTPRINT_HOLD_MS = 10_000;
/** Linear fade from alpha 1 → 0 immediately after the hold period. */
const FOOTPRINT_FADE_MS = 5_000;

interface PendingStamp {
  cx: number;
  cy: number;
  lx: number;
  ly: number;
  revealAt: number;
}

interface ActiveFootprint {
  cx: number;
  cy: number;
  lx: number;
  ly: number;
  /** Scene-time ms when the footprint was last stamped onto the layer. */
  stampedAt: number;
}

/** Drops a footprint tile under the player ~150ms after they cross into a
 *  beach tile, holds it at full opacity for `FOOTPRINT_HOLD_MS`, then
 *  linearly fades it to nothing over `FOOTPRINT_FADE_MS`. The footprint
 *  art lives in the `beach_walk` tile layer (one per chunk that authors
 *  it); the gid is resolved per-chunk from the `Exterior_Five` tileset so
 *  chunks that don't include that tileset are simply skipped. */
export class BeachFootprintController {
  private readonly manager: ChunkManager;
  private readonly pending = new Map<string, PendingStamp>();
  private readonly active = new Map<string, ActiveFootprint>();
  private lastTile: { gtx: number; gty: number } | null = null;

  constructor(manager: ChunkManager) {
    this.manager = manager;
  }

  update(playerPxX: number, playerPxY: number, nowMs: number): void {
    const gtx = Math.floor(playerPxX / TILE_SIZE);
    const gty = Math.floor(playerPxY / TILE_SIZE);
    if (
      !this.lastTile ||
      this.lastTile.gtx !== gtx ||
      this.lastTile.gty !== gty
    ) {
      this.lastTile = { gtx, gty };
      this.queueStamp(gtx, gty, nowMs);
    }
    this.flushPending(nowMs);
    this.tickAlphas(nowMs);
  }

  /** Reset tile tracking after a teleport / scene transition so the next
   *  movement re-stamps even if it lands on the previously-stamped tile. */
  reset(): void {
    this.lastTile = null;
  }

  private queueStamp(gtx: number, gty: number, nowMs: number): void {
    const chunk = this.manager.chunkAtTile(gtx, gty);
    if (!chunk) return;
    const s = this.manager.manifest.chunkSize;
    const lx = gtx - chunk.cx * s;
    const ly = gty - chunk.cy * s;

    if (!chunk.tilemap.getTileAt(lx, ly, false, BEACH_LAYER)) return;
    if (!chunk.tilemap.getLayer(FOOTPRINT_LAYER)?.tilemapLayer) return;
    if (!chunk.tilemap.getTileset(FOOTPRINT_TILESET)) return;

    const key = `${chunk.cx},${chunk.cy},${lx},${ly}`;
    this.pending.set(key, {
      cx: chunk.cx,
      cy: chunk.cy,
      lx,
      ly,
      revealAt: nowMs + FOOTPRINT_DELAY_MS,
    });
  }

  private flushPending(nowMs: number): void {
    if (this.pending.size === 0) return;
    const s = this.manager.manifest.chunkSize;
    let fired: string[] | null = null;
    for (const [key, p] of this.pending) {
      if (p.revealAt > nowMs) continue;
      (fired ??= []).push(key);
      const chunk = this.manager.chunkAtTile(p.cx * s, p.cy * s);
      if (!chunk) continue;
      const layerData = chunk.tilemap.getLayer(FOOTPRINT_LAYER);
      if (!layerData?.tilemapLayer) continue;
      const ts = chunk.tilemap.getTileset(FOOTPRINT_TILESET);
      if (!ts) continue;
      const gid = ts.firstgid + FOOTPRINT_LOCAL_ID;
      let tile = layerData.tilemapLayer.getTileAt(p.lx, p.ly);
      if (!tile) tile = layerData.tilemapLayer.putTileAt(gid, p.lx, p.ly);
      if (tile) tile.setAlpha(1);
      this.active.set(key, {
        cx: p.cx,
        cy: p.cy,
        lx: p.lx,
        ly: p.ly,
        stampedAt: nowMs,
      });
    }
    if (fired) for (const k of fired) this.pending.delete(k);
  }

  private tickAlphas(nowMs: number): void {
    if (this.active.size === 0) return;
    const s = this.manager.manifest.chunkSize;
    let removed: string[] | null = null;
    for (const [key, fp] of this.active) {
      const age = nowMs - fp.stampedAt;
      if (age <= FOOTPRINT_HOLD_MS) continue;
      const chunk = this.manager.chunkAtTile(fp.cx * s, fp.cy * s);
      if (!chunk) continue;
      const layerData = chunk.tilemap.getLayer(FOOTPRINT_LAYER);
      if (!layerData?.tilemapLayer) continue;
      const fadeAge = age - FOOTPRINT_HOLD_MS;
      if (fadeAge >= FOOTPRINT_FADE_MS) {
        layerData.tilemapLayer.removeTileAt(fp.lx, fp.ly);
        (removed ??= []).push(key);
        continue;
      }
      const tile = layerData.tilemapLayer.getTileAt(fp.lx, fp.ly);
      if (tile) tile.setAlpha(1 - fadeAge / FOOTPRINT_FADE_MS);
    }
    if (removed) for (const k of removed) this.active.delete(k);
  }
}
