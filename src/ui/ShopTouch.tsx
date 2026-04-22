import { useEffect, useMemo, useState } from "react";
import { bus } from "../game/bus";
import {
  CURRENCY_ITEM_ID,
  ITEMS,
  itemBuyLot,
  itemBuyPriceFor,
  itemIsSellable,
  itemSellLot,
  itemSellPriceFor,
  type ItemId,
} from "../game/inventory/items";
import { selectInventorySlots, useGameStore } from "../game/store/gameStore";
import {
  selectOpenShopId,
  selectShopInstances,
  useShopStore,
} from "../game/store/shopStore";
import { shops } from "../game/shops/shops";
import type { ShopInstance } from "../game/shops/types";
import { showToast } from "./store/ui";
import "./ShopTouch.css";

/**
 * Mobile-first shop UI. A full-screen modal with dense item rows so
 * several items are visible at once. Rows themselves carry no qty
 * controls — tapping a row selects it and opens a floating action bar
 * at the bottom with the qty stepper and the Buy/Sell button, mirroring
 * InventoryTouch's selection pattern.
 */

type Tab = "buy" | "sell" | "buyback";

type BuyRow = { kind: "buy"; key: string; itemId: ItemId; stockQty: number };
type SellRow = {
  kind: "sell";
  key: string;
  itemId: ItemId;
  inventoryIndex: number;
  ownedQty: number;
};
type BuybackRow = {
  kind: "buyback";
  key: string;
  itemId: ItemId;
  available: number;
  expiresAt: number;
};
type Row = BuyRow | SellRow | BuybackRow;

