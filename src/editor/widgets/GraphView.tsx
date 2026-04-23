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
    onBackgroundClick,
    renderNode,
    minWidth = 1200,
    minHeight = 800,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  // Auto-fit bounds.
  const bounds = useMemo(() => {
    if (nodes.length === 0) return { w: minWidth, h: minHeight };
    let maxX = 0;
    let maxY = 0;
    for (const n of nodes) {
      maxX = Math.max(maxX, n.x + n.width + 100);
      maxY = Math.max(maxY, n.y + n.height + 100);
    }
    return { w: Math.max(minWidth, maxX), h: Math.max(minHeight, maxY) };
  }, [nodes, minWidth, minHeight]);

  // Drag state.
  const dragRef = useRef<
    | { mode: "pan"; startX: number; startY: number; panX: number; panY: number }
    | { mode: "node"; id: string; startX: number; startY: number; nodeX: number; nodeY: number }
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

  const onMouseDownBg = (e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 1 || e.shiftKey) {
      // Pan.
      dragRef.current = { mode: "pan", startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
      return;
    }
    // Background click — clear selection + report local coords.
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
      }
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onNodeMove, zoom]);

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(2, Math.max(0.25, zoom * factor));
    // Keep cursor anchored.
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
        cursor: dragRef.current?.mode === "pan" ? "grabbing" : "default",
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
          </defs>
          {edges.map((e) => {
            const from = nodes.find((n) => n.id === e.from);
            const to = nodes.find((n) => n.id === e.to);
            if (!from || !to) return null;
            const x1 = from.x + from.width;
            const y1 = from.y + from.height / 2;
            const x2 = to.x;
            const y2 = to.y + to.height / 2;
            const mx = (x1 + x2) / 2;
            const d = `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
            const color = e.color ?? "#666";
            return (
              <g key={e.id}>
                <path
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  markerEnd={color === "#e0b060" ? "url(#arrow-hi)" : "url(#arrow)"}
                />
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
        </svg>
        {nodes.map((n) => (
          <div
            key={n.id}
            onMouseDown={(e) => onMouseDownNode(e, n)}
            style={{
              position: "absolute",
              left: n.x,
              top: n.y,
              width: n.width,
              minHeight: n.height,
              cursor: onNodeMove ? "grab" : "pointer",
              userSelect: "none",
            }}
          >
            {renderNode(n, n.id === selectedId)}
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", top: 6, right: 6, fontSize: 11, color: "#888" }}>
        Shift+drag to pan · Ctrl+wheel to zoom · {(zoom * 100).toFixed(0)}%
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
