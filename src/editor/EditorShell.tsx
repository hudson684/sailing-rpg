import { useState, type ReactNode } from "react";
import { listEditorTools } from "./tools/registry";

export interface EditorShellProps {
  /** Optional slot rendered into the right-hand inspector pane. */
  inspector?: ReactNode;
}

export function EditorShell({ inspector }: EditorShellProps) {
  const tools = listEditorTools();
  const [activeId, setActiveId] = useState<string | null>(tools[0]?.id ?? null);
  const active = tools.find((t) => t.id === activeId) ?? null;
  const ActiveComponent = active?.component;
  const showInspector = inspector !== undefined;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: showInspector ? "200px 1fr 320px" : "200px 1fr",
        gridTemplateRows: "40px 1fr",
        gridTemplateAreas: showInspector
          ? `"header header header" "sidebar main inspector"`
          : `"header header" "sidebar main"`,
        height: "100vh",
        width: "100vw",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        color: "#e6e6e6",
        background: "#141418",
      }}
    >
      <header
        style={{
          gridArea: "header",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          background: "#1f1f25",
          borderBottom: "1px solid #2a2a32",
          fontWeight: 600,
        }}
      >
        Sailing RPG — Editor
      </header>

      <nav
        style={{
          gridArea: "sidebar",
          background: "#1a1a1f",
          borderRight: "1px solid #2a2a32",
          padding: 8,
          overflow: "auto",
        }}
      >
        {tools.length === 0 ? (
          <div style={{ color: "#888", padding: 8 }}>No tools registered yet.</div>
        ) : (
          tools.map((tool) => (
            <button
              key={tool.id}
              onClick={() => setActiveId(tool.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 10px",
                marginBottom: 2,
                background: tool.id === activeId ? "#2b4d7a" : "transparent",
                color: "inherit",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                font: "inherit",
              }}
            >
              {tool.label}
            </button>
          ))
        )}
      </nav>

      <main
        style={{
          gridArea: "main",
          overflow: "auto",
          padding: 16,
        }}
      >
        {ActiveComponent ? (
          <ActiveComponent />
        ) : (
          <div style={{ color: "#888" }}>
            Editor shell ready. Tools will be registered in Phases 3–6.
          </div>
        )}
      </main>

      {showInspector && (
        <aside
          style={{
            gridArea: "inspector",
            background: "#1a1a1f",
            borderLeft: "1px solid #2a2a32",
            padding: 12,
            overflow: "auto",
          }}
        >
          {inspector}
        </aside>
      )}
    </div>
  );
}
