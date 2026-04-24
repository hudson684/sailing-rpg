import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QuestDef, StepDef } from "../../game/quests/types";
import { useJsonFile } from "../useJsonFile";
import { GraphView, type GraphEdge, type GraphNode } from "../widgets/GraphView";
import { PredicateBuilder } from "../widgets/PredicateBuilder";
import { predicateSummary, rewriteQuestRefs } from "../widgets/predicateUtils";
import { RewardListBuilder } from "../widgets/RewardBuilder";
import { useSuggestions } from "../widgets/useSuggestions";

interface QuestsFile {
  quests: QuestDef[];
}

type QuestWithLayout = QuestDef & {
  editor?: { layout?: Record<string, { x: number; y: number }> };
};

interface History {
  past: QuestWithLayout[][];
  present: QuestWithLayout[] | null;
  future: QuestWithLayout[][];
}

const HISTORY_COLLAPSE_MS = 500;
const HISTORY_MAX = 100;

export function QuestEditor() {
  const suggestions = useSuggestions();
  const file = useJsonFile<QuestsFile>("src/game/data/quests.json");
  const [history, setHistory] = useState<History>({ past: [], present: null, future: [] });
  const draft = history.present;
  const lastPushAtRef = useRef<number>(0);

  const setDraft = useCallback((updater: QuestWithLayout[] | null | ((prev: QuestWithLayout[]) => QuestWithLayout[])) => {
    setHistory((h) => {
      if (updater === null) {
        // Reset (e.g. reload from disk): clear history too.
        return { past: [], present: null, future: [] };
      }
      const next = typeof updater === "function"
        ? (h.present ? updater(h.present) : h.present)
        : updater;
      if (next === null) return h;
      const now = Date.now();
      const collapse = h.present !== null && now - lastPushAtRef.current < HISTORY_COLLAPSE_MS;
      lastPushAtRef.current = now;
      const past = collapse || h.present === null
        ? h.past
        : [...h.past, h.present].slice(-HISTORY_MAX);
      return { past, present: next, future: [] };
    });
  }, []);

  const seedDraft = useCallback((next: QuestWithLayout[]) => {
    lastPushAtRef.current = 0;
    setHistory({ past: [], present: next, future: [] });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.past.length === 0 || h.present === null) return h;
      const prev = h.past[h.past.length - 1];
      lastPushAtRef.current = 0;
      return {
        past: h.past.slice(0, -1),
        present: prev,
        future: [h.present, ...h.future].slice(0, HISTORY_MAX),
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0 || h.present === null) return h;
      const next = h.future[0];
      lastPushAtRef.current = 0;
      return {
        past: [...h.past, h.present].slice(-HISTORY_MAX),
        present: next,
        future: h.future.slice(1),
      };
    });
  }, []);

  const [selectedQuest, setSelectedQuest] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  const dirty = useMemo(() => {
    if (!draft || !file.data) return false;
    return JSON.stringify({ quests: draft }) !== JSON.stringify(file.data);
  }, [draft, file.data]);

  const fileUnchanged = draft !== null && !dirty;

  useEffect(() => {
    if (!file.data) return;
    if (draft === null || fileUnchanged) {
      seedDraft(file.data.quests as QuestWithLayout[]);
      if (draft === null) {
        setSelectedQuest(file.data.quests[0]?.id ?? null);
      }
    }
  }, [file.data, draft, fileUnchanged, seedDraft]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Keyboard shortcuts (installed later — handlers are stable across renders via refs).
  const onSaveRef = useRef<() => void>(() => {});
  const deleteStepRef = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    const isEditingField = () => {
      const a = document.activeElement;
      if (!a) return false;
      const tag = a.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (a as HTMLElement).isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSaveRef.current();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (isEditingField()) return;
      if (e.key === "Escape") {
        setSelectedStep(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedStep) {
        e.preventDefault();
        deleteStepRef.current(selectedStep);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedStep, undo, redo]);

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

  const renameQuest = useCallback(
    (fromId: string, toId: string) => {
      if (!draft) return;
      if (fromId === toId) return;
      if (!toId.trim()) { window.alert("Quest id cannot be empty."); return; }
      if (draft.some((q) => q.id === toId)) { window.alert(`Quest "${toId}" already exists.`); return; }
      const rw = { questId: { from: fromId, to: toId } };
      const next = draft.map((q) => {
        const rewritten = rewriteQuestRefs(q, rw) as QuestWithLayout;
        if (q.id === fromId) {
          rewritten.id = toId;
        }
        if (rewritten.prerequisites) {
          rewritten.prerequisites = rewritten.prerequisites.map((p) => (p === fromId ? toId : p));
        }
        return rewritten;
      });
      setDraft(next);
      if (selectedQuest === fromId) setSelectedQuest(toId);
    },
    [draft, selectedQuest],
  );

  const renameStep = useCallback(
    (questId: string, fromId: string, toId: string) => {
      if (!draft) return;
      if (fromId === toId) return;
      if (!toId.trim()) { window.alert("Step id cannot be empty."); return; }
      const target = draft.find((q) => q.id === questId);
      if (!target) return;
      if (target.steps[toId]) { window.alert(`Step "${toId}" already exists in this quest.`); return; }
      const rw = { step: { questId, from: fromId, to: toId } };
      const next = draft.map((q) => {
        let rewritten = rewriteQuestRefs(q, rw) as QuestWithLayout;
        if (q.id === questId) {
          const nextSteps: Record<string, StepDef> = {};
          for (const [key, s] of Object.entries(rewritten.steps)) {
            const newKey = key === fromId ? toId : key;
            const newStep = key === fromId ? { ...s, id: toId } : s;
            newStep.next = newStep.next.map((e) => (e.goto === fromId ? { ...e, goto: toId } : e));
            nextSteps[newKey] = newStep;
          }
          const nextEntry = rewritten.entry === fromId ? toId : rewritten.entry;
          const nextLayout = { ...(rewritten.editor?.layout ?? {}) };
          if (nextLayout[fromId]) {
            nextLayout[toId] = nextLayout[fromId];
            delete nextLayout[fromId];
          }
          rewritten = {
            ...rewritten,
            steps: nextSteps,
            entry: nextEntry,
            editor: { ...(rewritten.editor ?? {}), layout: nextLayout },
          };
        }
        return rewritten;
      });
      setDraft(next);
      if (selectedQuest === questId && selectedStep === fromId) setSelectedStep(toId);
    },
    [draft, selectedQuest, selectedStep],
  );

  const addQuest = () => {
    if (!draft) return;
    const existing = new Set(draft.map((q) => q.id));
    let n = draft.length + 1;
    while (existing.has(`quest_${n}`)) n++;
    const id = `quest_${n}`;
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
    const layout = quest.editor?.layout ?? {};
    const nodeW = 200;
    const nodeH = 90;
    const gap = 60;
    const taken = new Set(Object.values(layout).map((p) => `${p.x},${p.y}`));
    const nudge = (x: number, y: number): { x: number; y: number } => {
      let cy = y;
      while (taken.has(`${x},${cy}`)) cy += nodeH + gap;
      return { x, y: cy };
    };

    let pos: { x: number; y: number };
    if (selectedStep && layout[selectedStep]) {
      const src = layout[selectedStep];
      pos = nudge(src.x + nodeW + gap, src.y);
    } else if (existing.length === 0) {
      pos = { x: 100, y: 100 };
    } else {
      const maxX = Math.max(...Object.values(layout).map((p) => p.x));
      const rightmost = Object.values(layout).find((p) => p.x === maxX)!;
      pos = nudge(rightmost.x + nodeW + gap, rightmost.y);
    }

    updateQuest({
      steps: { ...quest.steps, [id]: { id, next: [] } },
      editor: {
        ...(quest.editor ?? {}),
        layout: { ...layout, [id]: pos },
      },
    });
    setSelectedStep(id);
  };

  const connectSteps = useCallback(
    (fromKey: string, toKey: string) => {
      if (!quest) return;
      const from = quest.steps[fromKey];
      if (!from) return;
      if (from.next.some((e) => e.goto === toKey && !e.when)) return; // already connected by default
      updateQuest({
        steps: {
          ...quest.steps,
          [fromKey]: { ...from, next: [...from.next, { goto: toKey }] },
        },
      });
    },
    [quest, updateQuest],
  );

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

  // Validation ------------------------------------------------------
  const validate = useCallback((q: QuestWithLayout): string[] => {
    const errs: string[] = [];
    if (!q.id) errs.push("Quest id is required.");
    if (!q.steps[q.entry]) errs.push(`Entry step "${q.entry}" is not defined.`);
    for (const [key, s] of Object.entries(q.steps)) {
      if (s.id !== key) errs.push(`Step key "${key}" does not match inner id "${s.id}".`);
      for (const e of s.next) {
        if (!e.goto) errs.push(`Step ${key}: edge #${s.next.indexOf(e) + 1} has no target.`);
        else if (!q.steps[e.goto]) errs.push(`Step ${key}: edge goes to unknown step "${e.goto}".`);
      }
    }
    for (const pre of q.prerequisites ?? []) {
      if (!(draft ?? []).some((other) => other.id === pre)) {
        errs.push(`Prerequisite "${pre}" does not exist.`);
      }
    }
    return errs;
  }, [draft]);

  const stepErrors = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!quest) return map;
    for (const [key, s] of Object.entries(quest.steps)) {
      const errs: string[] = [];
      if (s.id !== key) errs.push(`id mismatch: "${s.id}"`);
      for (let i = 0; i < s.next.length; i++) {
        const e = s.next[i];
        if (!e.goto) errs.push(`edge #${i + 1} has no target`);
        else if (!quest.steps[e.goto]) errs.push(`edge #${i + 1} → "${e.goto}" (missing)`);
      }
      if (errs.length > 0) map.set(key, errs);
    }
    return map;
  }, [quest]);

  const liveErrors = useMemo(() => {
    if (!draft) return [] as string[];
    const all: string[] = [];
    for (const q of draft) {
      const errs = validate(q);
      for (const e of errs) all.push(`[${q.id}] ${e}`);
    }
    return all;
  }, [draft, validate]);

  // Graph ----------------------------------------------------------
  type QuestGraphNode = GraphNode & { step: StepDef | null; isEntry: boolean; missing?: boolean; stepKey: string };

  const graphNodes: QuestGraphNode[] = useMemo(() => {
    if (!quest) return [];
    const out: QuestGraphNode[] = Object.entries(quest.steps).map(([key, s]) => ({
      id: key,
      stepKey: key,
      x: quest.editor?.layout?.[key]?.x ?? 100,
      y: quest.editor?.layout?.[key]?.y ?? 100,
      width: 200,
      height: 90,
      step: s,
      isEntry: quest.entry === key,
    }));
    // Synthetic ghost nodes for dangling edges so the user can see broken links.
    const existing = new Set(out.map((n) => n.id));
    const ghosts: QuestGraphNode[] = [];
    for (const [key, s] of Object.entries(quest.steps)) {
      for (const e of s.next) {
        if (!e.goto || existing.has(e.goto)) continue;
        const ghostId = `__missing:${e.goto}`;
        if (existing.has(ghostId)) continue;
        existing.add(ghostId);
        const src = quest.editor?.layout?.[key] ?? { x: 100, y: 100 };
        ghosts.push({
          id: ghostId,
          stepKey: ghostId,
          x: src.x + 260,
          y: src.y,
          width: 200,
          height: 60,
          step: null,
          isEntry: false,
          missing: true,
          noConnect: true,
        });
      }
    }
    return [...out, ...ghosts];
  }, [quest]);

  const graphEdges: GraphEdge[] = useMemo(() => {
    if (!quest) return [];
    const out: GraphEdge[] = [];
    for (const [key, s] of Object.entries(quest.steps)) {
      for (let i = 0; i < s.next.length; i++) {
        const e = s.next[i];
        if (!e.goto) continue;
        const exists = !!quest.steps[e.goto];
        out.push({
          id: `${key}[${i}]->${e.goto}`,
          from: key,
          to: exists ? e.goto : `__missing:${e.goto}`,
          label: e.when ? predicateSummary(e.when) : "(default)",
          color: !exists ? "#e06060" : e.when ? "#e0b060" : "#666",
        });
      }
    }
    return out;
  }, [quest]);

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
    setSaveError(null);
    try {
      await file.save({ quests: draft });
      setLastSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  onSaveRef.current = onSave;
  deleteStepRef.current = deleteStep;

  const onReload = () => {
    if (dirty && !window.confirm("Discard unsaved changes and reload from disk?")) return;
    setDraft(null);
    setSelectedQuest(null);
    setSelectedStep(null);
    setValidationErrors([]);
    setSaveError(null);
    file.reload();
  };

  const onJump = () => {
    if (!selectedQuest || !selectedStep) return;
    const url = new URL(window.location.origin + "/");
    url.searchParams.set("questJump", `${selectedQuest}:${selectedStep}`);
    window.open(url.toString(), "_blank");
  };

  const selStep = selectedStep && quest?.steps[selectedStep];

  const [questFilter, setQuestFilter] = useState("");
  const [stepSearch, setStepSearch] = useState("");
  const filteredQuests = useMemo(() => {
    if (!draft) return [];
    const q = questFilter.trim().toLowerCase();
    if (!q) return draft;
    return draft.filter((d) => d.id.toLowerCase().includes(q) || (d.title ?? "").toLowerCase().includes(q));
  }, [draft, questFilter]);

  const questHasErrors = useMemo(() => {
    const set = new Set<string>();
    if (!draft) return set;
    for (const q of draft) {
      if (validate(q).length > 0) set.add(q.id);
    }
    return set;
  }, [draft, validate]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label style={{ fontWeight: 600 }}>Quest:</label>
        <input
          value={questFilter}
          onChange={(e) => setQuestFilter(e.target.value)}
          placeholder="filter…"
          style={{ ...inp, width: 110 }}
          title="Filter quests by id or title"
        />
        <select value={selectedQuest ?? ""} onChange={(e) => { setSelectedQuest(e.target.value); setSelectedStep(null); }} style={sel}>
          {filteredQuests.map((q) => (
            <option key={q.id} value={q.id}>
              {questHasErrors.has(q.id) ? "⚠ " : ""}{q.title || q.id}
            </option>
          ))}
        </select>
        <button onClick={addQuest} style={btn("ghost")} title="Add a new quest">+ Quest</button>
        <button onClick={deleteQuest} disabled={!quest} style={btn("danger")} title="Delete the selected quest">Delete</button>
        <div style={{ flex: 1 }} />
        {lastSavedAt && !dirty && (
          <span style={{ fontSize: 11, color: "#888" }} title={new Date(lastSavedAt).toLocaleString()}>
            saved
          </span>
        )}
        <button
          onClick={undo}
          disabled={history.past.length === 0}
          style={btn("ghost")}
          title="Undo (Ctrl/Cmd+Z)"
        >↶</button>
        <button
          onClick={redo}
          disabled={history.future.length === 0}
          style={btn("ghost")}
          title="Redo (Ctrl/Cmd+Shift+Z)"
        >↷</button>
        <button onClick={onReload} disabled={file.loading} style={btn("ghost")} title="Reload quests.json from disk (discards unsaved changes)">
          Reload
        </button>
        <button
          onClick={onSave}
          disabled={!dirty || file.saving || liveErrors.length > 0}
          style={btn(dirty && !file.saving && liveErrors.length === 0 ? "primary" : "ghost")}
          title={liveErrors.length > 0 ? `${liveErrors.length} validation error(s) — fix them first` : "Validate and write quests.json"}
        >
          {file.saving ? "Saving…" : liveErrors.length > 0 ? `Save (${liveErrors.length} errors)` : "Save"}
        </button>
      </div>

      {file.error && !saveError && (
        <div style={{ padding: 8, background: "#4a1818", border: "1px solid #8a3030", borderRadius: 3, color: "#fbb", fontSize: 12 }}>
          <strong>Load error:</strong> {file.error}
        </div>
      )}

      {saveError && (
        <div style={{ padding: 8, background: "#4a1818", border: "1px solid #8a3030", borderRadius: 3, color: "#fbb", fontSize: 12 }}>
          <strong>Save failed:</strong> {saveError}
        </div>
      )}

      {liveErrors.length > 0 && (
        <details style={{ padding: 8, background: "#4a1818", border: "1px solid #8a3030", borderRadius: 3, color: "#fbb", fontSize: 12 }} open={validationErrors.length > 0}>
          <summary style={{ cursor: "pointer" }}>
            <strong>{liveErrors.length} validation {liveErrors.length === 1 ? "error" : "errors"}</strong> — save is disabled until these are fixed.
          </summary>
          <ul style={{ margin: "4px 0 0 16px" }}>
            {liveErrors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </details>
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
              onConnect={connectSteps}
              renderNode={(gn, selected) => (
                gn.missing ? (
                  <GhostStepBox id={gn.id.replace(/^__missing:/, "")} />
                ) : (
                  <QuestStepBox
                    step={gn.step!}
                    stepKey={gn.stepKey}
                    isEntry={gn.isEntry}
                    selected={selected}
                    errors={stepErrors.get(gn.stepKey)}
                    onMakeEntry={() => updateQuest({ entry: gn.stepKey })}
                  />
                )
              )}
            />
          )}
          <div style={{ position: "absolute", top: 6, left: 6, display: "flex", gap: 4, alignItems: "center" }}>
            <button onClick={addStep} disabled={!quest} style={btn("ghost")} title="Add a step (placed next to the selected step)">+ Step</button>
            {quest && Object.keys(quest.steps).length > 2 && (
              <input
                value={stepSearch}
                onChange={(e) => {
                  const v = e.target.value;
                  setStepSearch(v);
                  if (!v.trim()) return;
                  const q = v.trim().toLowerCase();
                  const match = Object.entries(quest.steps).find(([k, s]) =>
                    k.toLowerCase().includes(q) || (s.title ?? "").toLowerCase().includes(q),
                  );
                  if (match) setSelectedStep(match[0]);
                }}
                placeholder="find step…"
                style={{ ...inp, width: 120 }}
                title="Jump to a step by id or title"
              />
            )}
          </div>
        </div>

        <aside style={{ width: 460, padding: 10, background: "#12121a", border: "1px solid #222", overflow: "auto" }}>
          {quest && !selStep && (
            <QuestMetaEditor
              quest={quest}
              onPatch={updateQuest}
              onRename={(to) => renameQuest(quest.id, to)}
              suggestions={suggestions}
            />
          )}
          {quest && selStep && (
            <StepInspector
              quest={quest}
              step={selStep}
              stepKey={selectedStep!}
              onPatch={(p) => updateStep(selectedStep!, p)}
              onDelete={() => deleteStep(selectedStep!)}
              onRename={(to) => renameStep(quest.id, selectedStep!, to)}
              suggestions={suggestions}
            />
          )}
          <PlaytestPanel quest={quest} selectedStep={selectedStep} onJump={onJump} />
        </aside>
      </div>
    </div>
  );
}

// --- Step box ----------------------------------------------------

function QuestStepBox({ step, stepKey, isEntry, selected, errors, onMakeEntry }: { step: StepDef; stepKey: string; isEntry: boolean; selected: boolean; errors?: string[]; onMakeEntry: () => void }) {
  const terminal = step.next.length === 0;
  const hasErrors = (errors?.length ?? 0) > 0;
  const borderColor = selected
    ? "#ffdd44"
    : hasErrors
      ? "#e06060"
      : isEntry
        ? "#8f8"
        : terminal
          ? "#aa6060"
          : "#4a7fb0";
  return (
    <div
      title={hasErrors ? errors!.join("\n") : undefined}
      style={{
        background: "#161620",
        border: `2px solid ${borderColor}`,
        borderRadius: 4,
        padding: 6,
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>{stepKey}</strong>
        {isEntry ? <span style={{ fontSize: 10, color: "#8f8" }}>ENTRY</span> : terminal ? <span style={{ fontSize: 10, color: "#faa" }}>END</span> : null}
      </div>
      {step.title && <div style={{ color: "#cde" }}>{step.title}</div>}
      {step.completeWhen && <div style={{ color: "#8af", fontSize: 10, marginTop: 2 }}>when: {predicateSummary(step.completeWhen)}</div>}
      {(step.subgoals?.length ?? 0) > 0 && <div style={{ fontSize: 10, color: "#aa8" }}>{step.subgoals!.length} subgoal{step.subgoals!.length === 1 ? "" : "s"}</div>}
      {hasErrors && <div style={{ fontSize: 10, color: "#f88", marginTop: 2 }}>⚠ {errors![0]}{errors!.length > 1 ? ` (+${errors!.length - 1})` : ""}</div>}
      {!isEntry && (
        <button onMouseDown={(e) => e.stopPropagation()} onClick={onMakeEntry} style={{ ...btn("ghost"), fontSize: 10, padding: "1px 4px", marginTop: 2 }} title="Make this the starting step for the quest">
          Set entry
        </button>
      )}
    </div>
  );
}

function GhostStepBox({ id }: { id: string }) {
  return (
    <div
      title={`Edge points at "${id}" but no such step exists. Rename the step or fix the edge target.`}
      style={{
        background: "#2a1616",
        border: "2px dashed #e06060",
        borderRadius: 4,
        padding: 6,
        fontSize: 12,
        color: "#fbb",
      }}
    >
      <div style={{ fontSize: 10, color: "#f88", textTransform: "uppercase", letterSpacing: 0.5 }}>Missing step</div>
      <strong>{id}</strong>
    </div>
  );
}

// --- Quest metadata editor ---------------------------------------

function QuestMetaEditor({ quest, onPatch, onRename, suggestions }: { quest: QuestWithLayout; onPatch: (p: Partial<QuestWithLayout>) => void; onRename: (to: string) => void; suggestions: ReturnType<typeof useSuggestions> }) {
  const handleRename = () => {
    const to = window.prompt("New quest id:", quest.id);
    if (to && to !== quest.id) onRename(to);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h3 style={{ margin: 0 }}>Quest: {quest.id}</h3>
      <Labeled label="id">
        <div style={{ display: "flex", gap: 4 }}>
          <input value={quest.id} readOnly style={{ ...inp, flex: 1, opacity: 0.7 }} title="Use Rename to change the id safely" />
          <button onClick={handleRename} style={btn("ghost")} title="Rename this quest and rewrite all references (prerequisites, predicates, rewards)">Rename…</button>
        </div>
      </Labeled>
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
  stepKey,
  onPatch,
  onDelete,
  onRename,
  suggestions,
}: {
  quest: QuestWithLayout;
  step: StepDef;
  stepKey: string;
  onPatch: (p: Partial<StepDef>) => void;
  onDelete: () => void;
  onRename: (to: string) => void;
  suggestions: ReturnType<typeof useSuggestions>;
}) {
  const stepIds = Object.keys(quest.steps).filter((id) => id !== stepKey);
  const handleRename = () => {
    const to = window.prompt("New step id:", stepKey);
    if (to && to !== stepKey) onRename(to);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>Step: {stepKey}</h3>
        <button onClick={onDelete} style={btn("danger")} title="Delete this step">Delete</button>
      </div>
      <Labeled label="id">
        <div style={{ display: "flex", gap: 4 }}>
          <input value={stepKey} readOnly style={{ ...inp, flex: 1, opacity: 0.7 }} title="Use Rename to change the id safely" />
          <button onClick={handleRename} style={btn("ghost")} title="Rename this step and rewrite edges, predicates, and entry references">Rename…</button>
        </div>
      </Labeled>
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
        <div style={{ fontSize: 12, color: "#ccc", fontWeight: 600, marginBottom: 2 }}>
          next — <span style={{ color: "#e0b060", fontWeight: 400 }}>first matching edge wins</span>
        </div>
        {stepIds.length === 0 && step.next.length > 0 && (
          <div style={{ fontSize: 11, color: "#e0b060", marginBottom: 4 }}>
            No other steps exist yet — add a step, then point these edges at it.
          </div>
        )}
        {step.next.map((e, i) => {
          const brokenTarget = !e.goto || !quest.steps[e.goto];
          return (
            <div key={i} style={{ background: "#141420", border: `1px solid ${brokenTarget ? "#8a3030" : "#2a2a38"}`, padding: 6, borderRadius: 3, marginBottom: 4 }}>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "#888", width: 20 }}>{i + 1}</span>
                <span style={{ fontSize: 11 }}>→</span>
                <select value={e.goto} onChange={(ev) => onPatch({ next: step.next.map((x, j) => j === i ? { ...x, goto: ev.target.value } : x) })} style={sel}>
                  {(!e.goto || !quest.steps[e.goto]) && (
                    <option value={e.goto}>{e.goto ? `${e.goto} (missing)` : "(pick step)"}</option>
                  )}
                  {stepIds.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
                <div style={{ flex: 1 }} />
                <button
                  title="Move up"
                  onClick={() => onPatch({ next: swap(step.next, i, i - 1) })}
                  disabled={i === 0}
                  style={iconBtn}
                >▲</button>
                <button
                  title="Move down"
                  onClick={() => onPatch({ next: swap(step.next, i, i + 1) })}
                  disabled={i === step.next.length - 1}
                  style={iconBtn}
                >▼</button>
                <button title="Remove this edge" onClick={() => onPatch({ next: step.next.filter((_, j) => j !== i) })} style={delBtn}>×</button>
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
          );
        })}
        <button
          onClick={() => onPatch({ next: [...step.next, { goto: stepIds[0] ?? "" }] })}
          style={addBtn}
          title={stepIds.length === 0 ? "No other steps to target — add one first" : "Add a new outgoing edge"}
        >+ edge</button>
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
              <button title="Remove this subgoal" onClick={() => onPatch({ subgoals: (step.subgoals ?? []).filter((_, j) => j !== i) })} style={delBtn}>×</button>
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

function PlaytestPanel({ quest, selectedStep, onJump }: { quest: QuestWithLayout | null; selectedStep: string | null; onJump: () => void }) {
  const [flagKey, setFlagKey] = useState("");
  const [flagValue, setFlagValue] = useState("true");
  const [event, setEvent] = useState("combat:enemyKilled");

  const launch = (params: Record<string, string>) => {
    const url = new URL(window.location.origin + "/");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    window.open(url.toString(), "_blank");
  };

  return (
    <details style={{ marginTop: 16 }} open={!!quest}>
      <summary style={{ fontWeight: 600, cursor: "pointer" }}>Playtest controls</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        {quest && (
          <div>
            <div style={{ fontSize: 11, color: "#888" }}>Jump into this quest</div>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "#ccc", flex: 1 }}>
                {selectedStep ? `${quest.id} → ${selectedStep}` : "(select a step in the graph first)"}
              </span>
              <button onClick={onJump} disabled={!selectedStep} style={btn("ghost")} title="Open the game in a new tab with this quest jumped to the selected step">Jump ▶</button>
            </div>
          </div>
        )}
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
      </div>
    </details>
  );
}

// --- Helpers -----------------------------------------------------

function swap<T>(arr: T[], i: number, j: number): T[] {
  if (i < 0 || j < 0 || i >= arr.length || j >= arr.length || i === j) return arr;
  const out = arr.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
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
