import React from "react";
import type { Reward } from "../../game/quests/types";
import type { PredicateSuggestions } from "./PredicateBuilder";

const KINDS: Reward["kind"][] = [
  "grantItem",
  "grantXp",
  "setFlag",
  "clearFlag",
  "playCutscene",
  "unlockQuest",
  "startQuest",
  "completeQuest",
];

export function RewardListBuilder({
  value,
  onChange,
  suggestions,
}: {
  value: Reward[] | undefined;
  onChange: (next: Reward[] | undefined) => void;
  suggestions: PredicateSuggestions;
}) {
  const list = value ?? [];
  const set = (next: Reward[]) => onChange(next.length > 0 ? next : undefined);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {list.map((r, i) => (
        <RewardRow
          key={i}
          value={r}
          suggestions={suggestions}
          onChange={(next) => set(list.map((x, j) => (j === i ? next : x)))}
          onDelete={() => set(list.filter((_, j) => j !== i))}
        />
      ))}
      <button
        onClick={() => set([...list, { kind: "setFlag", key: "", value: true }])}
        style={{
          padding: "2px 8px",
          background: "transparent",
          color: "#8af",
          border: "1px dashed #446",
          font: "inherit",
          fontSize: 11,
          cursor: "pointer",
          borderRadius: 3,
          alignSelf: "flex-start",
        }}
      >
        + Add reward
      </button>
    </div>
  );
}

function RewardRow({
  value,
  onChange,
  onDelete,
  suggestions,
}: {
  value: Reward;
  onChange: (next: Reward) => void;
  onDelete: () => void;
  suggestions: PredicateSuggestions;
}) {
  return (
    <div style={row}>
      <select
        value={value.kind}
        onChange={(e) => onChange(changeKind(value, e.target.value as Reward["kind"]))}
        style={sel}
      >
        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      {value.kind === "grantItem" && (
        <>
          <Auto placeholder="itemId" value={value.itemId} onChange={(v) => onChange({ ...value, itemId: v })} suggestions={suggestions.items} />
          <input type="number" value={value.quantity} onChange={(e) => onChange({ ...value, quantity: Number(e.target.value) })} style={{ ...inp, width: 60 }} />
        </>
      )}
      {value.kind === "grantXp" && (
        <>
          <Auto placeholder="jobId" value={value.jobId} onChange={(v) => onChange({ ...value, jobId: v })} suggestions={suggestions.jobs} />
          <input type="number" placeholder="xp" value={value.amount} onChange={(e) => onChange({ ...value, amount: Number(e.target.value) })} style={{ ...inp, width: 80 }} />
        </>
      )}
      {value.kind === "setFlag" && (
        <>
          <Auto placeholder="flag key" value={value.key} onChange={(v) => onChange({ ...value, key: v })} suggestions={suggestions.flags} />
          <FlagValueInput value={value.value} onChange={(v) => onChange({ ...value, value: v })} />
        </>
      )}
      {value.kind === "clearFlag" && (
        <Auto placeholder="flag key" value={value.key} onChange={(v) => onChange({ ...value, key: v })} suggestions={suggestions.flags} />
      )}
      {value.kind === "playCutscene" && (
        <Auto placeholder="cutscene id" value={value.id} onChange={(v) => onChange({ ...value, id: v })} suggestions={suggestions.cutscenes} />
      )}
      {(value.kind === "unlockQuest" || value.kind === "startQuest" || value.kind === "completeQuest") && (
        <Auto placeholder="questId" value={value.questId} onChange={(v) => onChange({ ...value, questId: v })} suggestions={suggestions.quests} />
      )}
      <button onClick={onDelete} style={delBtn} title="Remove">×</button>
    </div>
  );
}

function FlagValueInput({ value, onChange }: { value: boolean | number | string; onChange: (v: boolean | number | string) => void }) {
  const type = typeof value;
  return (
    <>
      <select value={type} onChange={(e) => {
        if (e.target.value === "boolean") onChange(true);
        else if (e.target.value === "number") onChange(0);
        else onChange("");
      }} style={sel}>
        <option value="boolean">bool</option>
        <option value="number">num</option>
        <option value="string">str</option>
      </select>
      {type === "boolean" ? (
        <select value={String(value)} onChange={(e) => onChange(e.target.value === "true")} style={sel}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : type === "number" ? (
        <input type="number" value={value as number} onChange={(e) => onChange(Number(e.target.value))} style={{ ...inp, width: 70 }} />
      ) : (
        <input value={value as string} onChange={(e) => onChange(e.target.value)} style={inp} />
      )}
    </>
  );
}

function changeKind(current: Reward, k: Reward["kind"]): Reward {
  if (current.kind === k) return current;
  switch (k) {
    case "grantItem": return { kind: "grantItem", itemId: "", quantity: 1 };
    case "grantXp": return { kind: "grantXp", jobId: "", amount: 10 };
    case "setFlag": return { kind: "setFlag", key: "", value: true };
    case "clearFlag": return { kind: "clearFlag", key: "" };
    case "playCutscene": return { kind: "playCutscene", id: "" };
    case "unlockQuest": return { kind: "unlockQuest", questId: "" };
    case "startQuest": return { kind: "startQuest", questId: "" };
    case "completeQuest": return { kind: "completeQuest", questId: "" };
  }
}

function Auto({ placeholder, value, onChange, suggestions }: { placeholder: string; value: string; onChange: (v: string) => void; suggestions: string[] }) {
  const id = `rw-${placeholder.replace(/[^a-z]/gi, "")}`;
  return (
    <>
      <input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} list={id} style={{ ...inp, width: 140 }} />
      <datalist id={id}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
    </>
  );
}

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: 4,
  background: "#141420",
  border: "1px solid #2a2a38",
  borderRadius: 3,
};

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

const delBtn: React.CSSProperties = {
  padding: "0 6px",
  background: "transparent",
  color: "#f88",
  border: "none",
  cursor: "pointer",
  fontSize: 14,
};
