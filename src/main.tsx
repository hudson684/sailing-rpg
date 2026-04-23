import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

// Dev-only /editor route. Guarded by import.meta.env.DEV so prod bundles
// never pull in the editor chunk — confirm with `npx vite build` that
// "EditorShell" does not appear in dist/.
const EditorRoot =
  import.meta.env.DEV
    ? lazy(() => import("./editor"))
    : null;

function Root() {
  if (EditorRoot && window.location.pathname.replace(/\/+$/, "") === "/editor") {
    return (
      <Suspense fallback={null}>
        <EditorRoot />
      </Suspense>
    );
  }
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
