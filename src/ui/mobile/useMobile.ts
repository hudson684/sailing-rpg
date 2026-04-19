import { useEffect, useState } from "react";
import { useSettingsStore } from "../../game/store/settingsStore";

function subscribeMedia(query: string, setter: (v: boolean) => void): () => void {
  const mql = window.matchMedia(query);
  const handler = (e: MediaQueryListEvent | MediaQueryList) => setter(e.matches);
  handler(mql);
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}

/** True when on-screen touch controls should be shown. */
export function useIsMobile(): boolean {
  const mode = useSettingsStore((s) => s.mobileMode);
  const [auto, setAuto] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(pointer: coarse)").matches,
  );

  useEffect(() => subscribeMedia("(pointer: coarse)", setAuto), []);

  if (mode === "on") return true;
  if (mode === "off") return false;
  return auto;
}

/** True when the viewport is in portrait orientation. */
export function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(orientation: portrait)").matches,
  );

  useEffect(() => subscribeMedia("(orientation: portrait)", setPortrait), []);

  return portrait;
}
