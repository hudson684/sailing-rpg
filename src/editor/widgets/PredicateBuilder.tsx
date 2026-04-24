import React from "react";
import type { Predicate, QuestEvent, EventMatch, FlagValue } from "../../game/quests/types";
import { predicateSummary } from "./predicateUtils";

/**
 * Predicate builder widget. Shared by the dialogue, quest, and
 * (eventually) spawn-gating editors. Autocomplete sources come from
 * the loaded data registries (passed in as `suggestions`).
 */

export interface PredicateSuggestions {
  items: string[];
  jobs: string[];
  maps: string[];
  npcs: string[];
  enemies: string[];
  nodes: string[];
  dialogues: string[];
  cutscenes: string[];
  quests: string[];
  flags: string[];
}

export const EMPTY_SUGGESTIONS: PredicateSuggestions = {
  items: [],
  jobs: [],
  maps: [],
  npcs: [],
  enemies: [],
  nodes: [],
  dialogues: [],
  cutscenes: [],
  quests: [],
  flags: [],
};

const EVENT_KINDS: QuestEvent[] = [
  "combat:enemyKilled",
  "gathering:nodeHarvested",
  "gathering:nodeHit",
  "fishing:caught",
  "crafting:complete",
  "jobs:xpGained",
  "world:mapEntered",
  "player:tileEntered",
  "npc:interacted",
  "dialogue:ended",
  "shop:purchased",
  "flags:changed",
];

const PREDICATE_KINDS: Predicate["kind"][] = [
  "event",
  "flag",
  "quest",
  "step",
  "hasItem",
  "jobLevel",
  "sceneMap",
  "and",
  "or",
  "not",
];

export interface PredicateBuilderProps {
  value: Predicate | undefined;
  onChange: (next: Predicate | undefined) => void;
  suggestions: PredicateSuggestions;
  /** Nesting depth — used to indent folded groups. */
  depth?: number;
  /** If true, the "clear" button is hidden (top-level builders set this
   *  to force the user to pick something). */
  required?: boolean;
}

