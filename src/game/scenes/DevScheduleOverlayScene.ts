import * as Phaser from "phaser";
import {
  captureScheduleSnapshot,
  describeAgentVerbose,
} from "../dev/scheduleSnapshot";
import type { ScheduleSnapshotRow } from "../dev/scheduleSnapshot";
import { npcRegistry } from "../sim/npcRegistry";

/** Phase 4 dev-only overlay. Toggle with F9. Lists every NPC in the
 *  registry with mode/scene/activity/ETA. Right-click a row → console
 *  drilldown of full agent state. Shift-click → switch to that NPC's
 *  scene if loadable.
 *
 *  Only registered when `import.meta.env.DEV` is true; the production
 *  bundle never imports the scene module. */
export class DevScheduleOverlayScene extends Phaser.Scene {
  static readonly KEY = "DevScheduleOverlay";

  private overlay: Phaser.GameObjects.Container | null = null;
  private bg: Phaser.GameObjects.Rectangle | null = null;
  private headerText: Phaser.GameObjects.Text | null = null;
  private rowTexts: Phaser.GameObjects.Text[] = [];
  private rowZones: Phaser.GameObjects.Zone[] = [];
  private refreshTimer: Phaser.Time.TimerEvent | null = null;
  private toggleHandler: ((event: KeyboardEvent) => void) | null = null;
  private visible = false;

  constructor() {
    super({ key: DevScheduleOverlayScene.KEY, active: true, visible: true });
  }

  create(): void {
    // Build but don't show — toggle drives visibility.
    this.buildOverlay();
    if (this.overlay) this.overlay.setVisible(false);

    // Global F9 hotkey listener via DOM (avoids fighting with scene-scoped
    // input which only fires when this scene is the keyboard target).
    this.toggleHandler = (event: KeyboardEvent) => {
      if (event.key === "F9") {
        event.preventDefault();
        this.toggle();
      }
    };
    window.addEventListener("keydown", this.toggleHandler);

    this.events.on(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);
    this.events.on(Phaser.Scenes.Events.DESTROY, this.cleanup, this);
  }

  private cleanup(): void {
    if (this.toggleHandler) {
      window.removeEventListener("keydown", this.toggleHandler);
      this.toggleHandler = null;
    }
    if (this.refreshTimer) {
      this.refreshTimer.remove();
      this.refreshTimer = null;
    }
  }

  private toggle(): void {
    this.visible = !this.visible;
    if (!this.overlay) return;
    this.overlay.setVisible(this.visible);
    if (this.visible) {
      this.refreshRows();
      this.refreshTimer = this.time.addEvent({
        delay: 1000,
        loop: true,
        callback: () => this.refreshRows(),
      });
      this.scene.bringToTop(DevScheduleOverlayScene.KEY);
    } else if (this.refreshTimer) {
      this.refreshTimer.remove();
      this.refreshTimer = null;
    }
  }

  private buildOverlay(): void {
    const w = this.scale.gameSize.width;
    const h = this.scale.gameSize.height;
    const panelW = Math.min(720, w - 40);
    const panelH = Math.min(560, h - 40);
    const x = w - panelW - 20;
    const y = 20;

    this.bg = this.add.rectangle(x, y, panelW, panelH, 0x000000, 0.78).setOrigin(0, 0);
    this.bg.setDepth(10000);
    this.bg.setStrokeStyle(1, 0x44ccff, 0.8);

    this.headerText = this.add.text(x + 8, y + 6, "NPC Schedule (F9)  • shift-click row: warp scene  • right-click: dump", {
      color: "#bdf",
      fontFamily: "monospace",
      fontSize: "11px",
    }).setDepth(10001);

    this.overlay = this.add.container(0, 0, [this.bg, this.headerText]).setScrollFactor(0).setDepth(10000);
  }

