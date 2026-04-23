import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ENTITY_TYPES,
  findType,
  type EditorEntity,
  type EntityKind,
  type ParsedEntityFile,
  type DefSummary,
} from "../entityTypes";
import {
  fetchManifest,
  loadSingleTmjView,
  loadWorldView,
  type MapView,
  type WorldManifest,
} from "../mapLoader";
import type { SpriteFrame } from "../spriteLoader";
import { useJsonFile } from "../useJsonFile";

// --- Types --------------------------------------------------------

interface MapOption {
  id: string;
  kind: "world" | "interior" | "ship";
  path?: string; // absent for world
}

type Tool =
  | { kind: "select" }
  | { kind: "place"; entity: EntityKind; defId: string };

type DraftByKind = Record<EntityKind, EditorEntity[]>;

const DEFAULT_SCALE: Record<"world" | "interior" | "ship", number> = {
  world: 0.5,
  interior: 1,
  ship: 1,
};

// --- Component ----------------------------------------------------

export function SpawnEditor() {
  // Maps & manifest --------------------------------------------------
  const [manifest, setManifest] = useState<WorldManifest | null>(null);
  const [mapOptions, setMapOptions] = useState<MapOption[]>([]);
  const [mapId, setMapId] = useState<string | null>(null);
  const [mapView, setMapView] = useState<MapView | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapLoading, setMapLoading] = useState(false);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    fetchManifest()
      .then((m) => {
        const opts: MapOption[] = [{ id: "world", kind: "world" }];
        for (const [id, v] of Object.entries(m.interiors ?? {})) {
          opts.push({ id, kind: "interior", path: v.path });
        }
        for (const [id, v] of Object.entries(m.ships ?? {})) {
          opts.push({ id, kind: "ship", path: v.path });
        }
        setManifest(m);
        setMapOptions(opts);
        if (!mapId) setMapId("world");
      })
      .catch((err) => setMapError(String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!mapId || !manifest) return;
    const opt = mapOptions.find((m) => m.id === mapId);
    if (!opt) return;
    setMapView(null);
    setMapError(null);
    setMapLoading(true);
    setScale(DEFAULT_SCALE[opt.kind]);
    const p =
      opt.kind === "world"
        ? loadWorldView(manifest)
        : loadSingleTmjView(opt.id, opt.kind, opt.path!);
    p.then(setMapView)
      .catch((err) => setMapError(String(err)))
      .finally(() => setMapLoading(false));
  }, [mapId, manifest, mapOptions]);

  const mapKind = useMemo(() => mapOptions.find((m) => m.id === mapId)?.kind, [
    mapOptions,
    mapId,
  ]);

  // Data files -------------------------------------------------------
  const files = {
    npc: useJsonFile<unknown>("src/game/data/npcs.json"),
    enemy: useJsonFile<unknown>("src/game/data/enemies.json"),
    node: useJsonFile<unknown>("src/game/data/nodes.json"),
    station: useJsonFile<unknown>("src/game/data/craftingStations.json"),
    ship: useJsonFile<unknown>("src/game/data/ships.json"),
    item: useJsonFile<unknown>("src/game/data/itemInstances.json"),
  } as const;
  // Items.json is read-only for the editor (we only place references to it).
  const itemsFile = useJsonFile<{ items?: Array<{ id: string; name?: string }> }>(
    "src/game/data/items.json",
  );

  // Parsed defs + initial entities keyed by kind.
  const parsed = useMemo(() => {
    const out: Partial<Record<EntityKind, ParsedEntityFile>> = {};
    for (const info of ENTITY_TYPES) {
      const raw = files[info.kind].data;
      if (!raw) continue;
      out[info.kind] = info.parseFile(raw);
    }
    if (itemsFile.data && out.item) {
      const itemDefs = itemsFile.data.items ?? [];
      const rawDefs: Record<string, unknown> = {};
      for (const i of itemDefs) rawDefs[i.id] = i;
      out.item = {
        entities: out.item.entities,
        defs: itemDefs.map((i) => ({ id: i.id, label: i.name ?? i.id })),
        rawDefs,
      };
    }
    return out;
  }, [files.npc.data, files.enemy.data, files.node.data, files.station.data, files.ship.data, files.item.data, itemsFile.data]);

  // Draft state — the working copy of instances per kind.
  const [draft, setDraft] = useState<DraftByKind | null>(null);
  const [undoStack, setUndoStack] = useState<DraftByKind[]>([]);
  const [selection, setSelection] = useState<{ kind: EntityKind; id: string } | null>(null);
  const [tool, setTool] = useState<Tool>({ kind: "select" });

  // Initialize draft once all files have loaded.
  useEffect(() => {
    if (draft) return;
    const complete = ENTITY_TYPES.every((t) => parsed[t.kind]);
    if (!complete) return;
    const next: DraftByKind = {
      npc: parsed.npc!.entities,
      enemy: parsed.enemy!.entities,
      node: parsed.node!.entities,
      station: parsed.station!.entities,
      ship: parsed.ship!.entities,
      item: parsed.item!.entities,
    };
    setDraft(next);
  }, [parsed, draft]);

  const pushUndo = useCallback(() => {
    setUndoStack((s) => (draft ? [...s.slice(-49), draft] : s));
  }, [draft]);

  const undo = useCallback(() => {
    setUndoStack((s) => {
      if (s.length === 0) return s;
      setDraft(s[s.length - 1]);
      return s.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, selection, draft]);

  // Visible entities on the current map.
  const visible = useMemo(() => {
    if (!draft || !mapId || !mapKind) return [];
    const out: EditorEntity[] = [];
    for (const info of ENTITY_TYPES) {
      for (const e of draft[info.kind]) {
        if (info.isOnMap(e, mapId, mapKind)) out.push(e);
      }
    }
    return out;
  }, [draft, mapId, mapKind]);

  const selected = useMemo(() => {
    if (!selection || !draft) return null;
    return draft[selection.kind].find((e) => e.id === selection.id) ?? null;
  }, [selection, draft]);

  const updateEntity = useCallback(
    (kind: EntityKind, id: string, patch: Partial<EditorEntity>) => {
      if (!draft) return;
      pushUndo();
      setDraft({
        ...draft,
        [kind]: draft[kind].map((e) => (e.id === id ? { ...e, ...patch } : e)),
      });
    },
    [draft, pushUndo],
  );

  const deleteSelected = useCallback(() => {
    if (!selection || !draft) return;
    pushUndo();
    setDraft({
      ...draft,
      [selection.kind]: draft[selection.kind].filter((e) => e.id !== selection.id),
    });
    setSelection(null);
  }, [selection, draft, pushUndo]);

  const placeAt = useCallback(
    (tileX: number, tileY: number) => {
      if (!draft || !mapId || !mapKind || tool.kind !== "place") return;
      const info = findType(tool.entity);
      const existingIds = new Set(draft[tool.entity].map((e) => e.id));
      let entity = info.makeNew(tool.defId, tileX, tileY, existingIds);
      if (tool.entity === "npc" && mapKind === "interior") {
        entity = { ...entity, interior: mapId, underlying: { ...entity.underlying, map: { interior: mapId } } };
      }
      pushUndo();
      setDraft({ ...draft, [tool.entity]: [...draft[tool.entity], entity] });
      setSelection({ kind: tool.entity, id: entity.id });
    },
    [draft, mapId, mapKind, tool, pushUndo],
  );

  // Save --------------------------------------------------------------
  const dirtyKinds = useMemo(() => {
    if (!draft) return new Set<EntityKind>();
    const out = new Set<EntityKind>();
    for (const info of ENTITY_TYPES) {
      const original = files[info.kind].data;
      if (!original) continue;
      const candidate = info.toFile(original, draft[info.kind]);
      if (JSON.stringify(candidate) !== JSON.stringify(original)) out.add(info.kind);
    }
    return out;
  }, [draft, files.npc.data, files.enemy.data, files.node.data, files.station.data, files.ship.data, files.item.data]);

  const onSave = useCallback(async () => {
    if (!draft) return;
    for (const info of ENTITY_TYPES) {
      if (!dirtyKinds.has(info.kind)) continue;
      const payload = info.toFile(files[info.kind].data, draft[info.kind]);
      // eslint-disable-next-line no-await-in-loop
      await files[info.kind].save(payload);
    }
  }, [draft, dirtyKinds, files]);

  const onRevert = useCallback(() => {
    const next: DraftByKind = {
      npc: parsed.npc?.entities ?? [],
      enemy: parsed.enemy?.entities ?? [],
      node: parsed.node?.entities ?? [],
      station: parsed.station?.entities ?? [],
      ship: parsed.ship?.entities ?? [],
      item: parsed.item?.entities ?? [],
    };
    setDraft(next);
    setUndoStack([]);
    setSelection(null);
  }, [parsed]);

  const anyLoading =
    !draft || mapLoading || ENTITY_TYPES.some((t) => files[t.kind].loading) || itemsFile.loading;
  const saving = ENTITY_TYPES.some((t) => files[t.kind].saving);
  const saveError = ENTITY_TYPES.map((t) => files[t.kind].error).find((e) => e);

  // UI ---------------------------------------------------------------
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%" }}>
      <Toolbar
        mapOptions={mapOptions}
        mapId={mapId}
        onMapChange={(id) => {
          setMapId(id);
          setSelection(null);
        }}
        scale={scale}
        onScaleChange={setScale}
        onSave={onSave}
        onRevert={onRevert}
        onUndo={undo}
        dirtyCount={dirtyKinds.size}
        undoCount={undoStack.length}
        saving={saving}
        saveError={saveError}
      />

      <div style={{ display: "flex", gap: 10, flex: 1, minHeight: 0 }}>
        <LeftRail
          mapKind={mapKind}
          tool={tool}
          setTool={setTool}
          parsed={parsed}
        />

        <div style={{ flex: 1, overflow: "auto", background: "#08080c", border: "1px solid #222", position: "relative" }}>
          {mapError && <div style={{ color: "#ff6666", padding: 12 }}>{mapError}</div>}
          {anyLoading && !mapError && (
            <div style={{ color: "#888", padding: 12 }}>Loading…</div>
          )}
          {mapView && draft && (
            <MapCanvas
              view={mapView}
              scale={scale}
              entities={visible}
              rawDefs={parsed}
              selectionId={selection?.id ?? null}
              tool={tool}
              onSelect={(e) => setSelection(e ? { kind: e.kind, id: e.id } : null)}
              onMove={(e, tileX, tileY) => updateEntity(e.kind, e.id, { tileX, tileY })}
              onPlaceAt={placeAt}
              pushUndo={pushUndo}
            />
          )}
        </div>

        <Inspector
          selected={selected}
          parsed={parsed}
          updateEntity={updateEntity}
          deleteSelected={deleteSelected}
          visibleCount={visible.length}
          visible={visible}
          selection={selection}
          setSelection={setSelection}
        />
      </div>
    </div>
  );
}

