import * as Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { PreloadScene } from "./scenes/PreloadScene";
import { TitleScene } from "./scenes/TitleScene";
import { WorldScene } from "./scenes/WorldScene";
import { InteriorScene } from "./scenes/InteriorScene";
import { SystemsScene } from "./scenes/SystemsScene";
import { CraftingScene } from "./scenes/CraftingScene";
import { DevScheduleOverlayScene } from "./scenes/DevScheduleOverlayScene";
import { VIEWPORT_W, VIEWPORT_H } from "./constants";

export function createGameConfig(parent: HTMLElement): Phaser.Types.Core.GameConfig {
  const sceneList: Phaser.Types.Scenes.SceneType[] = [
    BootScene,
    PreloadScene,
    TitleScene,
    SystemsScene,
    WorldScene,
    InteriorScene,
    CraftingScene,
  ];
  // Phase 4: dev-only schedule overlay. The if-block + the static import
  // are statically analyzable; Vite terser DCEs both in production builds.
  if (import.meta.env.DEV) {
    sceneList.push(DevScheduleOverlayScene);
  }
  return {
    type: Phaser.AUTO,
    parent,
    backgroundColor: "#0a1a2f",
    pixelArt: true,
    physics: {
      default: "arcade",
      arcade: {
        gravity: { x: 0, y: 0 },
        debug: false,
      },
    },
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: VIEWPORT_W,
      height: VIEWPORT_H,
    },
    scene: sceneList,
  };
}
