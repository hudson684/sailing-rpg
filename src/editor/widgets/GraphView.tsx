import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Minimal SVG graph view. Not a full React Flow replacement — just
 * enough for the quest/cutscene/dialogue editors: pan, zoom, click to
 * select, drag to move, edges with optional labels. Nodes render via
 * a render-prop so each editor styles its own boxes.
 */

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** If true, this node won't show a connection handle. */
  noConnect?: boolean;
}

export interface GraphEdge {
  id: string;
  from: string; // source node id
  to: string; // target node id
  label?: string;
  color?: string;
}

export interface GraphViewProps<T extends GraphNode> {
  nodes: T[];
  edges: GraphEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onNodeMove?: (id: string, x: number, y: number) => void;
  /** Called when the user drags from one node's handle and releases
   *  over another. Only invoked when `onConnect` is provided. */
  onConnect?: (fromId: string, toId: string) => void;
  /** Optional: called when the user clicks a point in empty space. */
  onBackgroundClick?: (x: number, y: number) => void;
  renderNode: (node: T, selected: boolean) => React.ReactNode;
  /** Optional fixed background dimensions; defaults to auto-fit. */
  minWidth?: number;
  minHeight?: number;
}

export function GraphView<T extends GraphNode>(props: GraphViewProps<T>) {
  const {
    nodes,
    edges,
    selectedId,
    onSelect,
    onNodeMove,
    onConnect,
    onBackgroundClick,
    renderNode,
    minWidth = 1200,
    minHeight = 800,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const [connecting, setConnecting] = useState<
    | { fromId: string; cursorX: number; cursorY: number; hoverId: string | null }
    | null
  >(null);

  // Height used for edge layout: measured height if we have it, else declared.
  const effectiveHeight = useCallback(
    (n: T) => measured[n.id] ?? n.height,
    [measured],
  );

  // Auto-fit bounds.
  const bounds = useMemo(() => {
    if (nodes.length === 0) return { w: minWidth, h: minHeight };
    let maxX = 0;
    let maxY = 0;
    for (const n of nodes) {
      maxX = Math.max(maxX, n.x + n.width + 100);
      maxY = Math.max(maxY, n.y + effectiveHeight(n) + 100);
    }
    return { w: Math.max(minWidth, maxX), h: Math.max(minHeight, maxY) };
  }, [nodes, minWidth, minHeight, effectiveHeight]);

  // Drag state.
  const dragRef = useRef<
    | { mode: "pan"; startX: number; startY: number; panX: number; panY: number }
    | { mode: "node"; id: string; startX: number; startY: number; nodeX: number; nodeY: number }
    | { mode: "connect"; fromId: string }
    | null
  >(null);

  const clientToLocal = useCallback(
    (clientX: number, clientY: number) => {
      const rect = rootRef.current!.getBoundingClientRect();
      return {
        x: (clientX - rect.left - pan.x) / zoom,
        y: (clientY - rect.top - pan.y) / zoom,
      };
    },
    [pan.x, pan.y, zoom],
  );

  const hitTest = useCallback(
    (clientX: number, clientY: number): string | null => {
      const { x, y } = clientToLocal(clientX, clientY);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const h = effectiveHeight(n);
        if (x >= n.x && x <= n.x + n.width && y >= n.y && y <= n.y + h) {
          return n.id;
        }
      }
      return null;
    },
    [nodes, clientToLocal, effectiveHeight],
  );

  const onMouseDownBg = (e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 1 || e.shiftKey) {
      dragRef.current = { mode: "pan", startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
      return;
    }
    const { x, y } = clientToLocal(e.clientX, e.clientY);
    onSelect(null);
    onBackgroundClick?.(x, y);
  };

  const onMouseDownNode = (e: React.MouseEvent, n: T) => {
    e.stopPropagation();
    onSelect(n.id);
    if (onNodeMove) {
      dragRef.current = {
        mode: "node",
        id: n.id,
        startX: e.clientX,
        startY: e.clientY,
        nodeX: n.x,
        nodeY: n.y,
      };
    }
  };

  const onMouseDownConnectHandle = (e: React.MouseEvent, n: T) => {
    if (!onConnect) return;
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { mode: "connect", fromId: n.id };
    const { x, y } = clientToLocal(e.clientX, e.clientY);
    setConnecting({ fromId: n.id, cursorX: x, cursorY: y, hoverId: null });
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === "pan") {
        setPan({ x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) });
      } else if (d.mode === "node" && onNodeMove) {
        const dx = (e.clientX - d.startX) / zoom;
        const dy = (e.clientY - d.startY) / zoom;
        onNodeMove(d.id, Math.round(d.nodeX + dx), Math.round(d.nodeY + dy));
      } else if (d.mode === "connect") {
        const { x, y } = clientToLocal(e.clientX, e.clientY);
        const hover = hitTest(e.clientX, e.clientY);
        setConnecting({
          fromId: d.fromId,
          cursorX: x,
          cursorY: y,
          hoverId: hover && hover !== d.fromId ? hover : null,
        });
      }
    };
    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      if (d && d.mode === "connect" && onConnect) {
        const target = hitTest(e.clientX, e.clientY);
        if (target && target !== d.fromId) {
          const targetNode = nodes.find((n) => n.id === target);
          if (targetNode && !targetNode.noConnect) {
            onConnect(d.fromId, target);
          }
        }
        setConnecting(null);
      }
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onNodeMove, onConnect, zoom, clientToLocal, hitTest, nodes]);

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(2, Math.max(0.25, zoom * factor));
    const rect = rootRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const wx = (cx - pan.x) / zoom;
    const wy = (cy - pan.y) / zoom;
    setPan({ x: cx - wx * next, y: cy - wy * next });
    setZoom(next);
  };

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // Canvas controls --------------------------------------------------
  const fitAll = useCallback(() => {
    const el = rootRef.current;
    if (!el || nodes.length === 0) return;
    const rect = el.getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + effectiveHeight(n));
    }
    const pad = 40;
    const contentW = maxX - minX + pad * 2;
    const contentH = maxY - minY + pad * 2;
    const z = Math.min(2, Math.max(0.25, Math.min(rect.width / contentW, rect.height / contentH)));
    setZoom(z);
    setPan({ x: -((minX - pad) * z) + (rect.width - contentW * z) / 2, y: -((minY - pad) * z) + (rect.height - contentH * z) / 2 });
  }, [nodes, effectiveHeight]);

  const zoomReset = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  const zoomToSelection = useCallback(() => {
    const n = nodes.find((x) => x.id === selectedId);
    const el = rootRef.current;
    if (!n || !el) return;
    const rect = el.getBoundingClientRect();
    const z = 1;
    setZoom(z);
    setPan({
      x: rect.width / 2 - (n.x + n.width / 2) * z,
      y: rect.height / 2 - (n.y + effectiveHeight(n) / 2) * z,
    });
  }, [nodes, selectedId, effectiveHeight]);

  return (
    <div
      ref={rootRef}
      onMouseDown={onMouseDownBg}
      onWheel={onWheel}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background:
          "radial-gradient(circle, rgba(255,255,255,0.03) 1px, transparent 1px) 0 0 / 24px 24px, #0a0a10",
        cursor: dragRef.current?.mode === "pan" ? "grabbing" : connecting ? "crosshair" : "default",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
          width: bounds.w,
          height: bounds.h,
        }}
      >
        <svg
          width={bounds.w}
          height={bounds.h}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#666" />
            </marker>
            <marker id="arrow-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#e0b060" />
            </marker>
            <marker id="arrow-err" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#e06060" />
            </marker>
          </defs>
          {edges.map((e) => {
            const from = nodes.find((n) => n.id === e.from);
            const to = nodes.find((n) => n.id === e.to);
            if (!from || !to) return null;
            const fromH = effectiveHeight(from);
            const toH = effectiveHeight(to);
            const x1 = from.x + from.width;
            const y1 = from.y + fromH / 2;
            const x2 = to.x;
            const y2 = to.y + toH / 2;
            const mx = (x1 + x2) / 2;
            const d = `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
            const color = e.color ?? "#666";
            const marker =
              color === "#e0b060" ? "url(#arrow-hi)" : color === "#e06060" ? "url(#arrow-err)" : "url(#arrow)";
            return (
              <g key={e.id}>
                <path d={d} fill="none" stroke={color} strokeWidth={2} markerEnd={marker} />
                {e.label && (
                  <g>
                    <rect
                      x={mx - 40}
                      y={(y1 + y2) / 2 - 9}
                      width={80}
                      height={18}
                      rx={3}
                      fill="#1a1a20"
                      stroke={color}
                    />
                    <text
                      x={mx}
                      y={(y1 + y2) / 2 + 3}
                      textAnchor="middle"
                      fill="#ddd"
                      fontSize={11}
                      fontFamily="system-ui, sans-serif"
                    >
                      {truncate(e.label, 13)}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          {connecting && (() => {
            const from = nodes.find((n) => n.id === connecting.fromId);
            if (!from) return null;
            const x1 = from.x + from.width;
            const y1 = from.y + effectiveHeight(from) / 2;
            const x2 = connecting.cursorX;
            const y2 = connecting.cursorY;
            const mx = (x1 + x2) / 2;
            const d = `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
            return (
              <path
                d={d}
                fill="none"
                stroke={connecting.hoverId ? "#8af" : "#888"}
                strokeWidth={2}
                strokeDasharray="4 3"
              />
            );
          })()}
        </svg>
        {nodes.map((n) => (
          <MeasuredNode
            key={n.id}
            node={n}
            selected={n.id === selectedId}
            hovered={connecting?.hoverId === n.id}
            showConnectHandle={!!onConnect && !n.noConnect}
            onMouseDown={(e) => onMouseDownNode(e, n)}
            onHandleMouseDown={(e) => onMouseDownConnectHandle(e, n)}
            onMeasure={(h) =>
              setMeasured((prev) => (prev[n.id] === h ? prev : { ...prev, [n.id]: h }))
            }
            renderNode={renderNode}
          />
        ))}
      </div>

      {/* Controls overlay */}
      <div style={{ position: "absolute", top: 6, right: 6, display: "flex", gap: 4, alignItems: "center", fontFamily: "system-ui, sans-serif" }}>
        <button onClick={fitAll} style={ctrlBtn} title="Fit all nodes">Fit</button>
        <button onClick={zoomReset} style={ctrlBtn} title="Reset zoom to 100% and center">100%</button>
        <button onClick={zoomToSelection} disabled={!selectedId} style={ctrlBtn} title="Center on selected node">Focus</button>
        <span style={{ fontSize: 11, color: "#888", marginLeft: 4 }}>{(zoom * 100).toFixed(0)}%</span>
      </div>
      <div style={{ position: "absolute", bottom: 6, right: 6, fontSize: 11, color: "#666", fontFamily: "system-ui, sans-serif" }}>
        Shift+drag = pan · Ctrl+wheel = zoom{onConnect ? " · drag from ● to connect" : ""}
      </div>
    </div>
  );
}

