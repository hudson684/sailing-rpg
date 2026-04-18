import { useEffect, useRef } from "react";
import * as Phaser from "phaser";
import { createGameConfig } from "./game/config";
import { Hud } from "./ui/Hud";
import { Inventory } from "./ui/Inventory";
import { Equipment } from "./ui/Equipment";
import { Jobs } from "./ui/Jobs";
import { PauseMenu } from "./ui/PauseMenu";
import { Dialogue } from "./ui/Dialogue";
import "./App.css";

export default function App() {
  const parentRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!parentRef.current || gameRef.current) return;
    gameRef.current = new Phaser.Game(createGameConfig(parentRef.current));
    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return (
    <div className="app-root">
      <div ref={parentRef} className="game-canvas" />
      <Hud />
      <Inventory />
      <Equipment />
      <Jobs />
      <PauseMenu />
      <Dialogue />
    </div>
  );
}
