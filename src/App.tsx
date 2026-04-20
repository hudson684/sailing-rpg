import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type * as Phaser from "phaser";
import { Hud } from "./ui/Hud";
import { CharacterCreator } from "./ui/CharacterCreator";
import { useSettingsStore } from "./game/store/settingsStore";
import { useUIStore } from "./ui/store/uiStore";
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
  // Title screen lives inside Phaser; while it's up, React must not render
  // HUD/touch-control overlays on top of the canvas — they'd mislead the
  // player (fake stats) and eat taps meant to dismiss the title.
  const titleDismissed = useUIStore((s) => s.titleDismissed);
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [phaserBooting, setPhaserBooting] = useState(false);
  const isMobile = useIsMobile();
  const isPortrait = useIsPortrait();

  useEffect(() => {
    if (!characterCreated) return;
    if (!parentRef.current || gameRef.current) return;
    let cancelled = false;
    setPhaserBooting(true);
    void Promise.all([import("phaser"), import("./game/config")]).then(
      ([PhaserMod, { createGameConfig }]) => {
        if (cancelled || !parentRef.current || gameRef.current) return;
        gameRef.current = new PhaserMod.Game(createGameConfig(parentRef.current));
        setPhaserBooting(false);
      },
    );
    return () => {
      cancelled = true;
      gameRef.current?.destroy(true);
      gameRef.current = null;
      setPhaserBooting(false);
    };
  }, [characterCreated]);

  // Hotkey C + custom event from PauseMenu open the customizer.
  useEffect(() => {
    if (!characterCreated || !titleDismissed) return;
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
  }, [characterCreated, titleDismissed]);

  return (
    <div className="app-root">
      <div ref={parentRef} className="game-canvas" />
      {phaserBooting && (
        <div className="boot-spinner" aria-label="Loading game">
          <div className="boot-spinner__ring" />
          <div>Loading game…</div>
        </div>
      )}
      <Suspense fallback={null}>
        {!characterCreated ? (
          <CharacterCreator />
        ) : titleDismissed ? (
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
        ) : null}
      </Suspense>
      <OrientationPrompt visible={isMobile && isPortrait} />
    </div>
  );
}
