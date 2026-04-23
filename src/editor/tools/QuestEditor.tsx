import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Predicate, QuestDef, StepDef } from "../../game/quests/types";
import { useJsonFile } from "../useJsonFile";
import { GraphView, type GraphEdge, type GraphNode } from "../widgets/GraphView";
import { PredicateBuilder } from "../widgets/PredicateBuilder";
import { RewardListBuilder } from "../widgets/RewardBuilder";
import { useSuggestions } from "../widgets/useSuggestions";

interface QuestsFile {
  quests: QuestDef[];
}

type QuestWithLayout = QuestDef & {
  editor?: { layout?: Record<string, { x: number; y: number }> };
};

export function QuestEditor() {
  const suggestions = useSuggestions();
  const file = useJsonFile<QuestsFile>("src/game/data/quests.json");
  const [draft, setDraft] = useState<QuestWithLayout[] | null>(null);
  const [selectedQuest, setSelectedQuest] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!draft && file.data) {
      setDraft(file.data.quests as QuestWithLayout[]);
      if (file.data.quests[0]) setSelectedQuest(file.data.quests[0].id);
    }
  }, [file.data, draft]);

  const quest = draft?.find((q) => q.id === selectedQuest) ?? null;

  const updateQuest = useCallback(
    (patch: Partial<QuestWithLayout>) => {
      if (!draft || !quest) return;
      setDraft(draft.map((q) => (q.id === quest.id ? { ...q, ...patch } : q)));
    },
    [draft, quest],
  );

  const updateStep = useCallback(
    (stepId: string, patch: Partial<StepDef>) => {
      if (!quest) return;
      updateQuest({ steps: { ...quest.steps, [stepId]: { ...quest.steps[stepId], ...patch } } });
    },
    [quest, updateQuest],
  );

  const addQuest = () => {
    if (!draft) return;
    const id = `quest_${draft.length + 1}`;
    const q: QuestWithLayout = {
      id,
      title: id,
      entry: "step1",
      steps: {
        step1: { id: "step1", next: [] },
      },
      editor: { layout: { step1: { x: 100, y: 100 } } },
    };
    setDraft([...draft, q]);
    setSelectedQuest(id);
    setSelectedStep("step1");
  };

  const deleteQuest = () => {
    if (!draft || !quest) return;
    if (!window.confirm(`Delete quest ${quest.id}?`)) return;
    setDraft(draft.filter((q) => q.id !== quest.id));
    setSelectedQuest(draft[0]?.id ?? null);
  };

  const addStep = () => {
    if (!quest) return;
    const existing = Object.keys(quest.steps);
    let n = existing.length + 1;
    while (existing.includes(`step${n}`)) n++;
    const id = `step${n}`;
    updateQuest({
      steps: { ...quest.steps, [id]: { id, next: [] } },
      editor: {
        ...(quest.editor ?? {}),
        layout: { ...(quest.editor?.layout ?? {}), [id]: { x: 200 + n * 30, y: 200 } },
      },
    });
    setSelectedStep(id);
  };

  const deleteStep = (stepId: string) => {
    if (!quest) return;
    if (quest.entry === stepId) { window.alert("Can't delete entry step."); return; }
    if (!window.confirm(`Delete step ${stepId}?`)) return;
    const nextSteps = { ...quest.steps };
    delete nextSteps[stepId];
    for (const s of Object.values(nextSteps)) {
      s.next = (s.next ?? []).filter((e) => e.goto !== stepId);
    }
    const nextLayout = { ...(quest.editor?.layout ?? {}) };
    delete nextLayout[stepId];
    updateQuest({ steps: nextSteps, editor: { ...(quest.editor ?? {}), layout: nextLayout } });
    if (selectedStep === stepId) setSelectedStep(null);
  };

  const onNodeMove = useCallback(
    (stepId: string, x: number, y: number) => {
      if (!quest) return;
      updateQuest({
        editor: { ...(quest.editor ?? {}), layout: { ...(quest.editor?.layout ?? {}), [stepId]: { x, y } } },
      });
    },
    [quest, updateQuest],
  );

  // Graph ----------------------------------------------------------
  const graphNodes: Array<GraphNode & { step: StepDef; isEntry: boolean }> = useMemo(() => {
    if (!quest) return [];
    return Object.values(quest.steps).map((s) => ({
      id: s.id,
      x: quest.editor?.layout?.[s.id]?.x ?? 100,
      y: quest.editor?.layout?.[s.id]?.y ?? 100,
      width: 200,
      height: 90,
      step: s,
      isEntry: quest.entry === s.id,
    }));
  }, [quest]);

  const graphEdges: GraphEdge[] = useMemo(() => {
    if (!quest) return [];
    const out: GraphEdge[] = [];
    for (const s of Object.values(quest.steps)) {
      for (let i = 0; i < s.next.length; i++) {
        const e = s.next[i];
        if (!quest.steps[e.goto]) continue;
        out.push({
          id: `${s.id}[${i}]->${e.goto}`,
          from: s.id,
          to: e.goto,
          label: e.when ? predicateSummary(e.when) : "(default)",
          color: e.when ? "#e0b060" : "#666",
        });
      }
    }
    return out;
  }, [quest]);

  // Validation ------------------------------------------------------
  const validate = useCallback((q: QuestWithLayout): string[] => {
    const errs: string[] = [];
    if (!q.id) errs.push("Quest id is required.");
    if (!q.steps[q.entry]) errs.push(`Entry step "${q.entry}" is not defined.`);
    for (const s of Object.values(q.steps)) {
      for (const e of s.next) {
        if (!q.steps[e.goto]) errs.push(`Step ${s.id}: edge goes to unknown step "${e.goto}".`);
      }
    }
    for (const pre of q.prerequisites ?? []) {
      if (!(draft ?? []).some((other) => other.id === pre)) {
        errs.push(`Prerequisite "${pre}" does not exist.`);
      }
    }
    return errs;
  }, [draft]);

  const dirty = useMemo(() => {
    if (!draft || !file.data) return false;
    return JSON.stringify({ quests: draft }) !== JSON.stringify(file.data);
  }, [draft, file.data]);

  const onSave = async () => {
    if (!draft) return;
    const allErrs: string[] = [];
    for (const q of draft) {
      const errs = validate(q);
      for (const e of errs) allErrs.push(`[${q.id}] ${e}`);
    }
    if (allErrs.length > 0) {
      setValidationErrors(allErrs);
      return;
    }
    setValidationErrors([]);
    await file.save({ quests: draft });
  };

  const onJump = () => {
    if (!selectedQuest || !selectedStep) return;
    const url = new URL(window.location.origin + "/");
    url.searchParams.set("questJump", `${selectedQuest}:${selectedStep}`);
    window.open(url.toString(), "_blank");
  };

  const selStep = selectedStep && quest?.steps[selectedStep];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label style={{ fontWeight: 600 }}>Quest:</label>
        <select value={selectedQuest ?? ""} onChange={(e) => { setSelectedQuest(e.target.value); setSelectedStep(null); }} style={sel}>
          {(draft ?? []).map((q) => <option key={q.id} value={q.id}>{q.title || q.id}</option>)}
        </select>
        <button onClick={addQuest} style={btn("ghost")}>+ Quest</button>
        <button onClick={deleteQuest} disabled={!quest} style={btn("danger")}>Delete</button>
        <div style={{ flex: 1 }} />
        <button onClick={onJump} disabled={!selectedStep} style={btn("ghost")}>Jump to step ▶</button>
        <button onClick={onSave} disabled={!dirty || file.saving} style={btn(dirty && !file.saving ? "primary" : "ghost")}>
          {file.saving ? "Saving…" : "Save (validates)"}
        </button>
      </div>

      {validationErrors.length > 0 && (
        <div style={{ padding: 8, background: "#4a1818", border: "1px solid #8a3030", borderRadius: 3, color: "#fbb", fontSize: 12 }}>
          <strong>Save blocked — validation errors:</strong>
          <ul style={{ margin: "4px 0 0 16px" }}>
            {validationErrors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, border: "1px solid #222", position: "relative", minHeight: 400 }}>
          {quest && (
            <GraphView
              nodes={graphNodes}
              edges={graphEdges}
              selectedId={selectedStep}
              onSelect={setSelectedStep}
              onNodeMove={onNodeMove}
              renderNode={(gn, selected) => (
                <QuestStepBox
                  step={gn.step}
                  isEntry={gn.isEntry}
                  selected={selected}
                  onMakeEntry={() => updateQuest({ entry: gn.id })}
                />
              )}
            />
          )}
          <div style={{ position: "absolute", top: 6, left: 6, display: "flex", gap: 4 }}>
            <button onClick={addStep} disabled={!quest} style={btn("ghost")}>+ Step</button>
          </div>
        </div>

        <aside style={{ width: 460, padding: 10, background: "#12121a", border: "1px solid #222", overflow: "auto" }}>
          {quest && !selStep && (
            <QuestMetaEditor quest={quest} onPatch={updateQuest} suggestions={suggestions} />
          )}
          {quest && selStep && (
            <StepInspector
              quest={quest}
              step={selStep}
              onPatch={(p) => updateStep(selStep.id, p)}
              onDelete={() => deleteStep(selStep.id)}
              suggestions={suggestions}
            />
          )}
          <PlaytestPanel quest={quest} />
        </aside>
      </div>
    </div>
  );
}

