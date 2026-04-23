import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DialogueChoice,
  DialogueNode,
  DialogueTree,
} from "../../game/dialogue/types";
import type { Predicate, Reward } from "../../game/quests/types";
import { useJsonFile } from "../useJsonFile";
import { GraphView, type GraphEdge, type GraphNode } from "../widgets/GraphView";
import { PredicateBuilder } from "../widgets/PredicateBuilder";
import { RewardListBuilder } from "../widgets/RewardBuilder";
import { useSuggestions } from "../widgets/useSuggestions";

interface DialogueFile {
  trees: DialogueTree[];
}

interface NodeLayout {
  x: number;
  y: number;
}

// Position stored under `editor.layout` on each node — passes through
// save/load so graphs keep their layout.
type DialogueNodeWithLayout = DialogueNode & { editor?: { layout?: NodeLayout } };
type DialogueTreeWithLayout = Omit<DialogueTree, "nodes"> & {
  nodes: Record<string, DialogueNodeWithLayout>;
};

export function DialogueEditor() {
  const suggestions = useSuggestions();
  const file = useJsonFile<DialogueFile>("src/game/data/dialogue.json");
  const [draft, setDraft] = useState<DialogueTreeWithLayout[] | null>(null);
  const [selectedTree, setSelectedTree] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  useEffect(() => {
    if (!draft && file.data) {
      setDraft((file.data.trees as DialogueTreeWithLayout[]) ?? []);
      if (!selectedTree && file.data.trees.length > 0) setSelectedTree(file.data.trees[0].id);
    }
  }, [file.data, draft, selectedTree]);

  const tree = useMemo(
    () => draft?.find((t) => t.id === selectedTree) ?? null,
    [draft, selectedTree],
  );

  const update = (next: DialogueTreeWithLayout[]) => setDraft(next);
  const updateTree = useCallback(
    (patch: Partial<DialogueTreeWithLayout>) => {
      if (!draft || !tree) return;
      update(draft.map((t) => (t.id === tree.id ? { ...t, ...patch } : t)));
    },
    [draft, tree],
  );
  const updateNode = useCallback(
    (nodeId: string, patch: Partial<DialogueNodeWithLayout>) => {
      if (!tree) return;
      updateTree({ nodes: { ...tree.nodes, [nodeId]: { ...tree.nodes[nodeId], ...patch } } });
    },
    [tree, updateTree],
  );

  const addTree = () => {
    if (!draft) return;
    const id = `tree_${draft.length + 1}`;
    const t: DialogueTreeWithLayout = {
      id,
      entry: "n1",
      nodes: { n1: { id: "n1", speaker: "NPC", pages: ["…"], editor: { layout: { x: 50, y: 50 } } } },
    };
    update([...draft, t]);
    setSelectedTree(id);
    setSelectedNode("n1");
  };

  const deleteTree = () => {
    if (!draft || !tree) return;
    if (!window.confirm(`Delete tree ${tree.id}?`)) return;
    update(draft.filter((t) => t.id !== tree.id));
    setSelectedTree(draft[0]?.id ?? null);
  };

  const addNode = (kind: "say" | "end" = "say") => {
    if (!tree) return;
    const ids = Object.keys(tree.nodes);
    let i = ids.length + 1;
    while (ids.includes(`n${i}`)) i++;
    const id = `n${i}`;
    const node: DialogueNodeWithLayout =
      kind === "end"
        ? { id, speaker: "", pages: [], auto: null, editor: { layout: { x: 100 + i * 60, y: 200 } } }
        : { id, speaker: "NPC", pages: [""], editor: { layout: { x: 100 + i * 60, y: 100 } } };
    updateTree({ nodes: { ...tree.nodes, [id]: node } });
    setSelectedNode(id);
  };

  const deleteNode = (nodeId: string) => {
    if (!tree) return;
    if (tree.entry === nodeId) {
      window.alert("Can't delete the entry node.");
      return;
    }
    const next = { ...tree.nodes };
    delete next[nodeId];
    // Strip dangling gotos.
    for (const n of Object.values(next)) {
      if (n.auto === nodeId) n.auto = null;
      if (n.choices) n.choices = n.choices.map((c) => (c.goto === nodeId ? { ...c, goto: null } : c));
    }
    updateTree({ nodes: next });
    if (selectedNode === nodeId) setSelectedNode(null);
  };

  // Graph layout.
  const graphNodes: Array<GraphNode & { node: DialogueNodeWithLayout; isEntry: boolean }> = useMemo(() => {
    if (!tree) return [];
    return Object.values(tree.nodes).map((n) => ({
      id: n.id,
      x: n.editor?.layout?.x ?? 100,
      y: n.editor?.layout?.y ?? 100,
      width: 200,
      height: (n.choices?.length ?? 0) > 0 ? 110 : 80,
      node: n,
      isEntry: n.id === tree.entry,
    }));
  }, [tree]);

  const graphEdges: GraphEdge[] = useMemo(() => {
    if (!tree) return [];
    const edges: GraphEdge[] = [];
    for (const n of Object.values(tree.nodes)) {
      if (n.auto && tree.nodes[n.auto]) {
        edges.push({ id: `${n.id}->auto->${n.auto}`, from: n.id, to: n.auto, label: "auto" });
      }
      for (const c of n.choices ?? []) {
        if (c.goto && tree.nodes[c.goto]) {
          edges.push({
            id: `${n.id}->${c.label}->${c.goto}`,
            from: n.id,
            to: c.goto,
            label: c.label || "(choice)",
            color: "#e0b060",
          });
        }
      }
    }
    return edges;
  }, [tree]);

  const onNodeMove = useCallback(
    (nodeId: string, x: number, y: number) => {
      if (!tree) return;
      const n = tree.nodes[nodeId];
      if (!n) return;
      updateNode(nodeId, { editor: { ...(n.editor ?? {}), layout: { x, y } } });
    },
    [tree, updateNode],
  );

  const dirty = useMemo(() => {
    if (!draft || !file.data) return false;
    return JSON.stringify({ trees: draft }) !== JSON.stringify(file.data);
  }, [draft, file.data]);

  const onSave = async () => {
    if (!draft) return;
    await file.save({ trees: draft });
  };

  const onPlay = () => {
    if (!selectedTree) return;
    const url = new URL(window.location.origin + "/");
    url.searchParams.set("playDialogue", selectedTree);
    if (selectedNode) url.searchParams.set("node", selectedNode);
    window.open(url.toString(), "_blank");
  };

  const selNode = selectedNode && tree?.nodes[selectedNode];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label style={{ fontWeight: 600 }}>Tree:</label>
        <select value={selectedTree ?? ""} onChange={(e) => { setSelectedTree(e.target.value); setSelectedNode(null); }} style={sel}>
          {(draft ?? []).map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
        </select>
        <button onClick={addTree} style={btn("ghost")}>+ Tree</button>
        <button onClick={deleteTree} disabled={!tree} style={btn("danger")}>Delete tree</button>
        <div style={{ flex: 1 }} />
        <button onClick={onPlay} disabled={!selectedTree} style={btn("ghost")}>Play from here ▶</button>
        <button onClick={onSave} disabled={!dirty || file.saving} style={btn(dirty && !file.saving ? "primary" : "ghost")}>
          {file.saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, border: "1px solid #222", minHeight: 400, position: "relative" }}>
          {tree && (
            <GraphView
              nodes={graphNodes}
              edges={graphEdges}
              selectedId={selectedNode}
              onSelect={setSelectedNode}
              onNodeMove={onNodeMove}
              renderNode={(gn, selected) => (
                <DialogueNodeBox
                  node={gn.node}
                  isEntry={gn.isEntry}
                  selected={selected}
                  onMakeEntry={() => updateTree({ entry: gn.id })}
                />
              )}
            />
          )}
          <div style={{ position: "absolute", top: 6, left: 6, display: "flex", gap: 4 }}>
            <button onClick={() => addNode("say")} style={btn("ghost")}>+ Say node</button>
            <button onClick={() => addNode("end")} style={btn("ghost")}>+ End node</button>
          </div>
        </div>

        <aside style={{ width: 380, padding: 10, background: "#12121a", border: "1px solid #222", overflow: "auto" }}>
          {!tree && <div style={{ color: "#888" }}>No tree loaded.</div>}
          {tree && !selNode && <div style={{ color: "#888" }}>Click a node to inspect.</div>}
          {tree && selNode && (
            <NodeInspector
              tree={tree}
              node={selNode}
              onPatch={(p) => updateNode(selNode.id, p)}
              onDelete={() => deleteNode(selNode.id)}
              suggestions={suggestions}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// --- Graph node visual -------------------------------------------

function DialogueNodeBox({
  node,
  isEntry,
  selected,
  onMakeEntry,
}: {
  node: DialogueNodeWithLayout;
  isEntry: boolean;
  selected: boolean;
  onMakeEntry: () => void;
}) {
  const hasChoices = (node.choices?.length ?? 0) > 0;
  const kind = hasChoices ? "Choice" : node.pages.length === 0 ? "End" : "Say";
  const color = kind === "Choice" ? "#e0b060" : kind === "End" ? "#8888aa" : "#4a7fb0";
  return (
    <div
      style={{
        background: "#161620",
        border: `2px solid ${selected ? "#ffdd44" : color}`,
        borderRadius: 4,
        padding: 6,
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ color }}>{kind}</strong>
        <div style={{ fontSize: 10, color: "#888" }}>{node.id}</div>
      </div>
      {!isEntry && (
        <button onMouseDown={(e) => e.stopPropagation()} onClick={onMakeEntry} style={{ ...btn("ghost"), fontSize: 10, padding: "1px 4px", marginTop: 2 }}>
          Set as entry
        </button>
      )}
      {isEntry && <div style={{ fontSize: 10, color: "#8f8" }}>ENTRY</div>}
      <div style={{ color: "#aaa", marginTop: 4 }}>{node.speaker || "(no speaker)"}</div>
      {node.pages.length > 0 && (
        <div style={{ color: "#ddd", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {node.pages[0]?.slice(0, 40) || "—"}
        </div>
      )}
      {hasChoices && (
        <div style={{ marginTop: 4, color: "#ddd" }}>
          {(node.choices ?? []).slice(0, 3).map((c, i) => <div key={i}>→ {c.label || "(empty)"}</div>)}
        </div>
      )}
    </div>
  );
}

// --- Node inspector ----------------------------------------------

function NodeInspector({
  tree,
  node,
  onPatch,
  onDelete,
  suggestions,
}: {
  tree: DialogueTreeWithLayout;
  node: DialogueNodeWithLayout;
  onPatch: (patch: Partial<DialogueNodeWithLayout>) => void;
  onDelete: () => void;
  suggestions: ReturnType<typeof useSuggestions>;
}) {
  const targets = ["", ...Object.keys(tree.nodes)];
  const hasChoices = (node.choices?.length ?? 0) > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h3 style={{ margin: 0 }}>Node: {node.id}</h3>
      <LabeledInput label="id" value={node.id} onChange={(v) => onPatch({ id: v })} />
      <LabeledInput label="speaker" value={node.speaker} onChange={(v) => onPatch({ speaker: v })} />
      <LabeledInput label="portrait (optional)" value={node.portrait ?? ""} onChange={(v) => onPatch({ portrait: v || undefined })} />

      <div>
        <div style={{ fontSize: 11, color: "#888" }}>pages</div>
        {node.pages.map((p, i) => (
          <div key={i} style={{ display: "flex", gap: 4, marginTop: 2 }}>
            <textarea
              value={p}
              onChange={(e) => {
                const next = node.pages.slice();
                next[i] = e.target.value;
                onPatch({ pages: next });
              }}
              rows={2}
              style={{ ...inp, flex: 1, resize: "vertical" }}
            />
            <button onClick={() => onPatch({ pages: node.pages.filter((_, j) => j !== i) })} style={delBtn}>×</button>
          </div>
        ))}
        <button onClick={() => onPatch({ pages: [...node.pages, ""] })} style={addBtn}>+ page</button>
      </div>

      <div>
        <div style={{ fontSize: 11, color: "#888" }}>
          choices (if any; otherwise uses `auto` below)
        </div>
        {(node.choices ?? []).map((c, i) => (
          <ChoiceEditor
            key={i}
            value={c}
            targets={targets}
            suggestions={suggestions}
            onChange={(next) => {
              const arr = (node.choices ?? []).slice();
              arr[i] = next;
              onPatch({ choices: arr });
            }}
            onDelete={() => {
              const arr = (node.choices ?? []).filter((_, j) => j !== i);
              onPatch({ choices: arr.length > 0 ? arr : undefined });
            }}
          />
        ))}
        <button onClick={() => onPatch({ choices: [...(node.choices ?? []), { label: "", goto: null }] })} style={addBtn}>
          + choice
        </button>
      </div>

      {!hasChoices && (
        <div>
          <div style={{ fontSize: 11, color: "#888" }}>auto (next node when pages finish, null = end)</div>
          <select value={node.auto ?? ""} onChange={(e) => onPatch({ auto: e.target.value || null })} style={sel}>
            <option value="">(end)</option>
            {Object.keys(tree.nodes).filter((id) => id !== node.id).map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </div>
      )}

      <div>
        <div style={{ fontSize: 11, color: "#888" }}>onEnter rewards</div>
        <RewardListBuilder
          value={node.onEnter}
          onChange={(next) => onPatch({ onEnter: next })}
          suggestions={suggestions}
        />
      </div>

      <button onClick={onDelete} style={btn("danger")}>Delete node</button>
    </div>
  );
}

function ChoiceEditor({
  value,
  targets,
  suggestions,
  onChange,
  onDelete,
}: {
  value: DialogueChoice;
  targets: string[];
  suggestions: ReturnType<typeof useSuggestions>;
  onChange: (next: DialogueChoice) => void;
  onDelete: () => void;
}) {
  return (
    <div style={{ background: "#141420", border: "1px solid #2a2a38", padding: 6, marginTop: 4, borderRadius: 3 }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input value={value.label} onChange={(e) => onChange({ ...value, label: e.target.value })} placeholder="label" style={{ ...inp, flex: 1 }} />
        <select value={value.goto ?? ""} onChange={(e) => onChange({ ...value, goto: e.target.value || null })} style={sel}>
          {targets.map((t) => <option key={t} value={t}>{t || "(end)"}</option>)}
        </select>
        <button onClick={onDelete} style={delBtn}>×</button>
      </div>
      <details style={{ marginTop: 4 }}>
        <summary style={{ fontSize: 11, color: "#888", cursor: "pointer" }}>when gate</summary>
        <PredicateBuilder
          value={value.when as Predicate | undefined}
          onChange={(p) => onChange({ ...value, when: p })}
          suggestions={suggestions}
        />
      </details>
      <details style={{ marginTop: 4 }}>
        <summary style={{ fontSize: 11, color: "#888", cursor: "pointer" }}>onPick rewards</summary>
        <RewardListBuilder
          value={value.onPick as Reward[] | undefined}
          onChange={(r) => onChange({ ...value, onPick: r })}
          suggestions={suggestions}
        />
      </details>
    </div>
  );
}

// --- Shared bits -------------------------------------------------

function LabeledInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ fontSize: 11, color: "#888" }}>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={inp} />
    </label>
  );
}

const sel: React.CSSProperties = { padding: "3px 6px", background: "#0c0c14", color: "inherit", border: "1px solid #333", font: "inherit", fontSize: 12 };
const inp: React.CSSProperties = { padding: "3px 6px", background: "#0c0c14", color: "inherit", border: "1px solid #333", font: "inherit", fontSize: 12 };
const addBtn: React.CSSProperties = { padding: "2px 8px", background: "transparent", color: "#8af", border: "1px dashed #446", font: "inherit", fontSize: 11, cursor: "pointer", borderRadius: 3, marginTop: 4 };
const delBtn: React.CSSProperties = { padding: "0 6px", background: "transparent", color: "#f88", border: "none", cursor: "pointer", fontSize: 14 };

function btn(variant: "primary" | "danger" | "ghost"): React.CSSProperties {
  const base: React.CSSProperties = { padding: "4px 10px", borderRadius: 3, border: "1px solid #333", font: "inherit", fontSize: 11, cursor: "pointer" };
  if (variant === "primary") return { ...base, background: "#2b4d7a", color: "#fff", borderColor: "#3d6aa8" };
  if (variant === "danger") return { ...base, background: "#5a2020", color: "#fff", borderColor: "#8a3030" };
  return { ...base, background: "transparent", color: "#ccc" };
}
