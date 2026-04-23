import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { CutsceneDef, CutsceneStep } from "../../game/cutscenes/types";
import { useJsonFile } from "../useJsonFile";
import { GraphView, type GraphEdge, type GraphNode } from "../widgets/GraphView";
import { useSuggestions } from "../widgets/useSuggestions";

interface CutscenesFile {
  cutscenes: CutsceneDef[];
}

interface GroupLayout {
  x: number;
  y: number;
}

type CutsceneWithLayout = CutsceneDef & {
  editor?: { layout?: Record<string, GroupLayout> };
};

const STEP_KINDS: CutsceneStep["kind"][] = [
  "wait",
  "walkTo",
  "face",
  "anim",
  "say",
  "changeMap",
  "goto",
  "setFlag",
  "if",
  "end",
];

export function CutsceneEditor() {
  const suggestions = useSuggestions();
  const file = useJsonFile<CutscenesFile>("src/game/data/cutscenes.json");
  const [draft, setDraft] = useState<CutsceneWithLayout[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  useEffect(() => {
    if (!draft && file.data) {
      setDraft(file.data.cutscenes as CutsceneWithLayout[]);
      if (file.data.cutscenes[0]) setSelectedId(file.data.cutscenes[0].id);
    }
  }, [file.data, draft]);

  const cutscene = draft?.find((c) => c.id === selectedId) ?? null;

  const updateCutscene = useCallback(
    (patch: Partial<CutsceneWithLayout>) => {
      if (!draft || !cutscene) return;
      setDraft(draft.map((c) => (c.id === cutscene.id ? { ...c, ...patch } : c)));
    },
    [draft, cutscene],
  );

  const updateGroup = useCallback(
    (groupId: string, steps: CutsceneStep[]) => {
      if (!cutscene) return;
      updateCutscene({ steps: { ...cutscene.steps, [groupId]: steps } });
    },
    [cutscene, updateCutscene],
  );

  const addCutscene = () => {
    if (!draft) return;
    const id = `cutscene_${draft.length + 1}`;
    const c: CutsceneWithLayout = {
      id,
      name: id,
      entry: "start",
      steps: { start: [{ kind: "end" }] },
      editor: { layout: { start: { x: 50, y: 50 } } },
    };
    setDraft([...draft, c]);
    setSelectedId(id);
    setSelectedGroup("start");
  };

  const addGroup = () => {
    if (!cutscene) return;
    const existing = Object.keys(cutscene.steps);
    let n = existing.length + 1;
    while (existing.includes(`group${n}`)) n++;
    const id = `group${n}`;
    updateCutscene({
      steps: { ...cutscene.steps, [id]: [] },
      editor: {
        ...(cutscene.editor ?? {}),
        layout: { ...(cutscene.editor?.layout ?? {}), [id]: { x: 100 + n * 50, y: 150 } },
      },
    });
    setSelectedGroup(id);
  };

  const deleteGroup = (groupId: string) => {
    if (!cutscene) return;
    if (cutscene.entry === groupId) { window.alert("Can't delete entry group."); return; }
    if (!window.confirm(`Delete group ${groupId}?`)) return;
    const nextSteps = { ...cutscene.steps };
    delete nextSteps[groupId];
    const nextLayout = { ...(cutscene.editor?.layout ?? {}) };
    delete nextLayout[groupId];
    updateCutscene({ steps: nextSteps, editor: { ...(cutscene.editor ?? {}), layout: nextLayout } });
    if (selectedGroup === groupId) setSelectedGroup(null);
  };

  const graphNodes: Array<GraphNode & { groupId: string; steps: CutsceneStep[] }> = useMemo(() => {
    if (!cutscene) return [];
    return Object.entries(cutscene.steps).map(([gid, steps]) => ({
      id: gid,
      x: cutscene.editor?.layout?.[gid]?.x ?? 100,
      y: cutscene.editor?.layout?.[gid]?.y ?? 100,
      width: 180,
      height: 80,
      groupId: gid,
      steps,
    }));
  }, [cutscene]);

  // Edges: goto/if/say-choices between groups.
  const graphEdges: GraphEdge[] = useMemo(() => {
    if (!cutscene) return [];
    const out: GraphEdge[] = [];
    for (const [gid, steps] of Object.entries(cutscene.steps)) {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.kind === "goto" && cutscene.steps[s.label]) {
          out.push({ id: `${gid}[${i}]->goto->${s.label}`, from: gid, to: s.label, label: "goto" });
        }
        if (s.kind === "if") {
          if (cutscene.steps[s.then]) out.push({ id: `${gid}[${i}]->if->${s.then}`, from: gid, to: s.then, label: `if ${s.flag}` });
          if (s.else && cutscene.steps[s.else]) out.push({ id: `${gid}[${i}]->else->${s.else}`, from: gid, to: s.else, label: "else" });
        }
        if (s.kind === "say" && s.choices) {
          for (const c of s.choices) {
            if (cutscene.steps[c.goto]) {
              out.push({ id: `${gid}[${i}]-${c.label}->${c.goto}`, from: gid, to: c.goto, label: c.label || "(choice)", color: "#e0b060" });
            }
          }
        }
      }
    }
    return out;
  }, [cutscene]);

  const onNodeMove = useCallback(
    (gid: string, x: number, y: number) => {
      if (!cutscene) return;
      updateCutscene({
        editor: { ...(cutscene.editor ?? {}), layout: { ...(cutscene.editor?.layout ?? {}), [gid]: { x, y } } },
      });
    },
    [cutscene, updateCutscene],
  );

  const dirty = useMemo(() => {
    if (!draft || !file.data) return false;
    return JSON.stringify({ cutscenes: draft }) !== JSON.stringify(file.data);
  }, [draft, file.data]);

  const onSave = async () => {
    if (!draft) return;
    await file.save({ cutscenes: draft });
  };

  const onPlay = () => {
    if (!selectedId) return;
    const url = new URL(window.location.origin + "/");
    url.searchParams.set("playCutscene", selectedId);
    if (selectedGroup) url.searchParams.set("group", selectedGroup);
    window.open(url.toString(), "_blank");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label style={{ fontWeight: 600 }}>Cutscene:</label>
        <select value={selectedId ?? ""} onChange={(e) => { setSelectedId(e.target.value); setSelectedGroup(null); }} style={sel}>
          {(draft ?? []).map((c) => <option key={c.id} value={c.id}>{c.name ?? c.id}</option>)}
        </select>
        <button onClick={addCutscene} style={btn("ghost")}>+ Cutscene</button>
        <div style={{ flex: 1 }} />
        <button onClick={onPlay} disabled={!selectedId} style={btn("ghost")}>Play from here ▶</button>
        <button onClick={onSave} disabled={!dirty || file.saving} style={btn(dirty && !file.saving ? "primary" : "ghost")}>
          {file.saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, border: "1px solid #222", position: "relative", minHeight: 400 }}>
          {cutscene && (
            <GraphView
              nodes={graphNodes}
              edges={graphEdges}
              selectedId={selectedGroup}
              onSelect={setSelectedGroup}
              onNodeMove={onNodeMove}
              renderNode={(gn, selected) => (
                <GroupBox
                  groupId={gn.groupId}
                  steps={gn.steps}
                  isEntry={cutscene.entry === gn.groupId}
                  selected={selected}
                  onMakeEntry={() => updateCutscene({ entry: gn.groupId })}
                />
              )}
            />
          )}
          <div style={{ position: "absolute", top: 6, left: 6, display: "flex", gap: 4 }}>
            <button onClick={addGroup} disabled={!cutscene} style={btn("ghost")}>+ Group</button>
          </div>
        </div>

        <aside style={{ width: 440, padding: 10, background: "#12121a", border: "1px solid #222", overflow: "auto" }}>
          {cutscene && selectedGroup && (
            <StepTimeline
              groupId={selectedGroup}
              steps={cutscene.steps[selectedGroup] ?? []}
              allGroups={Object.keys(cutscene.steps)}
              onChange={(next) => updateGroup(selectedGroup, next)}
              onDeleteGroup={() => deleteGroup(selectedGroup)}
              suggestions={suggestions}
            />
          )}
          {(!cutscene || !selectedGroup) && <div style={{ color: "#888" }}>Select a group.</div>}
        </aside>
      </div>
    </div>
  );
}

