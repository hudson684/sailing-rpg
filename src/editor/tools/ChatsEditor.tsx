import { useCallback, useEffect, useState } from "react";
import { get, set, keys } from "idb-keyval";
import {
  SaveEnvelopeSchema,
  isSlotKey,
  type SaveEnvelope,
} from "../../game/save/envelope";
import { kvStore } from "../../game/save/store/idbShared";
import { chatIndex } from "../../game/sim/chat/chatIndex";
import { chatCooldownStore } from "../../game/sim/chat/chatStore";

interface SlotSummary {
  slotKey: string;
  envelope: SaveEnvelope;
  cooldownCount: number;
}

async function loadAllSlots(): Promise<SlotSummary[]> {
  const allKeys = (await keys(kvStore)) as string[];
  const out: SlotSummary[] = [];
  for (const k of allKeys) {
    if (!isSlotKey(k)) continue;
    const raw = await get(k, kvStore);
    const parsed = SaveEnvelopeSchema.safeParse(raw);
    if (!parsed.success) continue;
    const env = parsed.data;
    const block = env.systems["chatCooldowns"];
    let count = 0;
    if (block && typeof block.data === "object" && block.data !== null) {
      const lp = (block.data as { lastPlayed?: Record<string, number> }).lastPlayed;
      count = lp ? Object.keys(lp).length : 0;
    }
    out.push({ slotKey: k, envelope: env, cooldownCount: count });
  }
  out.sort((a, b) => (a.slotKey < b.slotKey ? -1 : 1));
  return out;
}

async function clearAllCooldowns(slots: SlotSummary[]): Promise<void> {
  for (const s of slots) {
    const env = s.envelope;
    const next: SaveEnvelope = {
      ...env,
      updatedAt: Date.now(),
      systems: {
        ...env.systems,
        chatCooldowns: { version: 1, data: { lastPlayed: {} } },
      },
    };
    await set(s.slotKey, next, kvStore);
  }
  // Also wipe the in-process map so a tab that's not been reloaded
  // (rare in editor flow but possible) sees the change.
  chatCooldownStore.restore({ lastPlayed: {} });
}

export function ChatsEditor() {
  const [slots, setSlots] = useState<SlotSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setSlots(await loadAllSlots());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onReset = useCallback(async () => {
    if (!slots) return;
    setBusy(true);
    setStatus(null);
    try {
      await clearAllCooldowns(slots);
      await refresh();
      setStatus(`Cleared cooldowns from ${slots.length} slot${slots.length === 1 ? "" : "s"}. Reload the game to see chats fire again.`);
    } catch (err) {
      setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [slots, refresh]);

  return (
    <div style={{ padding: 16, overflow: "auto", height: "100%" }}>
      <h2 style={{ marginTop: 0 }}>Ambient chats</h2>
      <p style={{ color: "#aaa", marginTop: 0 }}>
        Cooldowns are persisted per save slot. Resetting clears the
        <code style={{ margin: "0 4px" }}>chatCooldowns</code> block on every slot;
        the next time the game loads, every chat is eligible again.
      </p>

      <button
        type="button"
        onClick={onReset}
        disabled={busy || !slots}
        style={{
          padding: "8px 14px",
          background: "#3a2a18",
          color: "#f1d6ac",
          border: "1px solid #6a3a1f",
          borderRadius: 4,
          cursor: busy ? "wait" : "pointer",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {busy ? "Resetting…" : "Reset all chat cooldowns"}
      </button>
      {status && (
        <div style={{ marginTop: 12, color: "#9bce9b", fontSize: 12 }}>{status}</div>
      )}

      <h3 style={{ marginTop: 24 }}>Save slots</h3>
      {slots === null ? (
        <div style={{ color: "#888" }}>Loading…</div>
      ) : slots.length === 0 ? (
        <div style={{ color: "#888" }}>No save slots found.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#999" }}>
              <th style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>Slot</th>
              <th style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>Day</th>
              <th style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>Cooldowns</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((s) => {
              const tb = s.envelope.systems["time"];
              const day = tb && typeof tb.data === "object" && tb.data !== null
                ? (tb.data as { dayCount?: number }).dayCount ?? "—"
                : "—";
              return (
                <tr key={s.slotKey}>
                  <td style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>
                    {s.slotKey.replace(/^save:/, "")}
                  </td>
                  <td style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>{String(day)}</td>
                  <td style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>{s.cooldownCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: 24 }}>Defined chats ({chatIndex.all.length})</h3>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#999" }}>
            <th style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>id</th>
            <th style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>scene</th>
            <th style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>cooldown (days)</th>
            <th style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>proximity</th>
            <th style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>lines</th>
          </tr>
        </thead>
        <tbody>
          {chatIndex.all.map((def) => (
            <tr key={def.id}>
              <td style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>{def.id}</td>
              <td style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32", color: "#aaa" }}>
                {def.where?.scene ?? "(any)"}
              </td>
              <td style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>{def.cooldownDays}</td>
              <td style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>{def.proximityTiles}</td>
              <td style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a32" }}>{def.lines.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
