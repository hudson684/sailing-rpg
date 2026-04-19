import { lazy, useEffect } from "react";
import { useSettingsStore } from "../game/store/settingsStore";

const CharacterCustomizer = lazy(() =>
  import("./CharacterCustomizer").then((m) => ({ default: m.CharacterCustomizer })),
);

/** First-run wrapper around CharacterCustomizer (`mode="create"`). */
export function CharacterCreator() {
  const created = useSettingsStore((s) => s.characterCreated);
  // Warm the engine + scene chunks while the user fills in their character,
  // so the world is ready to boot the moment they commit.
  useEffect(() => {
    void import("phaser");
    void import("../game/config");
  }, []);
  // Once committed the parent App unmounts us; close handler is a no-op.
  return <CharacterCustomizer mode="create" open={!created} onClose={() => {}} />;
}