// --- Group box ---------------------------------------------------

function GroupBox({
  groupId,
  steps,
  isEntry,
  selected,
  onMakeEntry,
}: {
  groupId: string;
  steps: CutsceneStep[];
  isEntry: boolean;
  selected: boolean;
  onMakeEntry: () => void;
}) {
  return (
    <div style={{
      background: "#161620",
      border: `2px solid ${selected ? "#ffdd44" : isEntry ? "#8f8" : "#4a7fb0"}`,
      borderRadius: 4,
      padding: 6,
      fontSize: 12,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ color: "#cde" }}>{groupId}</strong>
        <div style={{ fontSize: 10, color: "#888" }}>{steps.length} step{steps.length === 1 ? "" : "s"}</div>
      </div>
      {isEntry ? (
        <div style={{ fontSize: 10, color: "#8f8" }}>ENTRY</div>
      ) : (
        <button onMouseDown={(e) => e.stopPropagation()} onClick={onMakeEntry} style={{ ...btn("ghost"), fontSize: 10, padding: "1px 4px", marginTop: 2 }}>
          Set as entry
        </button>
      )}
      <div style={{ color: "#aaa", marginTop: 4, fontSize: 11 }}>
        {steps.slice(0, 3).map((s, i) => <div key={i}>• {summarize(s)}</div>)}
        {steps.length > 3 && <div>…</div>}
      </div>
    </div>
  );
}