// --- Toolbar ------------------------------------------------------

function Toolbar(props: {
  mapOptions: MapOption[];
  mapId: string | null;
  onMapChange: (id: string) => void;
  scale: number;
  onScaleChange: (s: number) => void;
  onSave: () => void;
  onRevert: () => void;
  onUndo: () => void;
  dirtyCount: number;
  undoCount: number;
  saving: boolean;
  saveError: string | null | undefined;
}) {
  const { mapOptions, mapId, onMapChange, scale, onScaleChange, onSave, onRevert, onUndo, dirtyCount, undoCount, saving, saveError } = props;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <label style={{ fontWeight: 600 }}>Map:</label>
      <select
        value={mapId ?? ""}
        onChange={(e) => onMapChange(e.target.value)}
        style={selectStyle}
      >
        <optgroup label="World">
          {mapOptions.filter((m) => m.kind === "world").map((m) => (
            <option key={m.id} value={m.id}>{m.id}</option>
          ))}
        </optgroup>
        <optgroup label="Interiors">
          {mapOptions.filter((m) => m.kind === "interior").map((m) => (
            <option key={m.id} value={m.id}>{m.id}</option>
          ))}
        </optgroup>
        <optgroup label="Ships">
          {mapOptions.filter((m) => m.kind === "ship").map((m) => (
            <option key={m.id} value={m.id}>{m.id}</option>
          ))}
        </optgroup>
      </select>

      <label style={{ marginLeft: 8 }}>Zoom:</label>
      <select
        value={scale}
        onChange={(e) => onScaleChange(Number(e.target.value))}
        style={selectStyle}
      >
        {[0.25, 0.5, 0.75, 1, 1.5, 2].map((s) => (
          <option key={s} value={s}>{(s * 100).toFixed(0)}%</option>
        ))}
      </select>

      <div style={{ flex: 1 }} />

      <button onClick={onUndo} disabled={undoCount === 0} style={btn("ghost")}>
        Undo ({undoCount})
      </button>
      <button onClick={onRevert} disabled={dirtyCount === 0} style={btn("ghost")}>
        Revert
      </button>
      <button onClick={onSave} disabled={dirtyCount === 0 || saving} style={btn(dirtyCount > 0 && !saving ? "primary" : "ghost")}>
        {saving ? "Saving…" : `Save (${dirtyCount})`}
      </button>
      {saveError && <span style={{ color: "#ff6666", fontSize: 12 }}>{saveError}</span>}
    </div>
  );
}

