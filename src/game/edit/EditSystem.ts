import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import {
  bus,
  type EditDeleteRequest,
  type EditEntityKind,
  type EditMoveRequest,
  type EditPlaceRequest,
  type EditShopUpdate,
  type EditSnapshot,
} from "../bus";
import { showToast } from "../../ui/store/ui";
import type { EditHost } from "./EditHost";

const PICK_RADIUS = TILE_SIZE * 0.9;
const HIGHLIGHT_COLORS: Record<EditEntityKind, number> = {
  npc: 0x5fd7ff,
  enemy: 0xff6b6b,
  node: 0xffd65f,
  item: 0xb57bff,
  ship: 0x7bffc7,
  station: 0xff9e42,
};

/**
 * Scene-agnostic developer edit overlay. Bound to a single scene via its host;
 * one host is active at a time (whichever scene is in front). Owns F7, pointer
 * input, highlight graphics, snapshot emission, and bus wiring. Delegates
 * place/move/delete/export to the host so interiors and the world can share
 * this machinery.
 *
 * Only instantiated in DEV builds — see callers.
 */
export class EditSystem {
  private readonly host: EditHost;
  private readonly scene: Phaser.Scene;

  private active = false;
  private highlight?: Phaser.GameObjects.Graphics;
  private drag:
    | { kind: EditEntityKind; id: string; startX: number; startY: number; moved: boolean }
    | null = null;

  private readonly unsubs: Array<() => void> = [];

  constructor(host: EditHost) {
    this.host = host;
    this.scene = host.editScene;
    this.install();
  }

  private install() {
    const scene = this.scene;
    this.highlight = scene.add.graphics().setDepth(9500).setVisible(false);

    const keyboard = scene.input.keyboard;
    if (keyboard) {
      const f7 = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.F7);
      const onF7 = () => bus.emitTyped("edit:toggle");
      f7.on("down", onF7);
      this.unsubs.push(() => f7.off("down", onF7));
    }

    // Pointer: left-down is capture-point for drag / select / place.
    const onPointerDown = (pointer: Phaser.Input.Pointer) => {
      if (!this.active || !pointer.leftButtonDown()) return;
      this.onPointerDown(pointer.worldX, pointer.worldY);
    };
    const onPointerMove = (pointer: Phaser.Input.Pointer) => {
      if (!this.active || !this.drag) return;
      this.onPointerMove(pointer.worldX, pointer.worldY);
    };
    const onPointerUp = (pointer: Phaser.Input.Pointer) => {
      if (!this.active) return;
      this.onPointerUp(pointer.worldX, pointer.worldY);
    };
    scene.input.on("pointerdown", onPointerDown);
    scene.input.on("pointermove", onPointerMove);
    scene.input.on("pointerup", onPointerUp);
    this.unsubs.push(() => {
      scene.input.off("pointerdown", onPointerDown);
      scene.input.off("pointermove", onPointerMove);
      scene.input.off("pointerup", onPointerUp);
    });

    const onToggle = () => this.toggle();
    const onSnapshot = () => this.emitState();
    const onPlace = (req: EditPlaceRequest) => {
      if (this.host.place(req)) this.emitState();
    };
    const onMove = (req: EditMoveRequest) => {
      if (this.host.move(req)) this.emitState();
    };
    const onDelete = (req: EditDeleteRequest) => {
      if (this.host.delete(req)) this.emitState();
    };
    const onShopUpdate = (req: EditShopUpdate) => {
      if (this.host.updateShop?.(req)) this.emitState();
    };
    const onExport = () => {
      const files = this.host.exportFiles();
      bus.emitTyped("edit:export", { files });
    };

    bus.onTyped("edit:toggle", onToggle);
    bus.onTyped("edit:requestSnapshot", onSnapshot);
    bus.onTyped("edit:place", onPlace);
    bus.onTyped("edit:move", onMove);
    bus.onTyped("edit:delete", onDelete);
    bus.onTyped("edit:shopUpdate", onShopUpdate);
    bus.onTyped("edit:requestExport", onExport);

