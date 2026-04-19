import { useEffect, useRef, useState } from "react";
import * as Phaser from "phaser";
import { createGameConfig } from "./game/config";
import { Hud } from "./ui/Hud";
import { InventoryPremade } from "./ui/InventoryPremade";
import { Jobs } from "./ui/Jobs";
import { PauseMenu } from "./ui/PauseMenu";
import { Dialogue } from "./ui/Dialogue";
import { Shop } from "./ui/Shop";
import { CharacterCreator } from "./ui/CharacterCreator";
import { CharacterCustomizer } from "./ui/CharacterCustomizer";
import { EditMode } from "./ui/EditMode";
import { NodeDefEditor } from "./ui/NodeDefEditor";
import { useSettingsStore } from "./game/store/settingsStore";
import { TouchControls } from "./ui/mobile/TouchControls";
import { OrientationPrompt } from "./ui/mobile/OrientationPrompt";
import { useIsMobile, useIsPortrait } from "./ui/mobile/useMobile";
import "./ui/pixel-ui.css";
import "./App.css";

export default function App() {
  const parentRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const characterCreated = useSettingsStore((s) => s.characterCreated);
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const isMobile = useIsMobile();
  const isPortrait = useIsPortrait();

  useEffect(() => {
    if (!characterCreated) return;
    if (!parentRef.current || gameRef.current) return;
    gameRef.current = new Phaser.Game(createGameConfig(parentRef.current));
    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, [characterCreated]);

  // Hotkey C + custom event from PauseMenu open the customizer.
  useEffect(() => {
    if (!characterCreated) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "c") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      setCustomizerOpen((v) => !v);
    };
    const onOpen = () => setCustomizerOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("character:open", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("character:open", onOpen);
    };
  }, [characterCreated]);

  return (
    <div className="app-root">
      <div ref={parentRef} className="game-canvas" />
      {characterCreated ? (
        <>
          <Hud />
          <InventoryPremade />
          <Jobs />
          <PauseMenu />
          <Dialogue />
          <Shop />
          <CharacterCustomizer
            mode="edit"
            open={customizerOpen}
            onClose={() => setCustomizerOpen(false)}
          />
          {import.meta.env.DEV && <EditMode />}
          {import.meta.env.DEV && <NodeDefEditor />}
          <TouchControls visible={isMobile && !isPortrait} />
        </>
      ) : (
        <CharacterCreator />
      )}
      <OrientationPrompt visible={isMobile && isPortrait} />
    </div>
  );
}
