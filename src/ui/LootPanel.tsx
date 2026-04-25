import { useEffect } from "react";
import { bus } from "../game/bus";
import { ITEMS } from "../game/inventory/items";
import {
  selectChestLoot,
  selectOpenChestId,
  selectOpenChestName,
  useChestStore,
} from "../game/store/chestStore";

export function LootPanel() {
  const chestId = useChestStore(selectOpenChestId);
  const chestName = useChestStore(selectOpenChestName);
  const loot = useChestStore(selectChestLoot);

  useEffect(() => {
    if (!chestId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        bus.emitTyped("chest:close");
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [chestId]);

  if (!chestId) return null;

  const close = () => bus.emitTyped("chest:close");
  const takeAll = () => bus.emitTyped("chest:takeAll", { chestId });
  const take = (index: number) =>
    bus.emitTyped("chest:take", { chestId, index });

  return (
    <div className="shop-backdrop" onMouseDown={close}>
      <div
        className="px-panel shop-panel"
        role="dialog"
        aria-label={chestName}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ maxWidth: 420 }}
      >
        <div className="px-header">
          <span className="px-header-title">{chestName}</span>
          <button className="px-close" onClick={close} aria-label="Close chest">
            ×
          </button>
        </div>

        <div className="shop-list" style={{ minHeight: 100 }}>
          {loot.length === 0 ? (
            <div className="shop-empty">Empty.</div>
          ) : (
            loot.map((entry, i) => {
              const def = ITEMS[entry.itemId];
              if (!def) return null;
              return (
                <div className="shop-row" key={`${entry.itemId}-${i}`}>
                  <div className="px-slot shop-row-slot">
                    <img
                      className="shop-row-icon"
                      src={def.icon}
                      alt=""
                      draggable={false}
                    />
                    {entry.qty > 1 && (
                      <span className="px-slot-qty">{entry.qty}</span>
                    )}
                  </div>
                  <div className="shop-row-info">
                    <div className="shop-row-name">{def.name}</div>
                    <div className="shop-row-sub">×{entry.qty}</div>
                  </div>
                  <button
                    className="px-btn shop-row-btn"
                    onClick={() => take(i)}
                  >
                    Take
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="px-footer" style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
          <span>ESC to close</span>
          <button
            className="px-btn"
            onClick={takeAll}
            disabled={loot.length === 0}
          >
            Take all
          </button>
        </div>
      </div>
    </div>
  );
}