    this.unsubs.push(() => {
      bus.offTyped("edit:toggle", onToggle);
      bus.offTyped("edit:requestSnapshot", onSnapshot);
      bus.offTyped("edit:place", onPlace);
      bus.offTyped("edit:move", onMove);
      bus.offTyped("edit:delete", onDelete);
      bus.offTyped("edit:shopUpdate", onShopUpdate);
      bus.offTyped("edit:requestExport", onExport);
    });

    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
    // On sleep (e.g. WorldScene sleeps while InteriorScene runs), drop
    // subscriptions so the active scene's system owns the bus.
    scene.events.on(Phaser.Scenes.Events.SLEEP, this.onSleep);
    scene.events.on(Phaser.Scenes.Events.WAKE, this.onWake);
  }

  private onSleep = () => {
    // Suspend: hide overlay and deactivate. A sleeping scene's system must not
    // react to F7/pointer or emit snapshots, so the awake scene's system is
    // unambiguous. We don't destroy subscriptions — wake re-arms via onWake.
    if (this.active) {
      this.active = false;
      this.drag = null;
      this.highlight?.clear();
      this.highlight?.setVisible(false);
      bus.emitTyped("edit:state", { active: false, snapshot: null });
    }
  };

  private onWake = () => {
    // Nothing to do — on wake, the user presses F7 again to re-enter edit.
  };

  private destroy() {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.highlight?.destroy();
    this.highlight = undefined;
    this.scene.events.off(Phaser.Scenes.Events.SLEEP, this.onSleep);
    this.scene.events.off(Phaser.Scenes.Events.WAKE, this.onWake);
  }

  isActive(): boolean {
    return this.active;
  }

  private toggle() {
    // Only the frontmost (non-sleeping) system should respond. Phaser dispatches
    // the bus event to every installed system; the sleeping one noops thanks
    // to `isActive`.
    if (!this.scene.scene.isActive()) return;
    this.active = !this.active;
    if (this.active) {
      showToast("Edit mode ON — left-click to select/place. F7 to exit.", 2500);
    } else {
      showToast("Edit mode OFF.", 1500);
      this.highlight?.clear();
      this.highlight?.setVisible(false);
    }
    this.emitState();
  }

  private emitState() {
    if (!this.scene.scene.isActive()) return;
    if (!this.active) {
      bus.emitTyped("edit:state", { active: false, snapshot: null });
      this.highlight?.clear();
      this.highlight?.setVisible(false);
      return;
    }
    const partial = this.host.buildSnapshot();
    const snapshot: EditSnapshot = {
      ...partial,
      defs: this.host.getDefs(),
      supportedKinds: [...this.host.supportedKinds],
    };
    bus.emitTyped("edit:state", { active: true, snapshot });
    this.redrawHighlights();
  }

  private redrawHighlights() {
    const g = this.highlight;
    if (!g) return;
    g.clear();
    g.setVisible(true);
    for (const ent of this.host.entities()) {
      g.lineStyle(2, HIGHLIGHT_COLORS[ent.kind], 0.9);
      g.strokeCircle(ent.x, ent.y, PICK_RADIUS);
    }
  }

  private findAt(worldX: number, worldY: number): { kind: EditEntityKind; id: string } | null {
    let best: { kind: EditEntityKind; id: string; d: number } | null = null;
    for (const ent of this.host.entities()) {
      const d = Phaser.Math.Distance.Between(worldX, worldY, ent.x, ent.y);
      if (d > PICK_RADIUS) continue;
      if (!best || d < best.d) best = { kind: ent.kind, id: ent.id, d };
    }
    return best ? { kind: best.kind, id: best.id } : null;
  }

  private onPointerDown(worldX: number, worldY: number) {
    const hit = this.findAt(worldX, worldY);
    this.drag = hit
      ? { kind: hit.kind, id: hit.id, startX: worldX, startY: worldY, moved: false }
      : null;
  }

  private onPointerMove(worldX: number, worldY: number) {
    const drag = this.drag;
    if (!drag) return;
    const dx = worldX - drag.startX;
    const dy = worldY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    this.host.dragTo?.(drag.kind, drag.id, worldX, worldY);
  }

  private onPointerUp(worldX: number, worldY: number) {
    const drag = this.drag;
    this.drag = null;
    const tileX = Math.floor(worldX / TILE_SIZE);
    const tileY = Math.floor(worldY / TILE_SIZE);

    if (drag && drag.moved) {
      if (this.host.move({ kind: drag.kind, id: drag.id, tileX, tileY })) {
        this.emitState();
      }
      return;
    }
    if (drag && !drag.moved && this.host.onEntityTap?.(drag.kind, drag.id)) {
      this.emitState();
      return;
    }
    // No-drag click: select / place. Emit edit:click for the React overlay.
    const hit = this.findAt(worldX, worldY);
    bus.emitTyped("edit:click", { worldX, worldY, tileX, tileY, hit });
  }
}
