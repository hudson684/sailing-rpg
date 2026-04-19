import { useEffect, useMemo, useState } from "react";
import {
  bus,
  type EditClick,
  type EditEntityKind,
  type EditShopEntry,
  type EditSnapshot,
  type EditState,
} from "../game/bus";
import "./EditMode.css";

type Tool =
  | { kind: "select" }
  | { kind: "place"; entity: EditEntityKind; defId: string };

interface Selection {
  kind: EditEntityKind;
  id: string;
}

export function EditMode() {
  const [active, setActive] = useState(false);
  const [snapshot, setSnapshot] = useState<EditSnapshot | null>(null);
  const [tool, setTool] = useState<Tool>({ kind: "select" });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [shopDraft, setShopDraft] = useState<EditShopEntry | null>(null);

  // Subscribe to scene state.
  useEffect(() => {
    const onState = (s: EditState) => {
      setActive(s.active);
      setSnapshot(s.snapshot);
      if (!s.active) {
        setSelection(null);
        setTool({ kind: "select" });
        setShopDraft(null);
      }
    };
    const onClick = (click: EditClick) => {
      if (tool.kind === "place") {
        bus.emitTyped("edit:place", {
          kind: tool.entity,
          defId: tool.defId,
          tileX: click.tileX,
          tileY: click.tileY,
        });
        return;
      }
      // Select tool: if clicked entity, select it; otherwise move current.
      if (click.hit) {
        setSelection(click.hit);
      } else if (selection) {
        bus.emitTyped("edit:move", {
          kind: selection.kind,
          id: selection.id,
          tileX: click.tileX,
          tileY: click.tileY,
        });
      }
    };
    const onExport = (payload: { files: Array<{ name: string; content: string }> }) => {
      void saveToDisk(payload.files);
    };
    bus.onTyped("edit:state", onState);
    bus.onTyped("edit:click", onClick);
    bus.onTyped("edit:export", onExport);
    return () => {
      bus.offTyped("edit:state", onState);
      bus.offTyped("edit:click", onClick);
      bus.offTyped("edit:export", onExport);
    };
  }, [tool, selection]);

  const selected = useMemo(() => findSelected(snapshot, selection), [snapshot, selection]);

  // When the selected entity is an NPC with a shopId, mirror the shop into a
  // local draft so the inspector can edit rows without round-tripping every keystroke.
  useEffect(() => {
    if (!snapshot) return setShopDraft(null);
    const shopId = selected?.kind === "npc" ? selected.npc?.shopId : undefined;
    if (!shopId) return setShopDraft(null);
    const shop = snapshot.shops.find((s) => s.id === shopId);
    if (!shop) return setShopDraft(null);
    setShopDraft({ ...shop, stock: shop.stock.map((r) => ({ ...r })) });
  }, [snapshot, selected]);

  if (!active || !snapshot) return null;

  return (
    <div className="edit-mode-root">
      <div className="edit-rail edit-rail-left">
        <div className="edit-section-title">Tools</div>
        <button
          className={`edit-btn ${tool.kind === "select" ? "active" : ""}`}
          onClick={() => setTool({ kind: "select" })}
        >
          Select / Move
        </button>

        <div className="edit-section-title">Place</div>
        <PlacePicker
          label="NPC"
          options={snapshot.defs.npcs}
          tool={tool}
          entity="npc"
          onPick={(defId) => setTool({ kind: "place", entity: "npc", defId })}
        />
        <PlacePicker
          label="Enemy"
          options={snapshot.defs.enemies}
          tool={tool}
          entity="enemy"
          onPick={(defId) => setTool({ kind: "place", entity: "enemy", defId })}
        />
        <PlacePicker
          label="Node"
          options={snapshot.defs.nodes}
          tool={tool}
          entity="node"
          onPick={(defId) => setTool({ kind: "place", entity: "node", defId })}
        />
        <PlacePicker
          label="Item"
          options={snapshot.defs.items}
          tool={tool}
          entity="item"
          onPick={(defId) => setTool({ kind: "place", entity: "item", defId })}
        />

        <div className="edit-section-title">Save</div>
        <button
          className="edit-btn primary"
          onClick={() => bus.emitTyped("edit:requestExport")}
        >
          Save to src/game/data/
        </button>
        <button className="edit-btn" onClick={() => bus.emitTyped("edit:toggle")}>
          Exit Edit Mode (F7)
        </button>
        <div className="edit-hint">
          Writes via dev-server endpoint. Vite HMR will reload the world.
        </div>
      </div>

      <div className="edit-rail edit-rail-right">
        <div className="edit-section-title">Inspector</div>
        {selected ? (
          <Inspector
            selected={selected}
            shopDraft={shopDraft}
            setShopDraft={setShopDraft}
            itemDefs={snapshot.defs.items}
            onDelete={() => {
              bus.emitTyped("edit:delete", { kind: selection!.kind, id: selection!.id });
              setSelection(null);
            }}
            onCommitShop={() => {
              if (!shopDraft) return;
              bus.emitTyped("edit:shopUpdate", {
                shopId: shopDraft.id,
                stock: shopDraft.stock,
              });
            }}
          />
        ) : (
          <div className="edit-empty">
            {tool.kind === "place"
              ? `Click the world to place a ${tool.entity}.`
              : "Click an entity to select it. With one selected, click empty space to move it."}
          </div>
        )}
      </div>
    </div>
  );
}

