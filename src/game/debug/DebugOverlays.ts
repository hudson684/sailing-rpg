import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import type { WorldMap } from "../world/worldMap";
import { Ship, type DockedPose, type Heading, headingToRotation, normalizeAngle } from "../entities/Ship";

export type OverlayName = "walkability" | "chunkGrid" | "spawns" | "anchorSearch";

const OVERLAY_DEPTH = 10000;
const ANCHOR_SEARCH_RADIUS = 6;

export interface DebugOverlayHooks {
  /** Current ship pose for the anchorSearch overlay. Null if no ship yet. */
  getShipPose: () => { x: number; y: number; rotation: number } | null;
  /** True when the player is at the helm (controls whether anchorSearch shows). */
  isAtHelm: () => boolean;
}

export class DebugOverlays {
  private readonly scene: Phaser.Scene;
  private readonly world: WorldMap;
  private readonly hooks: DebugOverlayHooks;
  private readonly gfx: Record<OverlayName, Phaser.GameObjects.Graphics>;
  private readonly active: Record<OverlayName, boolean> = {
    walkability: false,
    chunkGrid: false,
    spawns: false,
    anchorSearch: false,
  };
  private readonly hud: Phaser.GameObjects.Text;
  private readonly spawnLabels: Phaser.GameObjects.Text[] = [];
  private readonly chunkLabels: Phaser.GameObjects.Text[] = [];

  constructor(scene: Phaser.Scene, world: WorldMap, hooks: DebugOverlayHooks) {
    this.scene = scene;
    this.world = world;
    this.hooks = hooks;

    this.gfx = {
      walkability: scene.add.graphics().setDepth(OVERLAY_DEPTH).setVisible(false),
      chunkGrid: scene.add.graphics().setDepth(OVERLAY_DEPTH + 1).setVisible(false),
      spawns: scene.add.graphics().setDepth(OVERLAY_DEPTH + 2).setVisible(false),
      anchorSearch: scene.add.graphics().setDepth(OVERLAY_DEPTH + 3).setVisible(false),
    };

    this.hud = scene.add
      .text(8, 8, "", { fontSize: "12px", color: "#cfe7ff", backgroundColor: "rgba(0,0,0,0.55)" })
      .setScrollFactor(0)
      .setDepth(OVERLAY_DEPTH + 10)
      .setPadding(6, 3, 6, 3)
      .setVisible(false);

    this.refreshHud();
  }

  toggle(name: OverlayName): void {
    this.active[name] = !this.active[name];
    this.gfx[name].setVisible(this.active[name]);
    if (!this.active[name]) this.clearLabels(name);
    this.refreshHud();
    // Redraw immediately so the toggle feels instant when paused.
    this.update();
  }

  update(): void {
    if (this.active.walkability) this.drawWalkability();
    if (this.active.chunkGrid) this.drawChunkGrid();
    if (this.active.spawns) this.drawSpawns();
    if (this.active.anchorSearch) this.drawAnchorSearch();
  }

  // ── walkability ────────────────────────────────────────────────