function summarize(s: CutsceneStep): string {
  switch (s.kind) {
    case "wait": return `wait ${s.ms}ms`;
    case "walkTo": return `${s.actor} → (${s.tileX},${s.tileY})`;
    case "face": return `${s.actor} face ${s.dir}`;
    case "anim": return `${s.actor} anim ${s.state}`;
    case "say": return s.dialogueId ? `say → ${s.dialogueId}` : `say: ${(s.pages ?? [""])[0]?.slice(0, 20) ?? ""}`;
    case "changeMap": return `→ ${s.mapId} (${s.tileX},${s.tileY})`;
    case "goto": return `goto ${s.label}`;
    case "setFlag": return `flag ${s.name} = ${s.value}`;
    case "if": return `if ${s.flag}==${s.equals}`;
    case "end": return "end";
  }
}

// --- Step timeline -----------------------------------------------

function StepTimeline({
  groupId,
  steps,
  allGroups,
  onChange,
  onDeleteGroup,
  suggestions,
}: {
  groupId: string;
  steps: CutsceneStep[];
  allGroups: string[];
  onChange: (next: CutsceneStep[]) => void;
  onDeleteGroup: () => void;
  suggestions: ReturnType<typeof useSuggestions>;
}) {
  const addStep = () => onChange([...steps, { kind: "wait", ms: 500 }]);
  const setStep = (i: number, s: CutsceneStep) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const del = (i: number) => onChange(steps.filter((_, j) => j !== i));
  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= steps.length) return;
    const next = steps.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>Group: {groupId}</h3>
        <button onClick={onDeleteGroup} style={btn("danger")}>Delete group</button>
      </div>
      {steps.map((s, i) => (
        <div key={i} style={{ border: "1px solid #2a2a38", padding: 6, borderRadius: 3, background: "#141420" }}>
          <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4 }}>
            <span style={{ color: "#888", fontSize: 11, width: 24 }}>#{i + 1}</span>
            <select value={s.kind} onChange={(e) => setStep(i, changeStepKind(s, e.target.value as CutsceneStep["kind"]))} style={sel}>
              {STEP_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <div style={{ flex: 1 }} />
            <button onClick={() => move(i, -1)} style={iconBtn}>▲</button>
            <button onClick={() => move(i, +1)} style={iconBtn}>▼</button>
            <button onClick={() => del(i)} style={delBtn}>×</button>
          </div>
          <StepFields step={s} allGroups={allGroups} suggestions={suggestions} onChange={(next) => setStep(i, next)} />
        </div>
      ))}
      <button onClick={addStep} style={addBtn}>+ step</button>
    </div>
  );
}