export function ShopTouch() {
  const openShopId = useShopStore(selectOpenShopId);
  const instances = useShopStore(selectShopInstances);
  const slots = useGameStore(selectInventorySlots);
  const [tab, setTab] = useState<Tab>("buy");
  const [now, setNow] = useState(() => Date.now());
  const [qtyByKey, setQtyByKey] = useState<Record<string, number>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!openShopId) return;
    setTab("buy");
    setQtyByKey({});
    setSelectedKey(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useShopStore.getState().closeShop();
        bus.emitTyped("shop:close");
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [openShopId]);

  useEffect(() => {
    if (!openShopId) return;
    const id = window.setInterval(() => {
      useShopStore.getState().touchShop(openShopId);
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [openShopId]);

  // Switching tabs clears selection so the bottom bar doesn't linger on
  // an item that isn't visible.
  useEffect(() => {
    setSelectedKey(null);
  }, [tab]);

  const shopDef = openShopId ? shops.tryGet(openShopId) : null;
  const inst: ShopInstance | null =
    openShopId && instances[openShopId] ? instances[openShopId] : null;

  const gold = useMemo(() => {
    let t = 0;
    for (const s of slots) if (s?.itemId === CURRENCY_ITEM_ID) t += s.quantity;
    return t;
  }, [slots]);

  if (!openShopId || !shopDef || !inst) return null;

  const restockSec = Math.max(0, Math.ceil((inst.restockAt - now) / 1000));

  const buyRows: BuyRow[] = aggregateStock(inst.stock).map((r) => ({
    kind: "buy",
    key: `buy:${r.itemId}`,
    itemId: r.itemId,
    stockQty: r.quantity,
  }));

  const sellRows: SellRow[] = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s || s.itemId === CURRENCY_ITEM_ID) continue;
    if (!itemIsSellable(s.itemId)) continue;
    sellRows.push({
      kind: "sell",
      key: `sell:${i}`,
      itemId: s.itemId,
      inventoryIndex: i,
      ownedQty: s.quantity,
    });
  }

  const buybackRows: BuybackRow[] = inst.buyback
    .filter((b) => b.quantity > 0)
    .map((b) => ({
      kind: "buyback",
      key: `bb:${b.itemId}`,
      itemId: b.itemId,
      available: b.quantity,
      expiresAt: b.expiresAt,
    }));

  const rows: Row[] =
    tab === "buy" ? buyRows : tab === "sell" ? sellRows : buybackRows;

  const close = () => {
    useShopStore.getState().closeShop();
    bus.emitTyped("shop:close");
  };

  const getQty = (key: string, max: number, lot: number) => {
    const raw = qtyByKey[key] ?? lot;
    const clamped = Math.max(lot, Math.min(max > 0 ? max : lot, raw));
    return clamped - (clamped % lot);
  };
  const setQty = (key: string, value: number, max: number, lot: number) => {
    const floored = Math.max(lot, Math.floor(value) || lot);
    const bounded = Math.min(max > 0 ? max : lot, floored);
    const snapped = bounded - (bounded % lot);
    setQtyByKey((prev) => ({ ...prev, [key]: Math.max(lot, snapped) }));
  };

  const toastOutcome = (
    res: { ok: boolean; reason?: string },
    success: string,
  ) => {
    if (res.ok) {
      showToast(success, 1300, "success");
      return;
    }
    const msg: Record<string, string> = {
      out_of_stock: "Out of stock.",
      not_enough_coins: "Not enough coins.",
      inventory_full: "Inventory full.",
      not_owned: "Nothing to sell.",
      not_sellable: "This item has no resale value.",
      unknown_item: "Unknown item.",
      unknown_shop: "Shop unavailable.",
    };
    showToast(msg[res.reason ?? ""] ?? "Can't do that.", 1800, "warn");
  };

  const rowContext = (row: Row) => {
    if (row.kind === "buy") {
      const lot = itemBuyLot(row.itemId);
      const lotPrice = itemBuyPriceFor(row.itemId, lot);
      const affordableLots = lotPrice > 0 ? Math.floor(gold / lotPrice) : Math.floor(row.stockQty / lot);
      const stockLots = Math.floor(row.stockQty / lot);
      const max = Math.max(0, Math.min(stockLots, affordableLots)) * lot;
      const n = getQty(row.key, max, lot);
      return {
        lot,
        lotPrice,
        max,
        n,
        total: itemBuyPriceFor(row.itemId, n),
        priceTone: "buy" as const,
        actionLabel: "Buy",
      };
    }
    if (row.kind === "sell") {
      const lot = itemSellLot(row.itemId);
      const lotPrice = itemSellPriceFor(row.itemId, lot);
      const max = Math.floor(row.ownedQty / lot) * lot;
      const n = getQty(row.key, max, lot);
      return {
        lot,
        lotPrice,
        max,
        n,
        total: itemSellPriceFor(row.itemId, n),
        priceTone: "sell" as const,
        actionLabel: "Sell",
      };
    }
    const lot = itemSellLot(row.itemId);
    const lotPrice = itemSellPriceFor(row.itemId, lot);
    const affordableLots = lotPrice > 0 ? Math.floor(gold / lotPrice) : Math.floor(row.available / lot);
    const stockLots = Math.floor(row.available / lot);
    const max = Math.max(0, Math.min(stockLots, affordableLots)) * lot;
    const n = getQty(row.key, max, lot);
    return {
      lot,
      lotPrice,
      max,
      n,
      total: itemSellPriceFor(row.itemId, n),
      priceTone: "buy" as const,
      actionLabel: "Repurchase",
    };
  };

  const commit = (row: Row) => {
    const ctx = rowContext(row);
    if (ctx.max <= 0) return;
    const def = ITEMS[row.itemId];
    if (!def) return;
    if (row.kind === "buy") {
      toastOutcome(
        useShopStore.getState().buy(openShopId, row.itemId, ctx.n),
        `Bought ${ctx.n} ${def.name}.`,
      );
    } else if (row.kind === "sell") {
      toastOutcome(
        useShopStore.getState().sell(openShopId, row.inventoryIndex, ctx.n),
        `Sold ${ctx.n} ${def.name}.`,
      );
    } else {
      toastOutcome(
        useShopStore.getState().buybackBuy(openShopId, row.itemId, ctx.n),
        `Bought back ${ctx.n} ${def.name}.`,
      );
    }
  };

  const selectedRow = rows.find((r) => r.key === selectedKey) ?? null;

  return (
    <>
      <div
        className="shop-touch-backdrop"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div
          className="px-panel shop-touch-modal"
          role="dialog"
          aria-label={shopDef.name}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="shop-touch-header">
            <div className="shop-touch-title">{shopDef.name}</div>
            <div className="shop-touch-summary">
              <span className="shop-touch-chip">
                <span className="shop-touch-chip-label">Gold</span>
                <span className="shop-touch-chip-value shop-touch-chip-gold">
                  {gold}
                </span>
              </span>
              <span className="shop-touch-chip">
                <span className="shop-touch-chip-label">Restock</span>
                <span className="shop-touch-chip-value">
                  {formatDuration(restockSec)}
                </span>
              </span>
            </div>
            <button
              className="px-close shop-touch-close"
              onClick={close}
              aria-label="Close shop"
            >
              ×
            </button>
          </div>

          {shopDef.greeting && (
            <div className="shop-touch-greeting">"{shopDef.greeting}"</div>
          )}

          <div className="shop-touch-tabs" role="tablist">
            <TabButton active={tab === "buy"} onClick={() => setTab("buy")}>
              Buy
            </TabButton>
            <TabButton active={tab === "sell"} onClick={() => setTab("sell")}>
              Sell
            </TabButton>
            <TabButton
              active={tab === "buyback"}
              onClick={() => setTab("buyback")}
            >
              Buyback
            </TabButton>
          </div>

          <div className="shop-touch-list">
            {rows.length === 0 ? (
              <div className="shop-touch-empty">
                {tab === "buy"
                  ? "Sold out — check back after restock."
                  : tab === "sell"
                    ? "You have nothing worth selling."
                    : "Nothing to buy back yet."}
              </div>
            ) : (
              rows.map((row) => (
                <ShopTouchRow
                  key={row.key}
                  row={row}
                  now={now}
                  ctx={rowContext(row)}
                  selected={row.key === selectedKey}
                  onTap={() =>
                    setSelectedKey((curr) => (curr === row.key ? null : row.key))
                  }
                />
              ))
            )}
          </div>
        </div>
      </div>

      {selectedRow && (
        <ShopTouchActionBar
          row={selectedRow}
          ctx={rowContext(selectedRow)}
          onQtyChange={(v) => {
            const c = rowContext(selectedRow);
            setQty(selectedRow.key, v, c.max, c.lot);
          }}
          onCommit={() => commit(selectedRow)}
          onCancel={() => setSelectedKey(null)}
        />
      )}
    </>
  );
}

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={props.active}
      className={"px-btn shop-touch-tab" + (props.active ? " is-active" : "")}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

