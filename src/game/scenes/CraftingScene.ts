import * as Phaser from "phaser";
import { bus } from "../bus";
import type { CraftingOutcomeTier } from "../bus";
import { recipes } from "../crafting/recipes";
import { craftingStations } from "../crafting/stations";
import type { CraftingStationDef, RecipeDef } from "../crafting/types";

/**
 * Generic minigame overlay for crafting stations that have a `minigame`
 * config on their recipe. Skill-agnostic: theming comes from the station
 * def, difficulty from the recipe. The only action kind today is "strike"
 * (timing-window bar); new action kinds can be added by extending the
 * strike branch without forking the scene per-skill.
 *
 * Lifecycle:
 *   WorldScene.pause() → CraftingScene.launch({stationDefId, recipeId})
 *   → minigame runs, emits "crafting:complete" on success/fail OR
 *     "crafting:cancel" if player presses ESC
 *   → scene stops; WorldScene resumes and applies the result.
 */

const FILL_PER_TIER: Record<"miss" | "good" | "great" | "perfect", number> = {
  miss: 0,
  good: 12,
  great: 18,
  perfect: 25,
};

const TARGET_FILL = 100;

const PANEL_W = 480;
const PANEL_H = 260;
const COMP_BAR_W = PANEL_W - 40;
const TIMING_BAR_W = PANEL_W - 40;

export interface CraftingSceneInit {
  stationDefId: string;
  recipeId: string;
}

type HitKind = "miss" | "good" | "great" | "perfect";

export class CraftingScene extends Phaser.Scene {
  private recipe!: RecipeDef;
  private stationDef!: CraftingStationDef;
  private fill = 0;
  private movesUsed = 0;
  private perfects = 0;
  private greats = 0;
  private goods = 0;
  private finished = false;

  private barCenterX = 0;
  private barY = 0;
  private windowLeftX = 0;
  private windowRightX = 0;

  private indicator!: Phaser.GameObjects.Rectangle;
  private completionBar!: Phaser.GameObjects.Rectangle;
  private budgetText!: Phaser.GameObjects.Text;
  private feedbackText!: Phaser.GameObjects.Text;
  private sweepTween?: Phaser.Tweens.Tween;
  private spaceKey?: Phaser.Input.Keyboard.Key;
  private escKey?: Phaser.Input.Keyboard.Key;

  constructor() {
    super({ key: "Crafting" });
  }

  init(data: CraftingSceneInit) {
    const recipe = recipes.tryGet(data.recipeId);
    const station = craftingStations.tryGet(data.stationDefId);
    if (!recipe || !station || !recipe.minigame) {
      // Nothing to run; fire a cancel so the world scene unpauses cleanly.
      bus.emitTyped("crafting:cancel");
      this.scene.stop();
      return;
    }
    this.recipe = recipe;
    this.stationDef = station;
    this.fill = 0;
    this.movesUsed = 0;
    this.perfects = this.greats = this.goods = 0;
    this.finished = false;
  }

  create() {
    if (!this.recipe || !this.stationDef) return;
    const mg = this.recipe.minigame;
    if (!mg) return;

    const cam = this.cameras.main;
    const W = cam.width;
    const H = cam.height;

    // Ensure we render on top of the (paused) world scene.
    this.scene.bringToTop();

    // Dim backdrop
    this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.55);

    // Panel
    const accentHex = this.stationDef.accentColor;
    const accent = Phaser.Display.Color.HexStringToColor(accentHex).color;
    const bgHex = this.stationDef.bgColor;
    const bgCol = Phaser.Display.Color.HexStringToColor(bgHex).color;
    const panel = this.add.rectangle(W / 2, H / 2, PANEL_W, PANEL_H, 0x1a1a22, 0.96);
    panel.setStrokeStyle(3, accent);
    // Accent strip at the panel's top to visually match the station.
    this.add.rectangle(W / 2, H / 2 - PANEL_H / 2 + 5, PANEL_W - 12, 4, bgCol, 0.85).setOrigin(0.5);

    // Title
    this.add
      .text(W / 2, H / 2 - PANEL_H / 2 + 18, `${this.stationDef.name} — ${this.recipe.name}`, {
        fontFamily: "monospace",
        fontSize: "14px",
        color: this.stationDef.labelColor,
        align: "center",
      })
      .setOrigin(0.5, 0);

    // Budget/Fill counter
    this.budgetText = this.add
      .text(W / 2, H / 2 - PANEL_H / 2 + 46, this.budgetLabel(), {
        fontFamily: "monospace",
        fontSize: "11px",
        color: "#c8ccd8",
      })
      .setOrigin(0.5, 0);

    // Completion bar
    const compBarY = H / 2 - 40;
    this.add.rectangle(W / 2, compBarY, COMP_BAR_W, 8, 0x333844).setOrigin(0.5);
    this.completionBar = this.add
      .rectangle(W / 2 - COMP_BAR_W / 2, compBarY, 0, 8, 0x4fd17a)
      .setOrigin(0, 0.5);

    // Timing bar
    this.barCenterX = W / 2;
    this.barY = H / 2 + 20;
    this.add.rectangle(this.barCenterX, this.barY, TIMING_BAR_W, 22, 0x2a2e38).setOrigin(0.5);

    // Hit window
    const windowW = TIMING_BAR_W * mg.windowSize;
    this.windowLeftX = this.barCenterX - windowW / 2;
    this.windowRightX = this.barCenterX + windowW / 2;
    this.add.rectangle(this.barCenterX, this.barY, windowW, 22, accent, 0.35).setOrigin(0.5);
    // Perfect sub-zone (inner stripe)
    this.add.rectangle(this.barCenterX, this.barY, windowW * 0.3, 22, accent, 0.7).setOrigin(0.5);