interface PlacePickerProps {
  label: string;
  entity: EditEntityKind;
  options: Array<{ id: string; name: string }>;
  tool: Tool;
  onPick: (defId: string) => void;
}

function PlacePicker({ label, entity, options, tool, onPick }: PlacePickerProps) {
  const isActiveEntity = tool.kind === "place" && tool.entity === entity;
  const value = isActiveEntity ? tool.defId : "";
  return (
    <div className="edit-place-row">
      <label>{label}</label>
      <select
        value={value}
        onChange={(e) => onPick(e.target.value)}
        className={isActiveEntity ? "active" : ""}
      >
        <option value="" disabled>
          Pick a {label.toLowerCase()}…
        </option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

interface SelectedEntity {
  kind: EditEntityKind;
  npc?: EditSnapshot["npcs"][number];
  enemy?: EditSnapshot["enemies"][number];
  node?: EditSnapshot["nodes"][number];
  item?: EditSnapshot["items"][number];
}

function findSelected(
  snapshot: EditSnapshot | null,
  selection: Selection | null,
): SelectedEntity | null {
  if (!snapshot || !selection) return null;
  if (selection.kind === "npc") {
    const npc = snapshot.npcs.find((n) => n.id === selection.id);
    return npc ? { kind: "npc", npc } : null;
  }
  if (selection.kind === "enemy") {
    const enemy = snapshot.enemies.find((e) => e.id === selection.id);
    return enemy ? { kind: "enemy", enemy } : null;
  }
  if (selection.kind === "node") {
    const node = snapshot.nodes.find((n) => n.id === selection.id);
    return node ? { kind: "node", node } : null;
  }
  const item = snapshot.items.find((i) => i.id === selection.id);
  return item ? { kind: "item", item } : null;
}

interface InspectorProps {
  selected: SelectedEntity;
  shopDraft: EditShopEntry | null;
  setShopDraft: (s: EditShopEntry | null) => void;
  itemDefs: Array<{ id: string; name: string }>;
  onDelete: () => void;
  onCommitShop: () => void;
}

function Inspector({
  selected,
  shopDraft,
  setShopDraft,
  itemDefs,
  onDelete,
  onCommitShop,
}: InspectorProps) {
  if (selected.kind === "npc" && selected.npc) {
    const npc = selected.npc;
    return (
      <div>
        <Field label="Kind" value="NPC" />
        <Field label="ID" value={npc.id} />
        <Field label="Name" value={npc.name} />
        <Field label="Tile" value={`${npc.tileX}, ${npc.tileY}`} />
        {npc.shopId && <Field label="Shop" value={npc.shopId} />}
        <button className="edit-btn danger" onClick={onDelete}>
          Delete NPC
        </button>
        {shopDraft && (
          <ShopEditor
            draft={shopDraft}
            setDraft={setShopDraft}
            itemDefs={itemDefs}
            onCommit={onCommitShop}
          />
        )}
      </div>
    );
  }
  if (selected.kind === "enemy" && selected.enemy) {
    const e = selected.enemy;
    return (
      <div>
        <Field label="Kind" value="Enemy" />
        <Field label="ID" value={e.id} />
        <Field label="Type" value={e.defName} />
        <Field label="Tile" value={`${e.tileX}, ${e.tileY}`} />
        <button className="edit-btn danger" onClick={onDelete}>
          Delete Enemy
        </button>
      </div>
    );
  }
  if (selected.kind === "node" && selected.node) {
    const n = selected.node;
    return (
      <div>
        <Field label="Kind" value="Node" />
        <Field label="ID" value={n.id} />
        <Field label="Type" value={n.defName} />
        <Field label="Tile" value={`${n.tileX}, ${n.tileY}`} />
        <button className="edit-btn danger" onClick={onDelete}>
          Delete Node
        </button>
      </div>
    );
  }
  if (selected.kind === "item" && selected.item) {
    const i = selected.item;
    return (
      <div>
        <Field label="Kind" value={`Item (${i.source})`} />
        <Field label="ID" value={i.id} />
        <Field label="Item" value={i.itemName} />
        <Field label="Qty" value={String(i.quantity)} />
        <Field label="Tile" value={`${i.tileX}, ${i.tileY}`} />
        {i.source === "editor" ? (
          <button className="edit-btn danger" onClick={onDelete}>
            Delete Item
          </button>
        ) : (
          <div className="edit-hint">
            Authored items live in the .tmj file — edit there to move/remove.
          </div>
        )}
      </div>
    );
  }
  return null;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="edit-field">
      <span className="edit-field-label">{label}</span>
      <span className="edit-field-value">{value}</span>
    </div>
  );
}

interface ShopEditorProps {
  draft: EditShopEntry;
  setDraft: (s: EditShopEntry | null) => void;
  itemDefs: Array<{ id: string; name: string }>;
  onCommit: () => void;
}

function ShopEditor({ draft, setDraft, itemDefs, onCommit }: ShopEditorProps) {
  return (
    <div className="edit-shop">
      <div className="edit-section-title">Shop: {draft.name}</div>
      {draft.stock.map((row, idx) => (
        <div key={idx} className="edit-shop-row">
          <select
            value={row.itemId}
            onChange={(e) => {
              const next = { ...draft, stock: draft.stock.slice() };
              next.stock[idx] = { ...row, itemId: e.target.value };
              setDraft(next);
            }}
          >
            {itemDefs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={0}
            value={row.restockQuantity}
            onChange={(e) => {
              const next = { ...draft, stock: draft.stock.slice() };
              next.stock[idx] = { ...row, restockQuantity: Number(e.target.value) };
              setDraft(next);
            }}
          />
          <button
            className="edit-btn small"
            onClick={() => {
              const next = { ...draft, stock: draft.stock.filter((_, i) => i !== idx) };
              setDraft(next);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="edit-btn small"
        onClick={() =>
          setDraft({
            ...draft,
            stock: [...draft.stock, { itemId: itemDefs[0]?.id ?? "", restockQuantity: 1 }],
          })
        }
      >
        + Add row
      </button>
      <button className="edit-btn primary" onClick={onCommit}>
        Apply Shop Changes
      </button>
    </div>
  );
}

async function saveToDisk(files: Array<{ name: string; content: string }>) {
  try {
    const res = await fetch("/__edit/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      console.error("[edit-save] failed:", body?.error ?? res.statusText);
      window.alert(`Edit save failed: ${body?.error ?? res.statusText}`);
      return;
    }
    console.log("[edit-save] wrote:", body.written);
  } catch (err) {
    console.error("[edit-save] network error:", err);
    window.alert(`Edit save failed: ${String(err)}`);
  }
}