// --- Left rail (tool picker) --------------------------------------

function LeftRail(props: {
  mapKind: "world" | "interior" | "ship" | undefined;
  tool: Tool;
  setTool: (t: Tool) => void;
  parsed: Partial<Record<EntityKind, { defs: DefSummary[] }>>;
}) {
  const { mapKind, tool, setTool, parsed } = props;
  const kindsForMap: EntityKind[] =
    mapKind === "interior"
      ? ["npc"]
      : mapKind === "ship"
      ? ["npc"]
      : ["npc", "enemy", "node", "station", "ship", "item"];

  return (
    <aside style={{ width: 200, background: "#12121a", padding: 10, border: "1px solid #222", overflow: "auto" }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Tool</div>
      <button
        onClick={() => setTool({ kind: "select" })}
        style={tool.kind === "select" ? btn("primary") : btn("ghost")}
      >
        Select / Drag
      </button>
      <div style={{ fontWeight: 600, margin: "12px 0 6px" }}>Place</div>
      {kindsForMap.map((k) => {
        const info = findType(k);
        const defs = parsed[k]?.defs ?? [];
        const active = tool.kind === "place" && tool.entity === k;
        return (
          <div key={k} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 2 }}>{info.label}</div>
            <select
              value={active ? tool.defId : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v) setTool({ kind: "place", entity: k, defId: v });
              }}
              style={{ ...selectStyle, width: "100%", background: active ? "#2b4d7a" : "#1a1a1f" }}
            >
              <option value="" disabled>Pick a {info.label.toLowerCase()}…</option>
              {defs.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
          </div>
        );
      })}
    </aside>
  );
}