function StepFields({
  step,
  allGroups,
  suggestions,
  onChange,
}: {
  step: CutsceneStep;
  allGroups: string[];
  suggestions: ReturnType<typeof useSuggestions>;
  onChange: (s: CutsceneStep) => void;
}) {
  const s = step;
  if (s.kind === "wait") {
    return <Labeled label="ms"><input type="number" value={s.ms} onChange={(e) => onChange({ ...s, ms: Number(e.target.value) })} style={inp} /></Labeled>;
  }
  if (s.kind === "walkTo") {
    return (
      <div style={flexGap}>
        <Labeled label="actor"><Auto value={s.actor} onChange={(v) => onChange({ ...s, actor: v })} suggestions={[...suggestions.npcs, "player"]} /></Labeled>
        <Labeled label="tileX"><input type="number" value={s.tileX} onChange={(e) => onChange({ ...s, tileX: Number(e.target.value) })} style={{ ...inp, width: 70 }} /></Labeled>
        <Labeled label="tileY"><input type="number" value={s.tileY} onChange={(e) => onChange({ ...s, tileY: Number(e.target.value) })} style={{ ...inp, width: 70 }} /></Labeled>
        <Labeled label="speed"><input type="number" value={s.speed ?? ""} placeholder="80" onChange={(e) => onChange({ ...s, speed: e.target.value ? Number(e.target.value) : undefined })} style={{ ...inp, width: 70 }} /></Labeled>
      </div>
    );
  }
  if (s.kind === "face") {
    return (
      <div style={flexGap}>
        <Labeled label="actor"><Auto value={s.actor} onChange={(v) => onChange({ ...s, actor: v })} suggestions={[...suggestions.npcs, "player"]} /></Labeled>
        <Labeled label="dir"><select value={s.dir} onChange={(e) => onChange({ ...s, dir: e.target.value as typeof s.dir })} style={sel}>{["left", "right", "up", "down"].map((d) => <option key={d}>{d}</option>)}</select></Labeled>
      </div>
    );
  }
  if (s.kind === "anim") {
    return (
      <div style={flexGap}>
        <Labeled label="actor"><Auto value={s.actor} onChange={(v) => onChange({ ...s, actor: v })} suggestions={[...suggestions.npcs, "player"]} /></Labeled>
        <Labeled label="state"><select value={s.state} onChange={(e) => onChange({ ...s, state: e.target.value as typeof s.state })} style={sel}><option value="idle">idle</option><option value="walk">walk</option></select></Labeled>
      </div>
    );
  }
  if (s.kind === "say") {
    return (
      <div style={flexCol}>
        <Labeled label="dialogueId (preferred) — uses DialogueDirector when set"><Auto value={s.dialogueId ?? ""} onChange={(v) => onChange({ ...s, dialogueId: v || undefined })} suggestions={suggestions.dialogues} /></Labeled>
        {s.dialogueId && (
          <Labeled label="nodeId (optional; override entry)"><input value={s.nodeId ?? ""} onChange={(e) => onChange({ ...s, nodeId: e.target.value || undefined })} style={inp} /></Labeled>
        )}
        {!s.dialogueId && (
          <>
            <Labeled label="speaker"><input value={s.speaker ?? ""} onChange={(e) => onChange({ ...s, speaker: e.target.value })} style={inp} /></Labeled>
            <Labeled label="pages (one per line)">
              <textarea
                value={(s.pages ?? []).join("\n")}
                onChange={(e) => onChange({ ...s, pages: e.target.value.split("\n") })}
                rows={3}
                style={{ ...inp, resize: "vertical" }}
              />
            </Labeled>
            <Labeled label="choices (legacy inline)">
              <div style={flexCol}>
                {(s.choices ?? []).map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: 4 }}>
                    <input value={c.label} onChange={(e) => {
                      const arr = (s.choices ?? []).slice();
                      arr[i] = { ...c, label: e.target.value };
                      onChange({ ...s, choices: arr });
                    }} placeholder="label" style={{ ...inp, flex: 1 }} />
                    <select value={c.goto} onChange={(e) => {
                      const arr = (s.choices ?? []).slice();
                      arr[i] = { ...c, goto: e.target.value };
                      onChange({ ...s, choices: arr });
                    }} style={sel}>
                      {allGroups.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <button onClick={() => {
                      const arr = (s.choices ?? []).filter((_, j) => j !== i);
                      onChange({ ...s, choices: arr.length ? arr : undefined });
                    }} style={delBtn}>×</button>
                  </div>
                ))}
                <button onClick={() => onChange({ ...s, choices: [...(s.choices ?? []), { label: "", goto: allGroups[0] ?? "" }] })} style={addBtn}>+ choice</button>
              </div>
            </Labeled>
          </>
        )}
      </div>
    );
  }
  if (s.kind === "changeMap") {
    return (
      <div style={flexGap}>
        <Labeled label="mapId"><Auto value={s.mapId} onChange={(v) => onChange({ ...s, mapId: v })} suggestions={suggestions.maps} /></Labeled>
        <Labeled label="tileX"><input type="number" value={s.tileX} onChange={(e) => onChange({ ...s, tileX: Number(e.target.value) })} style={{ ...inp, width: 70 }} /></Labeled>
        <Labeled label="tileY"><input type="number" value={s.tileY} onChange={(e) => onChange({ ...s, tileY: Number(e.target.value) })} style={{ ...inp, width: 70 }} /></Labeled>
        <Labeled label="facing"><select value={s.facing ?? ""} onChange={(e) => onChange({ ...s, facing: e.target.value ? (e.target.value as typeof s.facing) : undefined })} style={sel}><option value="">—</option>{["left", "right", "up", "down"].map((d) => <option key={d}>{d}</option>)}</select></Labeled>
      </div>
    );
  }
  if (s.kind === "goto") {
    return <Labeled label="label"><select value={s.label} onChange={(e) => onChange({ ...s, label: e.target.value })} style={sel}>{allGroups.map((g) => <option key={g}>{g}</option>)}</select></Labeled>;
  }
  if (s.kind === "setFlag") {
    return (
      <div style={flexGap}>
        <Labeled label="name"><input value={s.name} onChange={(e) => onChange({ ...s, name: e.target.value })} style={inp} /></Labeled>
        <Labeled label="value">
          <input value={String(s.value)} onChange={(e) => {
            const raw = e.target.value;
            const v: boolean | number | string =
              raw === "true" ? true :
              raw === "false" ? false :
              !Number.isNaN(Number(raw)) && raw.trim() !== "" ? Number(raw) :
              raw;
            onChange({ ...s, value: v });
          }} style={inp} />
        </Labeled>
      </div>
    );
  }
  if (s.kind === "if") {
    return (
      <div style={flexGap}>
        <Labeled label="flag"><input value={s.flag} onChange={(e) => onChange({ ...s, flag: e.target.value })} style={inp} /></Labeled>
        <Labeled label="equals"><input value={String(s.equals)} onChange={(e) => {
          const raw = e.target.value;
          const v = raw === "true" ? true : raw === "false" ? false : !Number.isNaN(Number(raw)) && raw.trim() !== "" ? Number(raw) : raw;
          onChange({ ...s, equals: v });
        }} style={inp} /></Labeled>
        <Labeled label="then"><select value={s.then} onChange={(e) => onChange({ ...s, then: e.target.value })} style={sel}>{allGroups.map((g) => <option key={g}>{g}</option>)}</select></Labeled>
        <Labeled label="else"><select value={s.else ?? ""} onChange={(e) => onChange({ ...s, else: e.target.value || undefined })} style={sel}><option value="">—</option>{allGroups.map((g) => <option key={g}>{g}</option>)}</select></Labeled>
      </div>
    );
  }
  if (s.kind === "end") return null;
  return null;
}