export function PredicateBuilder({ value, onChange, suggestions, depth = 0, required = false }: PredicateBuilderProps) {
  if (!value) {
    return (
      <div style={row(depth)}>
        <button onClick={() => onChange({ kind: "flag", key: "" })} style={addBtn}>
          + Add predicate
        </button>
      </div>
    );
  }

  return (
    <div style={row(depth)}>
      <select
        value={value.kind}
        onChange={(e) => onChange(changeKind(value, e.target.value as Predicate["kind"]))}
        style={sel}
      >
        {PREDICATE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>

      {value.kind === "event" && (
        <EventFields value={value} onChange={onChange} suggestions={suggestions} />
      )}
      {value.kind === "flag" && (
        <FlagFields value={value} onChange={onChange} suggestions={suggestions} />
      )}
      {value.kind === "quest" && (
        <QuestFields value={value} onChange={onChange} suggestions={suggestions} />
      )}
      {value.kind === "step" && (
        <StepFields value={value} onChange={onChange} suggestions={suggestions} />
      )}
      {value.kind === "hasItem" && (
        <HasItemFields value={value} onChange={onChange} suggestions={suggestions} />
      )}
      {value.kind === "jobLevel" && (
        <JobLevelFields value={value} onChange={onChange} suggestions={suggestions} />
      )}
      {value.kind === "sceneMap" && (
        <SceneMapFields value={value} onChange={onChange} suggestions={suggestions} />
      )}
      {(value.kind === "and" || value.kind === "or") && (
        <GroupFields value={value} onChange={onChange} suggestions={suggestions} depth={depth + 1} />
      )}
      {value.kind === "not" && (
        <NotFields value={value} onChange={onChange} suggestions={suggestions} depth={depth + 1} />
      )}

      <span style={chip} title="Human-readable summary of this predicate">
        {predicateSummary(value)}
      </span>

      {!required && (
        <button onClick={() => onChange(undefined)} style={delBtn} title="Remove predicate">
          ×
        </button>
      )}
    </div>
  );
}

// Kind-specific field groups --------------------------------------

function EventFields({
  value,
  onChange,
  suggestions,
}: { value: Extract<Predicate, { kind: "event" }>; onChange: (p: Predicate) => void; suggestions: PredicateSuggestions }) {
  const setMatch = (patch: Partial<EventMatch>) =>
    onChange({ ...value, match: { ...(value.match ?? {}), ...patch } });
  return (
    <>
      <select value={value.event} onChange={(e) => onChange({ ...value, event: e.target.value as QuestEvent })} style={sel}>
        {EVENT_KINDS.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
      </select>
      {needsField(value.event, "enemyDefId") && (
        <AutoInput placeholder="enemyDefId" value={value.match?.enemyDefId ?? ""} onChange={(v) => setMatch({ enemyDefId: v || undefined })} suggestions={suggestions.enemies} />
      )}
      {needsField(value.event, "nodeDefId") && (
        <AutoInput placeholder="nodeDefId" value={value.match?.nodeDefId ?? ""} onChange={(v) => setMatch({ nodeDefId: v || undefined })} suggestions={suggestions.nodes} />
      )}
      {needsField(value.event, "itemId") && (
        <AutoInput placeholder="itemId" value={value.match?.itemId ?? ""} onChange={(v) => setMatch({ itemId: v || undefined })} suggestions={suggestions.items} />
      )}
      {needsField(value.event, "mapId") && (
        <AutoInput placeholder="mapId" value={value.match?.mapId ?? ""} onChange={(v) => setMatch({ mapId: v || undefined })} suggestions={suggestions.maps} />
      )}
      {needsField(value.event, "npcId") && (
        <AutoInput placeholder="npcId" value={value.match?.npcId ?? ""} onChange={(v) => setMatch({ npcId: v || undefined })} suggestions={suggestions.npcs} />
      )}
      {needsField(value.event, "dialogueId") && (
        <AutoInput placeholder="dialogueId" value={value.match?.dialogueId ?? ""} onChange={(v) => setMatch({ dialogueId: v || undefined })} suggestions={suggestions.dialogues} />
      )}
      {needsField(value.event, "dialogueEndNodeId") && (
        <input placeholder="endNodeId" value={value.match?.dialogueEndNodeId ?? ""} onChange={(e) => setMatch({ dialogueEndNodeId: e.target.value || undefined })} style={inp} />
      )}
      {needsField(value.event, "jobId") && (
        <AutoInput placeholder="jobId" value={value.match?.jobId ?? ""} onChange={(v) => setMatch({ jobId: v || undefined })} suggestions={suggestions.jobs} />
      )}
      {needsField(value.event, "flagKey") && (
        <AutoInput placeholder="flagKey" value={value.match?.flagKey ?? ""} onChange={(v) => setMatch({ flagKey: v || undefined })} suggestions={suggestions.flags} />
      )}
      {needsField(value.event, "minQuantity") && (
        <input type="number" placeholder="minQty" value={value.match?.minQuantity ?? ""} onChange={(e) => setMatch({ minQuantity: e.target.value ? Number(e.target.value) : undefined })} style={{ ...inp, width: 70 }} />
      )}
    </>
  );
}

function needsField(event: QuestEvent, field: keyof EventMatch): boolean {
  const map: Record<QuestEvent, Array<keyof EventMatch>> = {
    "combat:enemyKilled": ["enemyDefId", "mapId"],
    "gathering:nodeHarvested": ["nodeDefId", "mapId", "itemId", "minQuantity"],
    "gathering:nodeHit": ["nodeDefId", "mapId"],
    "fishing:caught": ["itemId", "mapId", "tier"],
    "crafting:complete": ["itemId", "tier", "minQuantity"],
    "jobs:xpGained": ["jobId"],
    "world:mapEntered": ["mapId"],
    "player:tileEntered": ["mapId"],
    "npc:interacted": ["npcId", "mapId"],
    "dialogue:ended": ["dialogueId", "dialogueEndNodeId"],
    "shop:purchased": ["itemId", "minQuantity"],
    "flags:changed": ["flagKey"],
  };
  return map[event]?.includes(field) ?? false;
}

function FlagFields({ value, onChange, suggestions }: { value: Extract<Predicate, { kind: "flag" }>; onChange: (p: Predicate) => void; suggestions: PredicateSuggestions }) {
  return (
    <>
      <AutoInput placeholder="flag key" value={value.key} onChange={(v) => onChange({ ...value, key: v })} suggestions={suggestions.flags} />
      <select
        value={value.exists !== undefined ? "exists" : "equals"}
        onChange={(e) => {
          if (e.target.value === "exists") onChange({ kind: "flag", key: value.key, exists: true });
          else onChange({ kind: "flag", key: value.key, equals: value.equals ?? true });
        }}
        style={sel}
      >
        <option value="equals">equals</option>
        <option value="exists">exists</option>
      </select>
      {value.exists === undefined && (
        <FlagValueInput value={value.equals} onChange={(v) => onChange({ ...value, equals: v })} />
      )}
    </>
  );
}

function FlagValueInput({ value, onChange }: { value: FlagValue | undefined; onChange: (v: FlagValue) => void }) {
  const type = typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";
  return (
    <>
      <select value={type} onChange={(e) => {
        const t = e.target.value;
        if (t === "boolean") onChange(true);
        else if (t === "number") onChange(0);
        else onChange("");
      }} style={sel}>
        <option value="boolean">bool</option>
        <option value="number">num</option>
        <option value="string">str</option>
      </select>
      {typeof value === "boolean" ? (
        <select value={String(value)} onChange={(e) => onChange(e.target.value === "true")} style={sel}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : typeof value === "number" ? (
        <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ ...inp, width: 80 }} />
      ) : (
        <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} style={inp} />
      )}
    </>
  );
}

