import { useSettingsStore } from "../game/store/settingsStore";
import { CharacterCustomizer } from "./CharacterCustomizer";

/** First-run wrapper around CharacterCustomizer (`mode="create"`). */
export function CharacterCreator() {
  const created = useSettingsStore((s) => s.characterCreated);
  // Once committed the parent App unmounts us; close handler is a no-op.
  return <CharacterCustomizer mode="create" open={!created} onClose={() => {}} />;
}