    // Moving indicator
    const leftEdge = this.barCenterX - TIMING_BAR_W / 2;
    const rightEdge = this.barCenterX + TIMING_BAR_W / 2;
    this.indicator = this.add
      .rectangle(leftEdge, this.barY, 4, 30, 0xffffff)
      .setOrigin(0.5);

    // Instructions
    this.add
      .text(W / 2, H / 2 + PANEL_H / 2 - 36, "SPACE / click: strike   ·   ESC: cancel", {
        fontFamily: "monospace",
        fontSize: "10px",
        color: "#8893a5",
      })
      .setOrigin(0.5);

    this.feedbackText = this.add
      .text(W / 2, H / 2 + PANEL_H / 2 - 16, "", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#ffffff",
      })
      .setOrigin(0.5);

    // Input
    this.spaceKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.escKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.input.on("pointerdown", this.onStrike, this);

    // Sweep indicator left↔right. Speed is in screen-widths/sec; convert to duration.
    const durationMs = Math.max(250, Math.floor(1000 / Math.max(0.1, mg.sweepSpeed)));
    this.sweepTween = this.tweens.add({
      targets: this.indicator,
      x: rightEdge,
      duration: durationMs,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.sweepTween?.stop();
      this.input.off("pointerdown", this.onStrike, this);
    });
  }

  update() {
    if (this.finished) return;
    if (this.spaceKey && Phaser.Input.Keyboard.JustDown(this.spaceKey)) this.onStrike();
    if (this.escKey && Phaser.Input.Keyboard.JustDown(this.escKey)) this.cancel();
  }

  private onStrike = () => {
    if (this.finished) return;
    const mg = this.recipe.minigame;
    if (!mg) return;
    if (this.movesUsed >= mg.moveBudget) return;

    const x = this.indicator.x;
    let kind: HitKind = "miss";
    if (x >= this.windowLeftX && x <= this.windowRightX) {
      const windowHalf = (this.windowRightX - this.windowLeftX) / 2;
      const norm = Math.abs(x - this.barCenterX) / Math.max(1, windowHalf);
      if (norm <= 0.3) kind = "perfect";
      else if (norm <= 0.7) kind = "great";
      else kind = "good";
    }

    if (kind === "perfect") this.perfects++;
    else if (kind === "great") this.greats++;
    else if (kind === "good") this.goods++;

    this.fill = Math.min(TARGET_FILL + 25, this.fill + FILL_PER_TIER[kind]);
    this.movesUsed++;

    this.refreshUI(kind);
    this.pulse(kind);

    if (this.fill >= TARGET_FILL) {
      this.finish(this.computeTier());
    } else if (this.movesUsed >= mg.moveBudget) {
      this.finish("fail");
    }
  };

  private cancel() {
    if (this.finished) return;
    this.finished = true;
    bus.emitTyped("crafting:cancel");
    this.scene.stop();
  }

  private computeTier(): CraftingOutcomeTier {
    const hits = this.perfects + this.greats + this.goods;
    if (hits === 0) return "fail";
    const perfectRatio = this.perfects / hits;
    const greatOrBetter = (this.perfects + this.greats) / hits;
    if (perfectRatio >= 0.8) return "perfect";
    if (greatOrBetter >= 0.66) return "great";
    if (greatOrBetter >= 0.33) return "good";
    return "normal";
  }

  private finish(tier: CraftingOutcomeTier) {
    if (this.finished) return;
    this.finished = true;
    this.sweepTween?.stop();

    const msg = tier === "fail" ? "RUINED" : tier.toUpperCase();
    const color =
      tier === "fail"
        ? "#e05050"
        : tier === "perfect"
          ? "#ffd866"
          : tier === "great"
            ? "#80e0a0"
            : "#c0ddff";
    this.feedbackText.setColor(color).setText(msg).setFontSize("20px");

    this.time.delayedCall(850, () => {
      bus.emitTyped("crafting:complete", {
        stationDefId: this.stationDef.id,
        recipeId: this.recipe.id,
        tier,
        movesUsed: this.movesUsed,
      });
      this.scene.stop();
    });
  }

  private budgetLabel(): string {
    const mg = this.recipe.minigame;
    if (!mg) return "";
    return `Strikes ${this.movesUsed}/${mg.moveBudget}   ·   Fill ${Math.min(
      100,
      Math.floor(this.fill),
    )}%`;
  }

  private refreshUI(hit: HitKind) {
    this.budgetText.setText(this.budgetLabel());
    this.completionBar.width = Math.max(
      0,
      Math.min(COMP_BAR_W, (this.fill / TARGET_FILL) * COMP_BAR_W),
    );
    const labels: Record<HitKind, [string, string]> = {
      perfect: ["PERFECT", "#ffd866"],
      great: ["GREAT", "#80e0a0"],
      good: ["GOOD", "#c0ddff"],
      miss: ["MISS", "#e05050"],
    };
    const [txt, col] = labels[hit];
    this.feedbackText.setColor(col).setText(txt).setFontSize("14px");
  }

  private pulse(hit: HitKind) {
    if (hit === "miss") return;
    const accent = Phaser.Display.Color.HexStringToColor(this.stationDef.accentColor).color;
    const flash = this.add
      .rectangle(this.barCenterX, this.barY, TIMING_BAR_W, 22, accent, 0.55)
      .setOrigin(0.5);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 180,
      onComplete: () => flash.destroy(),
    });
  }
}