  private drawWalkability(): void {
    const g = this.gfx.walkability;
    g.clear();
    const view = this.cameraTileRect();
    const mgr = this.world.manager;
    for (let ty = view.ty0; ty < view.ty1; ty++) {
      for (let tx = view.tx0; tx < view.tx1; tx++) {
        const blocked = mgr.isBlocked(tx, ty);
        const water = mgr.isWater(tx, ty);
        // Only tint non-walkable tiles; land-walkable stays transparent to keep the view readable.
        if (blocked) g.fillStyle(0xff3030, 0.35);
        else if (water) g.fillStyle(0x3060ff, 0.25);
        else continue;
        g.fillRect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  // ── chunk grid ────────────────────────────────────────────────

  private drawChunkGrid(): void {
    const g = this.gfx.chunkGrid;
    g.clear();
    this.disposeLabels(this.chunkLabels);
    const s = this.world.manager.manifest.chunkSize;
    const chunkPx = s * TILE_SIZE;
    const b = this.world.bounds;
    const minCx = Math.floor(b.minTx / s);
    const minCy = Math.floor(b.minTy / s);
    const maxCx = Math.ceil(b.maxTx / s);
    const maxCy = Math.ceil(b.maxTy / s);
    g.lineStyle(2, 0xffcc33, 0.75);
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        g.strokeRect(cx * chunkPx, cy * chunkPx, chunkPx, chunkPx);
      }
    }
    for (let cy = minCy; cy < maxCy; cy++) {
      for (let cx = minCx; cx < maxCx; cx++) {
        const label = this.scene.add
          .text(cx * chunkPx + 4, cy * chunkPx + 4, `${cx},${cy}`, {
            fontSize: "10px",
            color: "#ffd866",
            backgroundColor: "rgba(0,0,0,0.5)",
          })
          .setPadding(2, 1, 2, 1)
          .setDepth(OVERLAY_DEPTH + 1);
        this.chunkLabels.push(label);
      }
    }
  }

  // ── spawns ────────────────────────────────────────────────────

  private drawSpawns(): void {
    const g = this.gfx.spawns;
    g.clear();
    this.disposeLabels(this.spawnLabels);
    const { ship, dock, items } = this.world.spawns;
    this.markSpawn(g, ship.tileX, ship.tileY, 0x66ccff, "ship");
    this.markSpawn(g, dock.tileX, dock.tileY, 0xffaa44, "dock");
    for (const it of items) {
      this.markSpawn(g, it.tileX, it.tileY, 0x66ff88, `${it.itemId}${it.quantity > 1 ? `×${it.quantity}` : ""}`);
    }
  }

  private markSpawn(
    g: Phaser.GameObjects.Graphics,
    tx: number,
    ty: number,
    color: number,
    label: string,
  ): void {
    const cx = (tx + 0.5) * TILE_SIZE;
    const cy = (ty + 0.5) * TILE_SIZE;
    g.lineStyle(2, color, 1);
    g.fillStyle(color, 0.3);
    g.fillCircle(cx, cy, TILE_SIZE * 0.45);
    g.strokeCircle(cx, cy, TILE_SIZE * 0.45);
    const text = this.scene.add
      .text(cx, cy - TILE_SIZE * 0.6, label, {
        fontSize: "10px",
        color: "#ffffff",
        backgroundColor: "rgba(0,0,0,0.6)",
      })
      .setOrigin(0.5, 1)
      .setPadding(2, 1, 2, 1)
      .setDepth(OVERLAY_DEPTH + 2);
    this.spawnLabels.push(text);
  }

  // ── anchor search ─────────────────────────────────────────────

  private drawAnchorSearch(): void {
    const g = this.gfx.anchorSearch;
    g.clear();
    if (!this.hooks.isAtHelm()) return;
    const pose = this.hooks.getShipPose();
    if (!pose) return;

    const candidates: Array<{ pose: DockedPose; cost: number; clear: boolean }> = [];
    const cx = pose.x / TILE_SIZE;
    const cy = pose.y / TILE_SIZE;
    const mgr = this.world.manager;

    let minCost = Infinity;
    let maxCost = -Infinity;

    for (let dy = -ANCHOR_SEARCH_RADIUS; dy <= ANCHOR_SEARCH_RADIUS; dy++) {
      for (let dx = -ANCHOR_SEARCH_RADIUS; dx <= ANCHOR_SEARCH_RADIUS; dx++) {
        for (let h = 0 as Heading; h < 4; h = (h + 1) as Heading) {
          const bboxW = h === 1 || h === 3 ? 3 : 2;
          const bboxH = h === 1 || h === 3 ? 2 : 3;
          const tx = Math.round(cx + dx - bboxW / 2);
          const ty = Math.round(cy + dy - bboxH / 2);
          const cand: DockedPose = { tx, ty, heading: h };
          const clear = Ship.footprint(cand).every((t) => mgr.isWater(t.x, t.y));
          const center = Ship.bboxCenterPx(cand);
          const dpx = center.x - pose.x;
          const dpy = center.y - pose.y;
          const distSq = dpx * dpx + dpy * dpy;
          const rotDelta = Math.abs(normalizeAngle(headingToRotation(h) - pose.rotation));
          const cost = distSq + rotDelta * 400;
          candidates.push({ pose: cand, cost, clear });
          if (clear) {
            if (cost < minCost) minCost = cost;
            if (cost > maxCost) maxCost = cost;
          }
          if (h === 3) break;
        }
      }
    }

    const span = Math.max(1, maxCost - minCost);
    for (const c of candidates) {
      const center = Ship.bboxCenterPx(c.pose);
      if (!c.clear) {
        g.lineStyle(1, 0xff3333, 0.5);
        g.strokeCircle(center.x, center.y, 3);
        continue;
      }
      const t = (c.cost - minCost) / span; // 0 = best, 1 = worst
      // Green → yellow → red gradient.
      const r = Math.round(255 * Math.min(1, t * 2));
      const gg = Math.round(255 * Math.min(1, 2 - t * 2));
      const color = (r << 16) | (gg << 8);
      g.lineStyle(2, color, 0.9);
      g.fillStyle(color, 0.2);
      const pxW = (c.pose.heading === 1 || c.pose.heading === 3 ? 3 : 2) * TILE_SIZE;
      const pxH = (c.pose.heading === 1 || c.pose.heading === 3 ? 2 : 3) * TILE_SIZE;
      g.fillRect(c.pose.tx * TILE_SIZE, c.pose.ty * TILE_SIZE, pxW, pxH);
      g.strokeRect(c.pose.tx * TILE_SIZE, c.pose.ty * TILE_SIZE, pxW, pxH);
    }
  }

  // ── helpers ───────────────────────────────────────────────────

  private cameraTileRect(): { tx0: number; ty0: number; tx1: number; ty1: number } {
    const cam = this.scene.cameras.main;
    const zoom = cam.zoom || 1;
    const wPx = cam.width / zoom;
    const hPx = cam.height / zoom;
    const tx0 = Math.floor(cam.scrollX / TILE_SIZE);
    const ty0 = Math.floor(cam.scrollY / TILE_SIZE);
    const tx1 = Math.ceil((cam.scrollX + wPx) / TILE_SIZE);
    const ty1 = Math.ceil((cam.scrollY + hPx) / TILE_SIZE);
    return { tx0, ty0, tx1, ty1 };
  }

  private clearLabels(name: OverlayName): void {
    if (name === "spawns") this.disposeLabels(this.spawnLabels);
    else if (name === "chunkGrid") this.disposeLabels(this.chunkLabels);
  }

  private disposeLabels(list: Phaser.GameObjects.Text[]): void {
    for (const t of list) t.destroy();
    list.length = 0;
  }

  private refreshHud(): void {
    const on = (Object.keys(this.active) as OverlayName[]).filter((k) => this.active[k]);
    if (on.length === 0) {
      this.hud.setVisible(false);
      return;
    }
    this.hud.setText(`debug: ${on.join(", ")}  [F1 walk, F2 grid, F3 spawns, F4 anchor]`);
    this.hud.setVisible(true);
  }
}
