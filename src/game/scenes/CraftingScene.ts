import * as Phaser from "phaser";
import { bus } from "../bus";
import type { CraftingOutcomeTier } from "../bus";
import { recipes } from "../crafting/recipes";
import { craftingStations } from "../crafting/stations";
import type {
  CraftingStationDef,
  MinigameActionKind,
  RecipeDef,
} from "../crafting/types";
import { ITEMS } from "../inventory/items";
import { useGameStore } from "../store/gameStore";

/**
 * Generic minigame overlay for crafting stations whose recipe has a `minigame`
 * config. Skill-agnostic: theming comes from the station def, difficulty from
 * the recipe, and per-action behavior is dispatched from the recipe's
 * `actions` sequence (strike / heat / quench). Any future crafting skill can
 * mix action kinds via JSON without touching this file.
 *
 * One action = one move. The sequence wraps when exhausted, so `moveBudget`
 * can exceed `actions.length`.
 *
 * Lifecycle:
 *   WorldScene.pause() → CraftingScene.launch({stationDefId, recipeId})
 *   → minigame runs, emits "crafting:complete" on success/fail OR
 *     "crafting:cancel" if player presses ESC
 *   → scene stops; WorldScene resumes and applies the result.
 */

const TARGET_FILL = 100;

const PANEL_W = 480;
const PANEL_H = 260;
const COMP_BAR_W = PANEL_W - 40;
const TIMING_BAR_W = PANEL_W - 40;

// Heat ring sizing (pixels).
const HEAT_R_MAX = 70;
const HEAT_R_MIN = 10;
const HEAT_HOLD_MS = 1500;