  private refreshRows(): void {
    if (!this.bg || !this.overlay) return;
    const activeSceneKey = this.findActiveWorldSceneKey();
    const rows = captureScheduleSnapshot(activeSceneKey);
    // Tear down previous row texts; rebuild. Cheap for the row count we
    // expect (under 100 agents in practice).
    for (const t of this.rowTexts) t.destroy();
    for (const z of this.rowZones) z.destroy();
    this.rowTexts = [];
    this.rowZones = [];
    const x = this.bg.x;
    const y = this.bg.y;
    const lineH = 13;
    const startY = y + 26;
    const maxRows = Math.floor((this.bg.height - 30) / lineH);
    for (let i = 0; i < Math.min(rows.length, maxRows); i++) {
      const r = rows[i];
      const eta = r.etaMinutes !== null ? `${r.etaMinutes}m` : "—";
      const line =
        `${r.mode === "live" ? "L" : "a"} ${r.npcId.padEnd(28).slice(0, 28)} ` +
        `${r.scene.padEnd(20).slice(0, 20)} ${r.currentActivity.padEnd(13).slice(0, 13)} ` +
        `next:${(r.nextActivity ?? "—").padEnd(11).slice(0, 11)} ${eta.padStart(4)}` +
        (r.resolvedKey ? `  [${r.resolvedKey}]` : "");
      const t = this.add.text(x + 8, startY + i * lineH, line, {
        color: r.mode === "live" ? "#7f7" : "#bbb",
        fontFamily: "monospace",
        fontSize: "10px",
      }).setDepth(10001);
      const z = this.add
        .zone(x + 4, startY + i * lineH - 2, this.bg.width - 8, lineH)
        .setOrigin(0, 0)
        .setDepth(10002)
        .setInteractive({ useHandCursor: true });
      z.on("pointerdown", (pointer: Phaser.Input.Pointer) => this.onRowClick(r, pointer));
      this.rowTexts.push(t);
      this.rowZones.push(z);
      this.overlay!.add(t);
      this.overlay!.add(z);
    }
  }

  private onRowClick(row: ScheduleSnapshotRow, pointer: Phaser.Input.Pointer): void {
    const agent = npcRegistry.get(row.npcId);
    if (!agent) {
      // eslint-disable-next-line no-console
      console.warn(`[DevOverlay] row ${row.npcId} no longer registered`);
      return;
    }
    if (pointer.rightButtonDown()) {
      // eslint-disable-next-line no-console
      console.log("[DevOverlay] verbose:", describeAgentVerbose(agent));
      return;
    }
    const ev = pointer.event as { shiftKey?: boolean } | undefined;
    if (ev && ev.shiftKey) {
      // eslint-disable-next-line no-console
      console.log(`[DevOverlay] shift-click ${row.npcId}: scene warp not implemented (NPC is in '${row.scene}')`);
      return;
    }
    // Plain click: log just the basics.
    // eslint-disable-next-line no-console
    console.log(`[DevOverlay] ${row.npcId} → ${row.currentActivity} @ ${row.scene} (next: ${row.nextActivity ?? "—"})`);
  }

  /** Best-effort: find a Phaser scene with a "currentMapId" or similar
   *  that we can map to a sim scene key. We don't import WorldScene/
   *  InteriorScene to keep the overlay a leaf node. Returns null when we
   *  can't determine; the snapshot then treats every agent as abstract. */
  private findActiveWorldSceneKey(): string | null {
    // The overlay can't ask the world scene directly without importing it
    // (and we want to keep the dev overlay decoupled). Use the heuristic
    // that the most-recently-active "WorldScene"/"InteriorScene" in the
    // game's scene manager corresponds to the player's current scene.
    const mgr = this.game.scene;
    for (const s of mgr.getScenes(true)) {
      // SystemsScene / DevScheduleOverlay aren't world scenes.
      const k = s.scene.key;
      if (k === "World") return "chunk:world";
      if (k.startsWith("Interior:")) return `interior:${k.slice("Interior:".length)}`;
    }
    return null;
  }
}