interface RowContext {
  lot: number;
  lotPrice: number;
  max: number;
  n: number;
  total: number;
  priceTone: "buy" | "sell";
  actionLabel: string;
}

function ShopTouchRow(props: {
  row: Row;
  now: number;
  ctx: RowContext;
  selected: boolean;
  onTap: () => void;
}) {
  const { row, ctx, selected, onTap } = props;
  const def = ITEMS[row.itemId];
  if (!def) return null;

  const ownedOrStock =
    row.kind === "buy"
      ? row.stockQty
      : row.kind === "sell"
        ? row.ownedQty
        : row.available;

  let sub: string;
  if (row.kind === "buy") {
    sub =
      ctx.lot > 1
        ? `${ctx.lot} for ${ctx.lotPrice}g · Stock ×${row.stockQty}`
        : `${ctx.lotPrice}g each · Stock ×${row.stockQty}`;
  } else if (row.kind === "sell") {
    sub =
      ctx.lot > 1
        ? `${ctx.lot} for ${ctx.lotPrice}g · Owned ×${row.ownedQty}`
        : `${ctx.lotPrice}g each · Owned ×${row.ownedQty}`;
  } else {
    const ttl = Math.max(0, Math.ceil((row.expiresAt - props.now) / 1000));
    sub = `Expires in ${formatDuration(ttl)} · ×${row.available}`;
  }

  const disabled = ctx.max <= 0;

  return (
    <button
      type="button"
      className={
        "shop-touch-row" +
        (selected ? " is-selected" : "") +
        (disabled ? " is-disabled" : "")
      }
      onClick={onTap}
      aria-pressed={selected}
      aria-label={`${def.name} — ${ctx.lotPrice}g`}
    >
      <div className="px-slot shop-touch-row-slot">
        <img
          className="shop-touch-row-icon"
          src={def.icon}
          alt=""
          draggable={false}
        />
        {ownedOrStock > 1 && (
          <span className="px-slot-qty">{formatQty(ownedOrStock)}</span>
        )}
      </div>
      <div className="shop-touch-row-info">
        <div className="shop-touch-row-name">{def.name}</div>
        <div className="shop-touch-row-sub">{sub}</div>
      </div>
      <div
        className={`shop-touch-row-price shop-touch-row-price-${ctx.priceTone}`}
      >
        {ctx.lotPrice}g
      </div>
    </button>
  );
}