// Quench window (ms) and tap tiers.
const QUENCH_WINDOW_MS = 800;
const QUENCH_TAPS_PERFECT = 8;
const QUENCH_TAPS_GREAT = 6;
const QUENCH_TAPS_GOOD = 4;

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

  private fillPerTier: Record<HitKind, number> = {
    miss: 0,
    good: 12,
    great: 18,
    perfect: 25,
  };

  private panelCenterX = 0;
  private panelCenterY = 0;
  private accentColor = 0xffffff;

  // Persistent UI (survives across actions).
  private budgetText!: Phaser.GameObjects.Text;
  private completionBar!: Phaser.GameObjects.Rectangle;
  private feedbackText!: Phaser.GameObjects.Text;
  private promptText!: Phaser.GameObjects.Text;

  // Current-action state — torn down and rebuilt per action.
  private currentKind: MinigameActionKind = "strike";
  private actionObjects: Phaser.GameObjects.GameObject[] = [];
  private actionTween?: Phaser.Tweens.Tween;
  private actionTimer?: Phaser.Time.TimerEvent;

  // Strike-specific.
  private strikeIndicator?: Phaser.GameObjects.Rectangle;
  private strikeBarCenterX = 0;
  private strikeWindowLeftX = 0;
  private strikeWindowRightX = 0;

  // Heat-specific.
  private heatRing?: Phaser.GameObjects.Arc;
  private heatTargetRadius = 0;
  private heatWindowPx = 0;
  private heatHolding = false;

  // Quench-specific.
  private quenchStarted = false;
  private quenchTapCount = 0;
  private quenchStartTime = 0;
  private quenchProgressBar?: Phaser.GameObjects.Rectangle;
  private quenchTapText?: Phaser.GameObjects.Text;

  private spaceKey?: Phaser.Input.Keyboard.Key;
  private escKey?: Phaser.Input.Keyboard.Key;

  constructor() {
    super({ key: "Crafting" });
  }

  init(data: CraftingSceneInit) {
    const recipe = recipes.tryGet(data.recipeId);
    const station = craftingStations.tryGet(data.stationDefId);
    if (!recipe || !station || !recipe.minigame) {
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
    this.actionObjects = [];
    this.heatHolding = false;
    this.quenchStarted = false;
    this.quenchTapCount = 0;
  }

  create() {
    if (!this.recipe || !this.stationDef) return;
    const mg = this.recipe.minigame;
    if (!mg) return;

    // Bake the equipped mainHand's craftFillBonus into the per-hit fill table.
    // Read once — snapshot for this craft. Swapping weapons mid-craft shouldn't
    // affect the in-progress minigame.
    const mainHand = useGameStore.getState().equipment.equipped.mainHand;
    const bonus = mainHand ? (ITEMS[mainHand].stats?.craftFillBonus ?? 0) : 0;
    const mult = 1 + bonus;
    this.fillPerTier = {
      miss: 0,
      good: 12 * mult,
      great: 18 * mult,
      perfect: 25 * mult,
    };

    const cam = this.cameras.main;
    const W = cam.width;
    const H = cam.height;
    this.panelCenterX = W / 2;
    this.panelCenterY = H / 2;

    this.scene.bringToTop();

    // Dim backdrop
    this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.55);

    // Panel
    const accentHex = this.stationDef.accentColor;
    this.accentColor = Phaser.Display.Color.HexStringToColor(accentHex).color;
    const bgHex = this.stationDef.bgColor;
    const bgCol = Phaser.Display.Color.HexStringToColor(bgHex).color;
    const panel = this.add.rectangle(W / 2, H / 2, PANEL_W, PANEL_H, 0x1a1a22, 0.96);
    panel.setStrokeStyle(3, this.accentColor);
    this.add
      .rectangle(W / 2, H / 2 - PANEL_H / 2 + 5, PANEL_W - 12, 4, bgCol, 0.85)
      .setOrigin(0.5);

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

    // Prompt (above the action area) and feedback text (bottom of panel).
    this.promptText = this.add
      .text(W / 2, H / 2 - 8, "", {
        fontFamily: "monospace",
        fontSize: "12px",
        color: "#8893a5",
      })
      .setOrigin(0.5);

    this.add
      .text(W / 2, H / 2 + PANEL_H / 2 - 36, "SPACE / click   ·   ESC: cancel", {
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
    this.input.on("pointerdown", this.onPointerDown, this);
    this.input.on("pointerup", this.onPointerUp, this);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.teardownAction();
      this.input.off("pointerdown", this.onPointerDown, this);
      this.input.off("pointerup", this.onPointerUp, this);
    });

    this.startNextAction();
  }

  update() {
    if (this.finished) return;
    if (this.escKey && Phaser.Input.Keyboard.JustDown(this.escKey)) {
      this.cancel();
      return;
    }
    if (this.spaceKey) {
      if (Phaser.Input.Keyboard.JustDown(this.spaceKey)) this.onInputDown();
      if (Phaser.Input.Keyboard.JustUp(this.spaceKey)) this.onInputUp();
    }
    if (this.currentKind === "quench" && this.quenchStarted && this.quenchProgressBar) {
      const elapsed = this.time.now - this.quenchStartTime;
      const remaining = Math.max(0, 1 - elapsed / QUENCH_WINDOW_MS);
      this.quenchProgressBar.width = COMP_BAR_W * remaining;
    }
  }

  private onPointerDown = () => {
    if (this.finished) return;
    this.onInputDown();
  };

  private onPointerUp = () => {
    if (this.finished) return;
    this.onInputUp();
  };

  // --- central input dispatch ---

  private onInputDown() {
    switch (this.currentKind) {
      case "strike":
        this.resolveStrike();
        break;
      case "heat":
        this.onHeatDown();
        break;
      case "quench":
        this.onQuenchTap();
        break;
    }
  }

  private onInputUp() {
    if (this.currentKind === "heat") this.onHeatUp();
  }

  // --- action lifecycle ---

  private startNextAction() {
    const mg = this.recipe.minigame;
    if (!mg) return;
    const kind = mg.actions[this.movesUsed % mg.actions.length] ?? "strike";
    this.currentKind = kind;
    this.teardownAction();
    switch (kind) {
      case "strike":
        this.startStrike();
        break;
      case "heat":
        this.startHeat();
        break;
      case "quench":
        this.startQuench();
        break;
    }
  }

  private teardownAction() {
    this.actionTween?.stop();
    this.actionTween = undefined;
    this.actionTimer?.remove(false);
    this.actionTimer = undefined;
    for (const obj of this.actionObjects) obj.destroy();
    this.actionObjects = [];
    this.strikeIndicator = undefined;
    this.heatRing = undefined;
    this.quenchProgressBar = undefined;
    this.quenchTapText = undefined;
    this.heatHolding = false;
    this.quenchStarted = false;
    this.quenchTapCount = 0;
  }

  private resolveAction(kind: HitKind) {
    if (this.finished) return;
    const mg = this.recipe.minigame;
    if (!mg) return;

    if (kind === "perfect") this.perfects++;
    else if (kind === "great") this.greats++;
    else if (kind === "good") this.goods++;

    this.fill = Math.min(TARGET_FILL + 25, this.fill + this.fillPerTier[kind]);
    this.movesUsed++;

    this.refreshUI(kind);
    this.pulse(kind);

    if (this.fill >= TARGET_FILL) {
      this.finish(this.computeTier());
      return;
    }
    if (this.movesUsed >= mg.moveBudget) {
      this.finish("fail");
      return;
    }
    // Short breather between actions so the feedback is readable.
    this.time.delayedCall(180, () => {
      if (!this.finished) this.startNextAction();
    });
  }

  // --- STRIKE ---

  private startStrike() {
    const mg = this.recipe.minigame;
    if (!mg) return;
    this.promptText.setText("SPACE — strike on target");

    const barY = this.panelCenterY + 20;
    this.strikeBarCenterX = this.panelCenterX;

    const bg = this.add
      .rectangle(this.panelCenterX, barY, TIMING_BAR_W, 22, 0x2a2e38)
      .setOrigin(0.5);
    this.actionObjects.push(bg);

    const windowW = TIMING_BAR_W * mg.windowSize;
    this.strikeWindowLeftX = this.panelCenterX - windowW / 2;
    this.strikeWindowRightX = this.panelCenterX + windowW / 2;
    const windowBand = this.add
      .rectangle(this.panelCenterX, barY, windowW, 22, this.accentColor, 0.35)
      .setOrigin(0.5);
    const perfectBand = this.add
      .rectangle(this.panelCenterX, barY, windowW * 0.3, 22, this.accentColor, 0.7)
      .setOrigin(0.5);
    this.actionObjects.push(windowBand, perfectBand);

    const leftEdge = this.panelCenterX - TIMING_BAR_W / 2;
    const rightEdge = this.panelCenterX + TIMING_BAR_W / 2;
    this.strikeIndicator = this.add
      .rectangle(leftEdge, barY, 4, 30, 0xffffff)
      .setOrigin(0.5);
    this.actionObjects.push(this.strikeIndicator);

    const durationMs = Math.max(250, Math.floor(1000 / Math.max(0.1, mg.sweepSpeed)));
    this.actionTween = this.tweens.add({
      targets: this.strikeIndicator,
      x: rightEdge,
      duration: durationMs,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  private resolveStrike() {
    if (!this.strikeIndicator) return;
    const x = this.strikeIndicator.x;
    let kind: HitKind = "miss";
    if (x >= this.strikeWindowLeftX && x <= this.strikeWindowRightX) {
      const windowHalf = (this.strikeWindowRightX - this.strikeWindowLeftX) / 2;
      const norm = Math.abs(x - this.strikeBarCenterX) / Math.max(1, windowHalf);
      if (norm <= 0.3) kind = "perfect";
      else if (norm <= 0.7) kind = "great";
      else kind = "good";
    }
    this.resolveAction(kind);
  }

  // --- HEAT ---

  private startHeat() {
    const mg = this.recipe.minigame;
    if (!mg) return;
    this.promptText.setText("HOLD SPACE — release when the ring peaks");

    // Target radius is the midpoint of the max→min sweep. The player must
    // release when the ring crosses that band; the window is sized off the
    // recipe's windowSize so harder recipes = tighter band.
    this.heatTargetRadius = (HEAT_R_MAX + HEAT_R_MIN) / 2;
    const totalRange = HEAT_R_MAX - HEAT_R_MIN;
    this.heatWindowPx = Math.max(6, totalRange * mg.windowSize);

    const targetRing = this.add
      .circle(this.panelCenterX, this.panelCenterY + 30, this.heatTargetRadius)
      .setStrokeStyle(2, this.accentColor, 0.5)
      .setFillStyle(0, 0);
    const targetBand = this.add
      .circle(
        this.panelCenterX,
        this.panelCenterY + 30,
        this.heatTargetRadius + this.heatWindowPx,
      )
      .setStrokeStyle(1, this.accentColor, 0.25)
      .setFillStyle(0, 0);
    this.actionObjects.push(targetRing, targetBand);

    this.heatRing = this.add
      .circle(this.panelCenterX, this.panelCenterY + 30, HEAT_R_MAX)
      .setStrokeStyle(3, 0xffffff, 0.9)
      .setFillStyle(0, 0);
    this.actionObjects.push(this.heatRing);
  }

  private onHeatDown() {
    if (this.heatHolding || !this.heatRing) return;
    this.heatHolding = true;

    const ringProxy = { r: HEAT_R_MAX };
    this.actionTween = this.tweens.add({
      targets: ringProxy,
      r: HEAT_R_MIN,
      duration: HEAT_HOLD_MS,
      ease: "Linear",
      onUpdate: () => {
        this.heatRing?.setRadius(ringProxy.r);
      },
      onComplete: () => {
        if (this.heatHolding && !this.finished) {
          // Held past end = miss.
          this.heatHolding = false;
          this.resolveAction("miss");
        }
      },
    });
  }

  private onHeatUp() {
    if (!this.heatHolding) return;
    this.heatHolding = false;
    const r = this.heatRing?.radius ?? HEAT_R_MAX;
    const dist = Math.abs(r - this.heatTargetRadius);
    let kind: HitKind = "miss";
    if (dist <= this.heatWindowPx) {
      const norm = dist / this.heatWindowPx;
      if (norm <= 0.3) kind = "perfect";
      else if (norm <= 0.7) kind = "great";
      else kind = "good";
    }
    this.resolveAction(kind);
  }

  // --- QUENCH ---

  private startQuench() {
    this.promptText.setText("TAP SPACE — fast!");

    const barY = this.panelCenterY + 20;
    const bg = this.add
      .rectangle(this.panelCenterX, barY, COMP_BAR_W, 8, 0x2a2e38)
      .setOrigin(0.5);
    this.quenchProgressBar = this.add
      .rectangle(this.panelCenterX - COMP_BAR_W / 2, barY, 0, 8, this.accentColor)
      .setOrigin(0, 0.5);
    this.quenchTapText = this.add
      .text(this.panelCenterX, barY + 24, "Taps: 0", {
        fontFamily: "monospace",
        fontSize: "12px",
        color: "#c8ccd8",
      })
      .setOrigin(0.5);
    this.actionObjects.push(bg, this.quenchProgressBar, this.quenchTapText);
  }

  private onQuenchTap() {
    if (!this.quenchStarted) {
      this.quenchStarted = true;
      this.quenchTapCount = 1;
      this.quenchStartTime = this.time.now;
      if (this.quenchProgressBar) this.quenchProgressBar.width = COMP_BAR_W;
      this.actionTimer = this.time.delayedCall(QUENCH_WINDOW_MS, () => {
        this.resolveQuench();
      });
    } else {
      this.quenchTapCount++;
    }
    this.quenchTapText?.setText(`Taps: ${this.quenchTapCount}`);
  }

  private resolveQuench() {
    const taps = this.quenchTapCount;
    let kind: HitKind = "miss";
    if (taps >= QUENCH_TAPS_PERFECT) kind = "perfect";
    else if (taps >= QUENCH_TAPS_GREAT) kind = "great";
    else if (taps >= QUENCH_TAPS_GOOD) kind = "good";
    this.resolveAction(kind);
  }

  // --- shared ---

  private cancel() {
    if (this.finished) return;
    this.finished = true;
    this.teardownAction();
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
    this.teardownAction();

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
    this.promptText.setText("");

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
    return `Moves ${this.movesUsed}/${mg.moveBudget}   ·   Fill ${Math.min(
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
    const flash = this.add
      .rectangle(this.panelCenterX, this.panelCenterY + 20, TIMING_BAR_W, 22, this.accentColor, 0.55)
      .setOrigin(0.5);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 180,
      onComplete: () => flash.destroy(),
    });
  }
}