// --- Inspector ----------------------------------------------------

function Inspector(props: {
  selected: EditorEntity | null;
  parsed: Partial<Record<EntityKind, { entities: EditorEntity[]; defs: DefSummary[] }>>;
  updateEntity: (k: EntityKind, id: string, patch: Partial<EditorEntity>) => void;
  deleteSelected: () => void;
  visibleCount: number;
  visible: EditorEntity[];
  selection: { kind: EntityKind; id: string } | null;
  setSelection: (s: { kind: EntityKind; id: string } | null) => void;
}) {
  const { selected, updateEntity, deleteSelected, visible, selection, setSelection } = props;
  return (
    <aside style={{ width: 280, background: "#12121a", padding: 12, border: "1px solid #222", overflow: "auto" }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Inspector</div>
      {selected ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Field label="Kind" value={findType(selected.kind).label} />
          <Field label="ID" value={selected.id} />
          <Field label="Def / Type" value={selected.defId} />
          {selected.interior && <Field label="Interior" value={selected.interior} />}
          <div style={{ display: "flex", gap: 6 }}>
            <NumberField
              label="tileX"
              value={selected.tileX}
              onChange={(v) => updateEntity(selected.kind, selected.id, { tileX: v })}
            />
            <NumberField
              label="tileY"
              value={selected.tileY}
              onChange={(v) => updateEntity(selected.kind, selected.id, { tileY: v })}
            />
          </div>
          {selected.kind === "ship" && typeof selected.underlying.heading === "string" && (
            <label style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ color: "#888", fontSize: 11 }}>heading</span>
              <select
                value={String(selected.underlying.heading)}
                onChange={(e) => {
                  updateEntity(selected.kind, selected.id, {
                    underlying: { ...selected.underlying, heading: e.target.value },
                    label: `${selected.defId} (${e.target.value})`,
                  });
                }}
                style={selectStyle}
              >
                {["N", "E", "S", "W"].map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
          )}
          {selected.kind === "item" && (
            <NumberField
              label="quantity"
              value={Number(selected.underlying.quantity ?? 1)}
              onChange={(v) =>
                updateEntity(selected.kind, selected.id, {
                  underlying: { ...selected.underlying, quantity: v },
                  label: `${selected.defId} x${v}`,
                })
              }
            />
          )}
          <button onClick={deleteSelected} style={btn("danger")}>
            Delete (Del)
          </button>
        </div>
      ) : (
        <div style={{ color: "#666", fontSize: 12 }}>
          Click a marker to select. Drag it to move. With a place-tool active, click empty space to place.
        </div>
      )}

      <div style={{ marginTop: 16, fontWeight: 600 }}>On this map ({visible.length})</div>
      <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
        {visible.map((e) => {
          const active = selection?.kind === e.kind && selection.id === e.id;
          return (
            <li key={`${e.kind}:${e.id}`}>
              <button
                onClick={() => setSelection({ kind: e.kind, id: e.id })}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  textAlign: "left",
                  padding: "4px 8px",
                  background: active ? "#2b4d7a" : "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  font: "inherit",
                  fontSize: 12,
                  borderRadius: 3,
                }}
              >
                <span style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: e.color,
                  flexShrink: 0,
                }} />
                {e.label}
                <span style={{ color: "#888", marginLeft: "auto" }}>
                  ({e.tileX}, {e.tileY})
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

// --- Map canvas ---------------------------------------------------

interface MapCanvasProps {
  view: MapView;
  scale: number;
  entities: EditorEntity[];
  rawDefs: Partial<Record<EntityKind, ParsedEntityFile>>;
  selectionId: string | null;
  tool: Tool;
  onSelect: (e: EditorEntity | null) => void;
  onMove: (e: EditorEntity, tileX: number, tileY: number) => void;
  onPlaceAt: (tileX: number, tileY: number) => void;
  pushUndo: () => void;
}

function MapCanvas(props: MapCanvasProps) {
  const { view, scale, entities, rawDefs, selectionId, tool, onSelect, onMove, onPlaceAt, pushUndo } = props;
  const tileRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const spriteCache = useRef(new Map<string, SpriteFrame | null>());
  const [, forceRender] = useState(0);

  const w = view.widthTiles * view.tilePixel * scale;
  const h = view.heightTiles * view.tilePixel * scale;

  // Render tile layers when view or scale changes.
  useLayoutEffect(() => {
    const canvas = tileRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#0c0c12";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    view.renderTiles(ctx, scale);
  }, [view, scale]);

  // Load sprite frames for visible entity defs.
  useEffect(() => {
    let cancelled = false;
    const uniqueDefs = new Map<string, { kind: EntityKind; def: unknown }>();
    for (const e of entities) {
      const cacheKey = `${e.kind}:${e.defId}`;
      if (spriteCache.current.has(cacheKey)) continue;
      const def = rawDefs[e.kind]?.rawDefs[e.defId];
      if (!def) continue;
      uniqueDefs.set(cacheKey, { kind: e.kind, def });
    }
    (async () => {
      for (const [key, v] of uniqueDefs) {
        if (cancelled) return;
        const info = findType(v.kind);
        try {
          const frame = await info.loadSprite(v.def);
          spriteCache.current.set(key, frame);
        } catch {
          spriteCache.current.set(key, null);
        }
      }
      if (!cancelled) forceRender((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [entities, rawDefs]);

  // Draw overlay.
  useLayoutEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    const tile = view.tilePixel * scale;
    // Grid only when tile is big enough to be useful.
    if (tile >= 12) {
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= view.widthTiles; x++) {
        ctx.moveTo(x * tile + 0.5, 0);
        ctx.lineTo(x * tile + 0.5, h);
      }
      for (let y = 0; y <= view.heightTiles; y++) {
        ctx.moveTo(0, y * tile + 0.5);
        ctx.lineTo(w, y * tile + 0.5);
      }
      ctx.stroke();
    }
    for (const e of entities) {
      const cacheKey = `${e.kind}:${e.defId}`;
      const frame = spriteCache.current.get(cacheKey) ?? null;
      const cx = (e.tileX + 0.5) * tile;
      const cy = (e.tileY + 0.5) * tile;
      const selected = e.id === selectionId;
      if (frame) {
        // Draw sprite centered with its bottom anchored to the tile bottom.
        const dw = frame.sw * scale;
        const dh = frame.sh * scale;
        ctx.drawImage(
          frame.image,
          frame.sx,
          frame.sy,
          frame.sw,
          frame.sh,
          cx - dw / 2,
          cy + tile / 2 - dh,
          dw,
          dh,
        );
        if (selected) {
          ctx.strokeStyle = "#ffdd44";
          ctx.lineWidth = 2;
          ctx.strokeRect(cx - dw / 2 - 2, cy + tile / 2 - dh - 2, dw + 4, dh + 4);
        }
      } else {
        const r = Math.max(5, Math.min(14, tile * 0.35));
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = selected ? "#ffdd44" : e.color;
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // Label when zoomed in reasonably.
      if (tile >= 20) {
        ctx.font = `${Math.max(10, Math.min(12, tile * 0.3))}px system-ui, sans-serif`;
        ctx.textBaseline = "top";
        ctx.textAlign = "center";
        const textY = cy + tile / 2 + 2;
        const m = ctx.measureText(e.label);
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(cx - m.width / 2 - 3, textY - 1, m.width + 6, 14);
        ctx.fillStyle = "#fff";
        ctx.fillText(e.label, cx, textY);
      }
    }
  }, [view, scale, entities, selectionId, w, h]);

  // Pointer handling.
  const dragRef = useRef<{ entity: EditorEntity; dx: number; dy: number; committed: boolean } | null>(null);

  const pxToTile = useCallback(
    (clientX: number, clientY: number) => {
      const rect = overlayRef.current!.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const tile = view.tilePixel * scale;
      return { tileX: Math.floor(px / tile), tileY: Math.floor(py / tile), px, py };
    },
    [view, scale],
  );

  const hitTest = useCallback(
    (px: number, py: number): EditorEntity | null => {
      const tile = view.tilePixel * scale;
      for (let i = entities.length - 1; i >= 0; i--) {
        const e = entities[i];
        const cx = (e.tileX + 0.5) * tile;
        const cy = (e.tileY + 0.5) * tile;
        if (Math.hypot(px - cx, py - cy) <= Math.max(10, tile * 0.45)) return e;
      }
      return null;
    },
    [view, scale, entities],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { tileX, tileY, px, py } = pxToTile(e.clientX, e.clientY);
    if (tileX < 0 || tileY < 0 || tileX >= view.widthTiles || tileY >= view.heightTiles) return;
    const hit = hitTest(px, py);
    if (tool.kind === "place" && !hit) {
      onPlaceAt(tileX, tileY);
      return;
    }
    if (hit) {
      onSelect(hit);
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      dragRef.current = { entity: hit, dx: 0, dy: 0, committed: false };
    } else {
      onSelect(null);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { tileX, tileY } = pxToTile(e.clientX, e.clientY);
    if (tileX === drag.entity.tileX && tileY === drag.entity.tileY) return;
    if (tileX < 0 || tileY < 0 || tileX >= view.widthTiles || tileY >= view.heightTiles) return;
    if (!drag.committed) {
      pushUndo();
      drag.committed = true;
    }
    onMove(drag.entity, tileX, tileY);
    drag.entity = { ...drag.entity, tileX, tileY };
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
  };

  return (
    <div style={{ position: "relative", width: w, height: h }}>
      <canvas
        ref={tileRef}
        width={w}
        height={h}
        style={{ position: "absolute", inset: 0, imageRendering: "pixelated" }}
      />
      <canvas
        ref={overlayRef}
        width={w}
        height={h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          position: "absolute",
          inset: 0,
          imageRendering: "pixelated",
          cursor: tool.kind === "place" ? "copy" : "crosshair",
        }}
      />
    </div>
  );
}

// --- Bits ---------------------------------------------------------

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ color: "#888", fontSize: 11 }}>{label}</span>
      <span style={{ fontSize: 13 }}>{value}</span>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <span style={{ color: "#888", fontSize: 11 }}>{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        style={{
          background: "#0c0c12",
          color: "inherit",
          border: "1px solid #333",
          padding: "3px 6px",
          font: "inherit",
          fontSize: 12,
        }}
      />
    </label>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "4px 8px",
  background: "#1a1a1f",
  color: "inherit",
  border: "1px solid #333",
  font: "inherit",
  fontSize: 12,
};

function btn(variant: "primary" | "danger" | "ghost"): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "5px 12px",
    borderRadius: 4,
    border: "1px solid #333",
    font: "inherit",
    fontSize: 12,
    cursor: "pointer",
  };
  if (variant === "primary") return { ...base, background: "#2b4d7a", color: "#fff", borderColor: "#3d6aa8" };
  if (variant === "danger") return { ...base, background: "#5a2020", color: "#fff", borderColor: "#8a3030" };
  return { ...base, background: "transparent", color: "#ccc" };
}