function QuestFields({ value, onChange, suggestions }: { value: Extract<Predicate, { kind: "quest" }>; onChange: (p: Predicate) => void; suggestions: PredicateSuggestions }) {
  return (
    <>
      <AutoInput placeholder="questId" value={value.questId} onChange={(v) => onChange({ ...value, questId: v })} suggestions={suggestions.quests} />
      <select value={value.status} onChange={(e) => onChange({ ...value, status: e.target.value as typeof value.status })} style={sel}>
        {["started", "completed", "notStarted", "active"].map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </>
  );
}

function StepFields({ value, onChange, suggestions }: { value: Extract<Predicate, { kind: "step" }>; onChange: (p: Predicate) => void; suggestions: PredicateSuggestions }) {
  return (
    <>
      <AutoInput placeholder="questId" value={value.questId} onChange={(v) => onChange({ ...value, questId: v })} suggestions={suggestions.quests} />
      <input placeholder="stepId" value={value.stepId} onChange={(e) => onChange({ ...value, stepId: e.target.value })} style={inp} />
      <select value={value.status} onChange={(e) => onChange({ ...value, status: e.target.value as typeof value.status })} style={sel}>
        {["entered", "completed"].map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </>
  );
}

function HasItemFields({ value, onChange, suggestions }: { value: Extract<Predicate, { kind: "hasItem" }>; onChange: (p: Predicate) => void; suggestions: PredicateSuggestions }) {
  return (
    <>
      <AutoInput placeholder="itemId" value={value.itemId} onChange={(v) => onChange({ ...value, itemId: v })} suggestions={suggestions.items} />
      <input type="number" placeholder="min" value={value.min ?? 1} onChange={(e) => onChange({ ...value, min: Number(e.target.value) })} style={{ ...inp, width: 70 }} />
    </>
  );
}

function JobLevelFields({ value, onChange, suggestions }: { value: Extract<Predicate, { kind: "jobLevel" }>; onChange: (p: Predicate) => void; suggestions: PredicateSuggestions }) {
  return (
    <>
      <AutoInput placeholder="jobId" value={value.jobId} onChange={(v) => onChange({ ...value, jobId: v })} suggestions={suggestions.jobs} />
      <input type="number" placeholder="min level" value={value.min} onChange={(e) => onChange({ ...value, min: Number(e.target.value) })} style={{ ...inp, width: 80 }} />
    </>
  );
}

function SceneMapFields({ value, onChange, suggestions }: { value: Extract<Predicate, { kind: "sceneMap" }>; onChange: (p: Predicate) => void; suggestions: PredicateSuggestions }) {
  return <AutoInput placeholder="mapId" value={value.mapId} onChange={(v) => onChange({ ...value, mapId: v })} suggestions={suggestions.maps} />;
}

function GroupFields({ value, onChange, suggestions, depth }: { value: Extract<Predicate, { kind: "and" | "or" }>; onChange: (p: Predicate) => void; suggestions: PredicateSuggestions; depth: number }) {
  const list = value.kind === "and" ? value.all : value.any;
  const setList = (next: Predicate[]) =>
    onChange(value.kind === "and" ? { kind: "and", all: next } : { kind: "or", any: next });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 12, borderLeft: "2px solid #333", marginTop: 4 }}>
      {list.length === 0 && (
        <div style={{ fontSize: 10, color: "#888", fontStyle: "italic" }}>
          empty — {value.kind === "and" ? "always true" : "always false"}
        </div>
      )}
      {list.map((p, i) => (
        <PredicateBuilder
          key={i}
          value={p}
          onChange={(next) => {
            if (!next) {
              setList(list.filter((_, j) => j !== i));
            } else {
              setList(list.map((q, j) => (j === i ? next : q)));
            }
          }}
          suggestions={suggestions}
          depth={depth}
        />
      ))}
      <button onClick={() => setList([...list, { kind: "flag", key: "" }])} style={addBtn}>
        + Add child
      </button>
    </div>
  );
}

