import { useEffect, useState } from "react";
import { bus } from "../../game/bus";
import { useBusinessStore } from "../../game/business/businessStore";
import { businesses as businessRegistry } from "../../game/business/registry";
import { Overview } from "./tabs/Overview";
import { Staff } from "./tabs/Staff";
import "./BusinessManager.css";

type Tab = "overview" | "staff" | "upgrades" | "stock" | "books";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "staff", label: "Staff" },
  { id: "upgrades", label: "Upgrades" },
  { id: "stock", label: "Stock" },
  { id: "books", label: "Books" },
];

export function BusinessManager() {
  const [open, setOpen] = useState(false);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  // Subscribe to the store so portfolio + Overview re-render after purchase /
  // withdraw / deposit. The selector returns the byId record by reference.
  const byId = useBusinessStore((s) => s.byId);

  useEffect(() => {
    const onOpen = ({ businessId: id }: { businessId: string }) => {
      setBusinessId(id);
      setTab("overview");
      setOpen(true);
    };
    const onClose = () => setOpen(false);
    bus.onTyped("business:open", onOpen);
    bus.onTyped("business:close", onClose);
    return () => {
      bus.offTyped("business:open", onOpen);
      bus.offTyped("business:close", onClose);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [open]);

  if (!open || !businessId) return null;

  const state = byId[businessId];
  const def = businessRegistry.tryGet(businessId);
  if (!state || !def || !state.owned) return null;

  const ownedIds = Object.values(byId)
    .filter((b) => b.owned)
    .map((b) => b.id);

  const close = () => {
    setOpen(false);
    bus.emitTyped("business:close");
  };

  return (
    <div className="biz-backdrop" onMouseDown={close}>
      <div
        className="px-panel biz-panel"
        role="dialog"
        aria-label={def.displayName}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-header">
          <span className="px-header-title">{def.displayName}</span>
          <button
            className="px-close"
            onClick={close}
            aria-label="Close manage panel"
          >
            ×
          </button>
        </div>

        {ownedIds.length > 1 && (
          <div className="biz-portfolio">
            <label className="biz-portfolio-label" htmlFor="biz-portfolio-select">
              Property
            </label>
            <select
              id="biz-portfolio-select"
              className="biz-portfolio-select"
              value={businessId}
              onChange={(e) => setBusinessId(e.target.value)}
            >
              {ownedIds.map((id) => {
                const d = businessRegistry.tryGet(id);
                return (
                  <option key={id} value={id}>
                    {d?.displayName ?? id}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        <div className="biz-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`biz-tab ${tab === t.id ? "is-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="biz-body">
          {tab === "overview" && <Overview businessId={businessId} />}
          {tab === "staff" && <Staff businessId={businessId} />}
          {tab !== "overview" && tab !== "staff" && (
            <div className="biz-stub">Coming soon.</div>
          )}
        </div>

        <div className="px-footer biz-footer">
          ESC / × to close
        </div>
      </div>
    </div>
  );
}