// --- Step box ----------------------------------------------------

function QuestStepBox({ step, isEntry, selected, onMakeEntry }: { step: StepDef; isEntry: boolean; selected: boolean; onMakeEntry: () => void }) {
  const terminal = step.next.length === 0;
  return (
    <div style={{
      background: "#161620",
      border: `2px solid ${selected ? "#ffdd44" : isEntry ? "#8f8" : terminal ? "#aa6060" : "#4a7fb0"}`,
      borderRadius: 4,
      padding: 6,
      fontSize: 12,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>{step.id}</strong>
        {isEntry ? <span style={{ fontSize: 10, color: "#8f8" }}>ENTRY</span> : terminal ? <span style={{ fontSize: 10, color: "#faa" }}>END</span> : null}
      </div>
      {step.title && <div style={{ color: "#cde" }}>{step.title}</div>}
      {step.completeWhen && <div style={{ color: "#8af", fontSize: 10, marginTop: 2 }}>when: {predicateSummary(step.completeWhen)}</div>}
      {(step.subgoals?.length ?? 0) > 0 && <div style={{ fontSize: 10, color: "#aa8" }}>{step.subgoals!.length} subgoal{step.subgoals!.length === 1 ? "" : "s"}</div>}
      {!isEntry && (
        <button onMouseDown={(e) => e.stopPropagation()} onClick={onMakeEntry} style={{ ...btn("ghost"), fontSize: 10, padding: "1px 4px", marginTop: 2 }}>
          Set entry
        </button>
      )}
    </div>
  );
}

// --- Quest metadata editor ---------------------------------------

function QuestMetaEditor({ quest, onPatch, suggestions }: { quest: QuestWithLayout; onPatch: (p: Partial<QuestWithLayout>) => void; suggestions: ReturnType<typeof useSuggestions> }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h3 style={{ margin: 0 }}>Quest: {quest.id}</h3>
      <Labeled label="id"><input value={quest.id} onChange={(e) => onPatch({ id: e.target.value })} style={inp} /></Labeled>
      <Labeled label="title"><input value={quest.title} onChange={(e) => onPatch({ title: e.target.value })} style={inp} /></Labeled>
      <Labeled label="summary">
        <textarea value={quest.summary ?? ""} onChange={(e) => onPatch({ summary: e.target.value || undefined })} rows={2} style={{ ...inp, resize: "vertical" }} />
      </Labeled>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={!!quest.hidden} onChange={(e) => onPatch({ hidden: e.target.checked || undefined })} />
        <span style={{ fontSize: 11 }}>hidden (until unlocked)</span>
      </label>
      <div>
        <div style={{ fontSize: 11, color: "#888" }}>prerequisites</div>
        <input
          value={(quest.prerequisites ?? []).join(", ")}
          onChange={(e) => {
            const arr = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
            onPatch({ prerequisites: arr.length ? arr : undefined });
          }}
          placeholder="comma-separated quest ids"
          style={inp}
        />
      </div>
      <div>
        <div style={{ fontSize: 11, color: "#888" }}>startWhen</div>
        <PredicateBuilder
          value={quest.startWhen}
          onChange={(p) => onPatch({ startWhen: p })}
          suggestions={suggestions}
        />
      </div>
      <div>
        <div style={{ fontSize: 11, color: "#888" }}>onComplete rewards (terminal step)</div>
        <RewardListBuilder value={quest.onComplete} onChange={(r) => onPatch({ onComplete: r })} suggestions={suggestions} />
      </div>
    </div>
  );
}

// --- Step inspector ----------------------------------------------

function StepInspector({
  quest,
  step,
  onPatch,
  onDelete,
  suggestions,
}: {
  quest: QuestWithLayout;
  step: StepDef;
  onPatch: (p: Partial<StepDef>) => void;
  onDelete: () => void;
  suggestions: ReturnType<typeof useSuggestions>;
}) {
  const stepIds = Object.keys(quest.steps).filter((id) => id !== step.id);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>Step: {step.id}</h3>
        <button onClick={onDelete} style={btn("danger")}>Delete</button>
      </div>
      <Labeled label="id"><input value={step.id} onChange={(e) => onPatch({ id: e.target.value })} style={inp} /></Labeled>
      <Labeled label="title"><input value={step.title ?? ""} onChange={(e) => onPatch({ title: e.target.value || undefined })} style={inp} /></Labeled>
      <Labeled label="description">
        <textarea value={step.description ?? ""} onChange={(e) => onPatch({ description: e.target.value || undefined })} rows={2} style={{ ...inp, resize: "vertical" }} />
      </Labeled>

      <div>
        <div style={{ fontSize: 11, color: "#888" }}>completeWhen</div>
        <PredicateBuilder value={step.completeWhen} onChange={(p) => onPatch({ completeWhen: p })} suggestions={suggestions} />
      </div>

      <div>
        <div style={{ fontSize: 11, color: "#888" }}>onEnter rewards</div>
        <RewardListBuilder value={step.onEnter} onChange={(r) => onPatch({ onEnter: r })} suggestions={suggestions} />
      </div>

      <div>
        <div style={{ fontSize: 11, color: "#888" }}>onComplete rewards</div>
        <RewardListBuilder value={step.onComplete} onChange={(r) => onPatch({ onComplete: r })} suggestions={suggestions} />
      </div>

      <div>
        <div style={{ fontSize: 11, color: "#888" }}>next (edges; first matching wins)</div>
        {step.next.map((e, i) => (
          <div key={i} style={{ background: "#141420", border: "1px solid #2a2a38", padding: 6, borderRadius: 3, marginBottom: 4 }}>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "#888", width: 20 }}>{i + 1}</span>
              <span style={{ fontSize: 11 }}>→</span>
              <select value={e.goto} onChange={(ev) => onPatch({ next: step.next.map((x, j) => j === i ? { ...x, goto: ev.target.value } : x) })} style={sel}>
                <option value="">(pick step)</option>
                {stepIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
              <div style={{ flex: 1 }} />
              <button onClick={() => onPatch({ next: step.next.map((x, j) => j === i - 1 ? step.next[i] : j === i ? step.next[i - 1] : x).filter((_, j) => j < step.next.length) })} disabled={i === 0} style={iconBtn}>▲</button>
              <button onClick={() => onPatch({ next: step.next.filter((_, j) => j !== i) })} style={delBtn}>×</button>
            </div>
            <details style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 11, color: "#888", cursor: "pointer" }}>when ({e.when ? "set" : "default"})</summary>
              <PredicateBuilder
                value={e.when}
                onChange={(p) => onPatch({ next: step.next.map((x, j) => j === i ? { ...x, when: p } : x) })}
                suggestions={suggestions}
              />
            </details>
          </div>
        ))}
        <button onClick={() => onPatch({ next: [...step.next, { goto: stepIds[0] ?? "" }] })} style={addBtn}>+ edge</button>
      </div>

      <div>
        <div style={{ fontSize: 11, color: "#888" }}>subgoals (parallel)</div>
        {(step.subgoals ?? []).map((sg, i) => (
          <div key={i} style={{ background: "#141420", border: "1px solid #2a2a38", padding: 6, borderRadius: 3, marginBottom: 4 }}>
            <div style={{ display: "flex", gap: 4 }}>
              <input value={sg.id} onChange={(e) => onPatch({ subgoals: (step.subgoals ?? []).map((x, j) => j === i ? { ...x, id: e.target.value } : x) })} placeholder="id" style={{ ...inp, flex: 1 }} />
              <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 3 }}>
                <input type="checkbox" checked={!!sg.optional} onChange={(e) => onPatch({ subgoals: (step.subgoals ?? []).map((x, j) => j === i ? { ...x, optional: e.target.checked || undefined } : x) })} />
                opt
              </label>
              <button onClick={() => onPatch({ subgoals: (step.subgoals ?? []).filter((_, j) => j !== i) })} style={delBtn}>×</button>
            </div>
            <PredicateBuilder
              value={sg.completeWhen}
              onChange={(p) => onPatch({ subgoals: (step.subgoals ?? []).map((x, j) => j === i ? { ...x, completeWhen: p ?? { kind: "flag", key: "" } } : x) })}
              suggestions={suggestions}
              required
            />
          </div>
        ))}
        <button onClick={() => onPatch({ subgoals: [...(step.subgoals ?? []), { id: `sg${(step.subgoals?.length ?? 0) + 1}`, completeWhen: { kind: "flag", key: "" } }] })} style={addBtn}>+ subgoal</button>
      </div>
    </div>
  );
}

