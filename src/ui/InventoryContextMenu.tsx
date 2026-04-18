import { useEffect } from "react";
import "./InventoryContextMenu.css";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  variant?: "default" | "danger";
}

export interface InventoryContextMenuProps {
  /** Client-coordinate (viewport) anchor point. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Lightweight pixel-styled popup. Mounts at a viewport point and auto-closes
 * on outside click, Escape, scroll, or window resize. Keep the item count
 * small — this is not meant to be a nested menu.
 */
export function InventoryContextMenu(props: InventoryContextMenuProps) {
  useEffect(() => {
    const close = () => props.onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onPointer = () => close();
    window.addEventListener("keydown", onKey, { capture: true });
    // Delay pointer handler by a tick so the right-click that opened us
    // doesn't immediately close.
    const t = window.setTimeout(() => {
      window.addEventListener("pointerdown", onPointer);
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [props]);

  return (
    <div
      className="ctx-menu"
      style={{ left: props.x, top: props.y }}
      role="menu"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {props.items.map((it, i) => (
        <button
          key={i}
          className={"ctx-menu-item" + (it.variant === "danger" ? " is-danger" : "")}
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            if (it.disabled) return;
            it.onSelect();
            props.onClose();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
