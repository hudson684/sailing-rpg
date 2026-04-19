import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type * as Phaser from "phaser";
import { Hud } from "./ui/Hud";
import { CharacterCreator } from "./ui/CharacterCreator";
import { useSettingsStore } from "./game/store/settingsStore";
import { TouchControls } from "./ui/mobile/TouchControls";
import { OrientationPrompt } from "./ui/mobile/OrientationPrompt";
import { useIsMobile, useIsPortrait } from "./ui/mobile/useMobile";
import "./ui/pixel-ui.css";
import "./App.css";

const InventoryPremade = lazy(() =>
  import("./ui/InventoryPremade").then((m) => ({ default: m.InventoryPremade })),
);
const Jobs = lazy(() => import("./ui/Jobs").then((m) => ({ default: m.Jobs })));
const PauseMenu = lazy(() => import("./ui/PauseMenu").then((m) => ({ default: m.PauseMenu })));
const Dialogue = lazy(() => import("./ui/Dialogue").then((m) => ({ default: m.Dialogue })));
const Shop = lazy(() => import("./ui/Shop").then((m) => ({ default: m.Shop })));
const CharacterCustomizer = lazy(() =>
  import("./ui/CharacterCustomizer").then((m) => ({ default: m.CharacterCustomizer })),
);
const EditMode = lazy(() => import("./ui/EditMode").then((m) => ({ default: m.EditMode })));
const NodeDefEditor = lazy(() =>
  import("./ui/NodeDefEditor").then((m) => ({ default: m.NodeDefEditor })),
);

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
    let cancelled = false;
    void Promise.all([import("phaser"), import("./game/config")]).then(
      ([PhaserMod, { createGameConfig }]) => {
        if (cancelled || !parentRef.current || gameRef.current) return;
        gameRef.current = new PhaserMod.Game(createGameConfig(parentRef.current));
      },
    );
    return () => {
      cancelled = true;
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
      <Suspense fallback={null}>
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
      </Suspense>
      <OrientationPrompt visible={isMobile && isPortrait} />
    </div>
  );
}