// --- Playtest panel ----------------------------------------------

function PlaytestPanel({ quest }: { quest: QuestWithLayout | null }) {
  const [flagKey, setFlagKey] = useState("");
  const [flagValue, setFlagValue] = useState("true");
  const [event, setEvent] = useState("combat:enemyKilled");

  const launch = (params: Record<string, string>) => {
    const url = new URL(window.location.origin + "/");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    window.open(url.toString(), "_blank");
  };

  return (
    <details style={{ marginTop: 16 }}>
      <summary style={{ fontWeight: 600, cursor: "pointer" }}>Playtest controls</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        <div>
          <div style={{ fontSize: 11, color: "#888" }}>Pre-set flag (applied on game boot)</div>
          <div style={{ display: "flex", gap: 4 }}>
            <input value={flagKey} onChange={(e) => setFlagKey(e.target.value)} placeholder="flag key" style={{ ...inp, flex: 1 }} />
            <input value={flagValue} onChange={(e) => setFlagValue(e.target.value)} placeholder="value" style={{ ...inp, width: 80 }} />
            <button onClick={() => launch({ setFlag: `${flagKey}=${flagValue}` })} disabled={!flagKey} style={btn("ghost")}>Launch ▶</button>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "#888" }}>Force-emit bus event</div>
          <div style={{ display: "flex", gap: 4 }}>
            <input value={event} onChange={(e) => setEvent(e.target.value)} style={{ ...inp, flex: 1 }} />
            <button onClick={() => launch({ emitEvent: event })} style={btn("ghost")}>Launch ▶</button>
          </div>
        </div>
        {quest && (
          <div style={{ fontSize: 11, color: "#888" }}>
            Tip: "Jump to step ▶" at the top of this panel launches the game with this quest already on the selected step.
          </div>
        )}
      </div>
    </details>
  );
}

// --- Helpers -----------------------------------------------------

function predicateSummary(p: Predicate): string {
  switch (p.kind) {
    case "event": return `event:${p.event}`;
    case "flag": return p.exists ? `flag:${p.key}?` : `flag:${p.key}=${p.equals}`;
    case "quest": return `quest:${p.questId}=${p.status}`;
    case "step": return `step:${p.questId}/${p.stepId}=${p.status}`;
    case "hasItem": return `item:${p.itemId}≥${p.min ?? 1}`;
    case "jobLevel": return `${p.jobId}≥L${p.min}`;
    case "sceneMap": return `map:${p.mapId}`;
    case "and": return `and(${p.all.length})`;
    case "or": return `or(${p.any.length})`;
    case "not": return `not(${predicateSummary(p.predicate)})`;
  }
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ fontSize: 11, color: "#888" }}>{label}</span>
      {children}
    </label>
  );
}

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