interface MeasuredNodeProps<T extends GraphNode> {
  node: T;
  selected: boolean;
  hovered: boolean;
  showConnectHandle: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onHandleMouseDown: (e: React.MouseEvent) => void;
  onMeasure: (height: number) => void;
  renderNode: (node: T, selected: boolean) => React.ReactNode;
}

function MeasuredNode<T extends GraphNode>({
  node,
  selected,
  hovered,
  showConnectHandle,
  onMouseDown,
  onHandleMouseDown,
  onMeasure,
  renderNode,
}: MeasuredNodeProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onMeasure(el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onMeasure]);
  return (
    <div
      ref={ref}
      onMouseDown={onMouseDown}
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: node.width,
        minHeight: node.height,
        cursor: "grab",
        userSelect: "none",
        outline: hovered ? "2px solid #8af" : undefined,
        outlineOffset: hovered ? 2 : undefined,
      }}
    >
      {renderNode(node, selected)}
      {showConnectHandle && (
        <div
          onMouseDown={onHandleMouseDown}
          title="Drag to another step to connect"
          style={{
            position: "absolute",
            right: -7,
            top: "50%",
            transform: "translateY(-50%)",
            width: 14,
            height: 14,
            borderRadius: 7,
            background: "#2b4d7a",
            border: "2px solid #8af",
            cursor: "crosshair",
          }}
        />
      )}
    </div>
  );
}

const ctrlBtn: React.CSSProperties = {
  padding: "2px 8px",
  background: "#1a1a22",
  color: "#ccc",
  border: "1px solid #333",
  borderRadius: 3,
  fontSize: 11,
  cursor: "pointer",
  fontFamily: "system-ui, sans-serif",
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
