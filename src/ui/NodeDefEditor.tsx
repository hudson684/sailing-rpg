import { useEffect, useMemo, useRef, useState } from "react";
import nodesDataRaw from "../game/data/nodes.json";
import itemsDataRaw from "../game/data/items.json";
import type { NodeDef, NodeInstanceData } from "../game/world/GatheringNode";
import "./NodeDefEditor.css";

interface NodesFile {
  defs: NodeDef[];
  instances: NodeInstanceData[];
}

interface ItemsFile {
  items: Array<{ id: string; name: string }>;
}

const STAGE_SIZE = 520;
const ANCHOR_X = STAGE_SIZE / 2;
const ANCHOR_Y = STAGE_SIZE / 2 + 60;

type DragMode =
  | { kind: "box" }
  | { kind: "resize"; edge: "n" | "s" | "e" | "w" }
  | { kind: "ysort" };

export function NodeDefEditor() {
  const [open, setOpen] = useState(false);
  const [defs, setDefs] = useState<NodeDef[]>(() =>
    cloneDefs((nodesDataRaw as NodesFile).defs),
  );
  const [selectedId, setSelectedId] = useState<string>(
    () => (nodesDataRaw as NodesFile).defs[0]?.id ?? "",
  );
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    initial: NodeDef;
  } | null>(null);

  const items = (itemsDataRaw as ItemsFile).items;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F8") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const selected = useMemo(
    () => defs.find((d) => d.id === selectedId) ?? defs[0],
    [defs, selectedId],
  );

  if (!open) return null;
  if (!selected) return null;

  const updateSelected = (patch: Partial<NodeDef>) => {
    setDefs((prev) =>
      prev.map((d) => (d.id === selected.id ? { ...d, ...patch } : d)),
    );
  };

  const updateDrop = (patch: Partial<NodeDef["drop"]>) => {
    updateSelected({ drop: { ...selected.drop, ...patch } });
  };

  const collisionOffsetX = selected.collisionOffsetX ?? 0;
  const collisionOffsetY = selected.collisionOffsetY ?? 0;
  const ySortOffset = selected.ySortOffset ?? 0;

  const boxLeft = ANCHOR_X + collisionOffsetX - selected.width / 2;
  const boxTop = ANCHOR_Y + collisionOffsetY - selected.height / 2;

  const startDrag = (mode: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      initial: { ...selected, drop: { ...selected.drop } },
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const init = drag.initial;
    if (drag.mode.kind === "box") {
      updateSelected({
        collisionOffsetX: (init.collisionOffsetX ?? 0) + dx,
        collisionOffsetY: (init.collisionOffsetY ?? 0) + dy,
      });
    } else if (drag.mode.kind === "resize") {
      const edge = drag.mode.edge;
      if (edge === "e") {
        updateSelected({ width: Math.max(2, init.width + dx * 2) });
      } else if (edge === "w") {
        updateSelected({ width: Math.max(2, init.width - dx * 2) });
      } else if (edge === "s") {
        updateSelected({ height: Math.max(2, init.height + dy * 2) });
      } else if (edge === "n") {
        updateSelected({ height: Math.max(2, init.height - dy * 2) });
      }
    } else if (drag.mode.kind === "ysort") {
      updateSelected({ ySortOffset: (init.ySortOffset ?? 0) + dy });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
  };

  const spriteStyle = selected.sprite
    ? spriteDisplayStyle(selected.sprite)
    : null;

  return (
    <div className="nde-root">
      <div className="nde-list">
        <div className="nde-title">Node Defs</div>
        {defs.map((d) => (
          <button
            key={d.id}
            className={`nde-list-item ${d.id === selected.id ? "active" : ""}`}
            onClick={() => setSelectedId(d.id)}
          >
            {d.name}
            <div style={{ color: "#888", fontSize: 10 }}>{d.id}</div>
          </button>
        ))}
      </div>

      <div className="nde-preview">
        <button className="nde-close" onClick={() => setOpen(false)}>
          Close (Esc)
        </button>
        <div className="nde-legend">
          <div>Red dot: node anchor (tile center)</div>
          <div style={{ color: "#ffcc66" }}>Yellow: collision box (drag to move, edges to resize)</div>
          <div style={{ color: "#66ccff" }}>Blue line: y-sort line (drag to offset)</div>
        </div>
        <div
          ref={stageRef}
          className="nde-stage"
          style={{ width: STAGE_SIZE, height: STAGE_SIZE }}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {selected.sprite && spriteStyle && (
            <div
              className="nde-sprite"
              style={{
                left: ANCHOR_X - spriteStyle.widthPx / 2,
                top: ANCHOR_Y - spriteStyle.heightPx * (selected.sprite.originY ?? 1),
                width: spriteStyle.widthPx,
                height: spriteStyle.heightPx,
                backgroundImage: `url(/${selected.sprite.sheet})`,
                backgroundSize: `${spriteStyle.widthPx * selected.sprite.frames}px ${spriteStyle.heightPx}px`,
                backgroundPosition: "0 0",
                backgroundRepeat: "no-repeat",
              }}
            />
          )}

          <div className="nde-anchor" style={{ left: ANCHOR_X, top: ANCHOR_Y }} />

          <div
            className="nde-box"
            style={{
              left: boxLeft,
              top: boxTop,
              width: selected.width,
              height: selected.height,
            }}
            onPointerDown={startDrag({ kind: "box" })}
          >
            <div className="nde-handle n" onPointerDown={startDrag({ kind: "resize", edge: "n" })} />
            <div className="nde-handle s" onPointerDown={startDrag({ kind: "resize", edge: "s" })} />
            <div className="nde-handle e" onPointerDown={startDrag({ kind: "resize", edge: "e" })} />
            <div className="nde-handle w" onPointerDown={startDrag({ kind: "resize", edge: "w" })} />
          </div>

          <div
            className="nde-ysort"
            style={{ top: ANCHOR_Y + ySortOffset }}
            onPointerDown={startDrag({ kind: "ysort" })}
          >
            <span className="nde-ysort-label">y-sort (offset {ySortOffset})</span>
          </div>
        </div>
      </div>

      <div className="nde-form">
        <div className="nde-title">{selected.name}</div>

        <div className="nde-row">
          <label>HP</label>
          <input
            type="number"
            min={1}
            value={selected.hp}
            onChange={(e) => updateSelected({ hp: Math.max(1, Number(e.target.value) || 1) })}
          />
        </div>

        <div className="nde-row">
          <label>Drop item</label>
          <select
            value={selected.drop.itemId}
            onChange={(e) => updateDrop({ itemId: e.target.value })}
          >
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.id})
              </option>
            ))}
          </select>
        </div>

        <div className="nde-row">
          <label>Drop quantity</label>
          <input
            type="number"
            min={1}
            value={selected.drop.quantity}
            onChange={(e) => updateDrop({ quantity: Math.max(1, Number(e.target.value) || 1) })}
          />
        </div>

        <div className="nde-row-inline">
          <div className="nde-row">
            <label>Width</label>
            <input
              type="number"
              min={2}
              value={selected.width}
              onChange={(e) => updateSelected({ width: Math.max(2, Number(e.target.value) || 2) })}
            />
          </div>
          <div className="nde-row">
            <label>Height</label>
            <input
              type="number"
              min={2}
              value={selected.height}
              onChange={(e) => updateSelected({ height: Math.max(2, Number(e.target.value) || 2) })}
            />
          </div>
        </div>

        <div className="nde-row-inline">
          <div className="nde-row">
            <label>Collision off X</label>
            <input
              type="number"
              value={collisionOffsetX}
              onChange={(e) => updateSelected({ collisionOffsetX: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="nde-row">
            <label>Collision off Y</label>
            <input
              type="number"
              value={collisionOffsetY}
              onChange={(e) => updateSelected({ collisionOffsetY: Number(e.target.value) || 0 })}
            />
          </div>
        </div>

        <div className="nde-row">
          <label>Y-sort offset</label>
          <input
            type="number"
            value={ySortOffset}
            onChange={(e) => updateSelected({ ySortOffset: Number(e.target.value) || 0 })}
          />
        </div>

        <div className="nde-row">
          <label>Respawn (sec)</label>
          <input
            type="number"
            min={0}
            value={selected.respawnSec}
            onChange={(e) => updateSelected({ respawnSec: Math.max(0, Number(e.target.value) || 0) })}
          />
        </div>

        <div className="nde-row">
          <label>XP per hit</label>
          <input
            type="number"
            min={0}
            value={selected.xpPerHit}
            onChange={(e) => updateSelected({ xpPerHit: Math.max(0, Number(e.target.value) || 0) })}
          />
        </div>

        <div className="nde-row">
          <label>
            <input
              type="checkbox"
              checked={selected.blocks}
              onChange={(e) => updateSelected({ blocks: e.target.checked })}
            />{" "}
            Blocks movement
          </label>
        </div>

        <button
          className="nde-btn primary"
          onClick={() => void saveDefs(defs)}
          style={{ marginTop: 10 }}
        >
          Save to nodes.json
        </button>
        <button
          className="nde-btn"
          onClick={() => setDefs(cloneDefs((nodesDataRaw as NodesFile).defs))}
        >
          Reset unsaved
        </button>
      </div>
    </div>
  );
}

function cloneDefs(defs: NodeDef[]): NodeDef[] {
  return defs.map((d) => ({ ...d, drop: { ...d.drop }, sprite: d.sprite ? { ...d.sprite } : undefined }));
}

function spriteDisplayStyle(sprite: NonNullable<NodeDef["sprite"]>) {
  const scale = sprite.scale ?? 1;
  return {
    widthPx: sprite.frameWidth * scale,
    heightPx: sprite.frameHeight * scale,
  };
}

async function saveDefs(defs: NodeDef[]) {
  const current = nodesDataRaw as NodesFile;
  const out: NodesFile = { defs: stripDefaults(defs), instances: current.instances };
  const content = JSON.stringify(out, null, 2) + "\n";
  try {
    const res = await fetch("/__edit/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [{ name: "nodes.json", content }] }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      window.alert(`Save failed: ${body?.error ?? res.statusText}`);
      return;
    }
    window.alert("Saved nodes.json. Vite HMR will reload the world.");
  } catch (err) {
    window.alert(`Save failed: ${String(err)}`);
  }
}

function stripDefaults(defs: NodeDef[]): NodeDef[] {
  return defs.map((d) => {
    const out: NodeDef = { ...d, drop: { ...d.drop } };
    if (out.collisionOffsetX === 0) delete out.collisionOffsetX;
    if (out.collisionOffsetY === 0) delete out.collisionOffsetY;
    if (out.ySortOffset === 0) delete out.ySortOffset;
    return out;
  });
}