function NotFields({ value, onChange, suggestions, depth }: { value: Extract<Predicate, { kind: "not" }>; onChange: (p: Predicate) => void; suggestions: PredicateSuggestions; depth: number }) {
  return (
    <div style={{ paddingLeft: 12, borderLeft: "2px solid #333", marginTop: 4 }}>
      <PredicateBuilder
        value={value.predicate}
        onChange={(next) => {
          if (!next) onChange({ kind: "not", predicate: { kind: "flag", key: "" } });
          else onChange({ kind: "not", predicate: next });
        }}
        suggestions={suggestions}
        depth={depth}
        required
      />
    </div>
  );
}

function changeKind(current: Predicate, newKind: Predicate["kind"]): Predicate {
  if (current.kind === newKind) return current;
  // Carry over fields that make sense in the new kind so a misclick on
  // the kind dropdown doesn't wipe what the user typed.
  const c = current as unknown as Record<string, unknown>;
  const str = (k: string): string => (typeof c[k] === "string" ? (c[k] as string) : "");
  const num = (k: string, d: number): number => (typeof c[k] === "number" ? (c[k] as number) : d);
  const matchField = (k: string): string => {
    const m = c.match as Record<string, unknown> | undefined;
    const v = m?.[k];
    return typeof v === "string" ? v : "";
  };
  const questId: string = str("questId");
  const itemId: string = str("itemId") || matchField("itemId");
  const jobId: string = str("jobId") || matchField("jobId");
  const mapId: string = str("mapId") || matchField("mapId");
  const flagKey: string = str("key") || matchField("flagKey");

  switch (newKind) {
    case "event":
      return { kind: "event", event: "world:mapEntered" };
    case "flag":
      return { kind: "flag", key: flagKey };
    case "quest":
      return { kind: "quest", questId, status: "completed" };
    case "step":
      return { kind: "step", questId, stepId: str("stepId"), status: "completed" };
    case "hasItem":
      return { kind: "hasItem", itemId, min: num("min", 1) };
    case "jobLevel":
      return { kind: "jobLevel", jobId, min: num("min", 1) };
    case "sceneMap":
      return { kind: "sceneMap", mapId };
    case "and":
      return { kind: "and", all: current.kind === "or" ? current.any : [] };
    case "or":
      return { kind: "or", any: current.kind === "and" ? current.all : [] };
    case "not":
      return { kind: "not", predicate: current.kind === "not" ? current.predicate : { kind: "flag", key: "" } };
  }
}

// Autocomplete input ----------------------------------------------

function AutoInput({
  placeholder,
  value,
  onChange,
  suggestions,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
}) {
  const listId = `auto-${placeholder.replace(/[^a-z]/gi, "")}`;
  return (
    <>
      <input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        style={{ ...inp, width: 140 }}
      />
      <datalist id={listId}>
        {suggestions.map((s) => <option key={s} value={s} />)}
      </datalist>
    </>
  );
}

// Styles -----------------------------------------------------------

const row = (depth: number): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 4,
  padding: 4,
  background: depth % 2 === 0 ? "#141420" : "#1a1a26",
  border: "1px solid #2a2a38",
  borderRadius: 3,
});

const sel: React.CSSProperties = {
  padding: "2px 4px",
  background: "#0c0c14",
  color: "inherit",
  border: "1px solid #333",
  font: "inherit",
  fontSize: 11,
};

const inp: React.CSSProperties = {
  padding: "2px 6px",
  background: "#0c0c14",
  color: "inherit",
  border: "1px solid #333",
  font: "inherit",
  fontSize: 11,
  width: 100,
};

const addBtn: React.CSSProperties = {
  padding: "2px 8px",
  background: "transparent",
  color: "#8af",
  border: "1px dashed #446",
  font: "inherit",
  fontSize: 11,
  cursor: "pointer",
  borderRadius: 3,
};

const delBtn: React.CSSProperties = {
  padding: "0 6px",
  background: "transparent",
  color: "#f88",
  border: "none",
  cursor: "pointer",
  fontSize: 14,
};

const chip: React.CSSProperties = {
  padding: "1px 6px",
  background: "#0c0c14",
  color: "#8af",
  border: "1px solid #333",
  borderRadius: 10,
  fontSize: 10,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: 200,
};