function changeStepKind(old: CutsceneStep, kind: CutsceneStep["kind"]): CutsceneStep {
  if (old.kind === kind) return old;
  switch (kind) {
    case "wait": return { kind: "wait", ms: 500 };
    case "walkTo": return { kind: "walkTo", actor: "player", tileX: 0, tileY: 0 };
    case "face": return { kind: "face", actor: "player", dir: "down" };
    case "anim": return { kind: "anim", actor: "player", state: "idle" };
    case "say": return { kind: "say", pages: [""] };
    case "changeMap": return { kind: "changeMap", mapId: "world", tileX: 0, tileY: 0 };
    case "goto": return { kind: "goto", label: "" };
    case "setFlag": return { kind: "setFlag", name: "", value: true };
    case "if": return { kind: "if", flag: "", equals: true, then: "" };
    case "end": return { kind: "end" };
  }
}

// --- helpers -----------------------------------------------------

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", marginRight: 6 }}>
      <span style={{ fontSize: 10, color: "#888" }}>{label}</span>
      {children}
    </label>
  );
}

function Auto({ value, onChange, suggestions }: { value: string; onChange: (v: string) => void; suggestions: string[] }) {
  const id = `cs-auto-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <>
      <input value={value} onChange={(e) => onChange(e.target.value)} list={id} style={{ ...inp, width: 140 }} />
      <datalist id={id}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
    </>
  );
}

const flexGap: React.CSSProperties = { display: "flex", gap: 4, flexWrap: "wrap" };
const flexCol: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const sel: React.CSSProperties = { padding: "3px 6px", background: "#0c0c14", color: "inherit", border: "1px solid #333", font: "inherit", fontSize: 12 };
const inp: React.CSSProperties = { padding: "3px 6px", background: "#0c0c14", color: "inherit", border: "1px solid #333", font: "inherit", fontSize: 12 };
const addBtn: React.CSSProperties = { padding: "2px 8px", background: "transparent", color: "#8af", border: "1px dashed #446", font: "inherit", fontSize: 11, cursor: "pointer", borderRadius: 3 };
const delBtn: React.CSSProperties = { padding: "0 6px", background: "transparent", color: "#f88", border: "none", cursor: "pointer", fontSize: 14 };
const iconBtn: React.CSSProperties = { padding: "1px 6px", background: "#222", color: "#ccc", border: "1px solid #333", font: "inherit", fontSize: 10, cursor: "pointer", borderRadius: 3 };

function btn(variant: "primary" | "danger" | "ghost"): React.CSSProperties {
  const base: React.CSSProperties = { padding: "4px 10px", borderRadius: 3, border: "1px solid #333", font: "inherit", fontSize: 11, cursor: "pointer" };
  if (variant === "primary") return { ...base, background: "#2b4d7a", color: "#fff", borderColor: "#3d6aa8" };
  if (variant === "danger") return { ...base, background: "#5a2020", color: "#fff", borderColor: "#8a3030" };
  return { ...base, background: "transparent", color: "#ccc" };
}