function ShopTouchActionBar(props: {
  row: Row;
  ctx: RowContext;
  onQtyChange: (v: number) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { row, ctx } = props;
  const def = ITEMS[row.itemId];
  if (!def) return null;

  const stepDisabled = ctx.max <= ctx.lot;
  const commitDisabled = ctx.max <= 0;
  const variant =
    row.kind === "sell" ? "px-btn-green" : "px-btn-red";

  return (
    <div
      className="shop-touch-actionbar"
      role="toolbar"
      aria-label="Shop actions"
    >
      <div className="shop-touch-actionbar-head">
        <img
          className="shop-touch-actionbar-icon"
          src={def.icon}
          alt=""
          draggable={false}
        />
        <div className="shop-touch-actionbar-info">
          <div className="shop-touch-actionbar-name">{def.name}</div>
          <div className="shop-touch-actionbar-total">
            Total{" "}
            <strong className={`shop-touch-total-${ctx.priceTone}`}>
              {ctx.total}g
            </strong>
          </div>
        </div>
        <button
          className="px-btn px-btn-grey shop-touch-actionbar-cancel"
          onClick={props.onCancel}
          aria-label="Cancel selection"
        >
          ×
        </button>
      </div>
      <div className="shop-touch-actionbar-controls">
        <button
          className="px-btn shop-touch-qty-btn"
          disabled={stepDisabled || ctx.n <= ctx.lot}
          onClick={() => props.onQtyChange(ctx.n - ctx.lot)}
          aria-label="Decrease quantity"
        >
          −
        </button>
        <input
          className="shop-touch-qty-input"
          type="number"
          min={ctx.lot}
          max={Math.max(ctx.lot, ctx.max)}
          step={ctx.lot}
          value={ctx.n}
          onChange={(e) => props.onQtyChange(Number(e.target.value))}
          aria-label="Quantity"
        />
        <button
          className="px-btn shop-touch-qty-btn"
          disabled={stepDisabled || ctx.n >= ctx.max}
          onClick={() => props.onQtyChange(ctx.n + ctx.lot)}
          aria-label="Increase quantity"
        >
          +
        </button>
        <button
          className="px-btn shop-touch-qty-max"
          disabled={ctx.max <= ctx.lot || ctx.n >= ctx.max}
          onClick={() => props.onQtyChange(ctx.max)}
          aria-label="Max quantity"
        >
          Max
        </button>
        <button
          className={`px-btn shop-touch-commit ${variant}`}
          disabled={commitDisabled}
          onClick={props.onCommit}
        >
          {ctx.actionLabel} ×{ctx.n}
        </button>
      </div>
    </div>
  );
}

function aggregateStock(stock: ShopInstance["stock"]) {
  const by: Record<string, number> = {};
  for (const s of stock) by[s.itemId] = (by[s.itemId] ?? 0) + s.quantity;
  return Object.entries(by)
    .filter(([, q]) => q > 0)
    .map(([itemId, quantity]) => ({ itemId: itemId as ItemId, quantity }));
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

function formatQty(n: number): string {
  if (n >= 1_000_000) return `${Math.floor(n / 100_000) / 10}M`;
  if (n >= 10_000) return `${Math.floor(n / 1000)}K`;
  return String(n);
}
