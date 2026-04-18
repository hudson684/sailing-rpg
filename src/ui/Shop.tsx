import { useEffect, useMemo, useState } from "react";
import { bus } from "../game/bus";
import {
  CURRENCY_ITEM_ID,
  ITEMS,
  itemSellPrice,
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
import "./Shop.css";

type Tab = "buy" | "sell" | "buyback";

export function Shop() {
  const openShopId = useShopStore(selectOpenShopId);
  const instances = useShopStore(selectShopInstances);
  const slots = useGameStore(selectInventorySlots);
  const [tab, setTab] = useState<Tab>("buy");
  const [now, setNow] = useState(() => Date.now());

  // Listen for ESC to close, and subscribe to shop:open just to reset tab.
  useEffect(() => {
    if (!openShopId) return;
    setTab("buy");
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

  // Tick every second so restock countdown + buyback TTLs stay fresh.
  useEffect(() => {
    if (!openShopId) return;
    const id = window.setInterval(() => {
      useShopStore.getState().touchShop(openShopId);
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [openShopId]);

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

  const stockRows = aggregateStock(inst.stock);
  const buybackRows = inst.buyback.filter((b) => b.quantity > 0);
  const sellRows: Array<{ inventoryIndex: number; itemId: ItemId; quantity: number }> = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s || s.itemId === CURRENCY_ITEM_ID) continue;
    if (itemSellPrice(s.itemId) <= 0) continue;
    sellRows.push({ inventoryIndex: i, itemId: s.itemId, quantity: s.quantity });
  }

  const close = () => {
    useShopStore.getState().closeShop();
    bus.emitTyped("shop:close");
  };

  const toastOutcome = (res: { ok: boolean; reason?: string }, success: string) => {
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

  return (
    <div className="shop-backdrop" onMouseDown={close}>
      <div
        className="px-panel shop-panel"
        role="dialog"
        aria-label={shopDef.name}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-header">
          <span className="px-header-title">{shopDef.name}</span>
          <button className="px-close" onClick={close} aria-label="Close shop">
            ×
          </button>
        </div>

        <div className="shop-topline">
          <span className="shop-gold">
            Gold: <strong>{gold}</strong>
          </span>
          <span className="shop-restock">
            Restock in {formatDuration(restockSec)}
          </span>
        </div>

        {shopDef.greeting && <div className="shop-greeting">"{shopDef.greeting}"</div>}

        <div className="shop-tabs">
          <TabButton active={tab === "buy"} onClick={() => setTab("buy")}>
            Buy
          </TabButton>
          <TabButton active={tab === "sell"} onClick={() => setTab("sell")}>
            Sell
          </TabButton>
          <TabButton active={tab === "buyback"} onClick={() => setTab("buyback")}>
            Buyback
          </TabButton>
        </div>

        <div className="shop-list">
          {tab === "buy" &&
            (stockRows.length === 0 ? (
              <Empty>Sold out — check back after restock.</Empty>
            ) : (
              stockRows.map((row) => {
                const def = ITEMS[row.itemId];
                if (!def) return null;
                const price = def.value;
                const canAfford = gold >= price;
                return (
                  <Row
                    key={`buy-${row.itemId}`}
                    icon={def.icon}
                    name={def.name}
                    sub={def.description}
                    qty={row.quantity}
                    price={price}
                    priceLabel="buy"
                    action="Buy"
                    disabled={!canAfford || row.quantity <= 0}
                    onClick={() =>
                      toastOutcome(
                        useShopStore.getState().buy(openShopId, row.itemId, 1),
                        `Bought 1 ${def.name}.`,
                      )
                    }
                  />
                );
              })
            ))}

          {tab === "sell" &&
            (sellRows.length === 0 ? (
              <Empty>You have nothing worth selling.</Empty>
            ) : (
              sellRows.map((row) => {
                const def = ITEMS[row.itemId];
                if (!def) return null;
                const price = itemSellPrice(row.itemId);
                return (
                  <Row
                    key={`sell-${row.inventoryIndex}`}
                    icon={def.icon}
                    name={def.name}
                    sub={`Owned ×${row.quantity}`}
                    qty={row.quantity}
                    price={price}
                    priceLabel="sell"
                    action="Sell"
                    disabled={price <= 0}
                    onClick={() =>
                      toastOutcome(
                        useShopStore
                          .getState()
                          .sell(openShopId, row.inventoryIndex, 1),
                        `Sold 1 ${def.name}.`,
                      )
                    }
                  />
                );
              })
            ))}

          {tab === "buyback" &&
            (buybackRows.length === 0 ? (
              <Empty>Nothing to buy back yet.</Empty>
            ) : (
              buybackRows.map((row) => {
                const def = ITEMS[row.itemId];
                if (!def) return null;
                const price = itemSellPrice(row.itemId);
                const canAfford = gold >= price;
                const ttl = Math.max(0, Math.ceil((row.expiresAt - now) / 1000));
                return (
                  <Row
                    key={`bb-${row.itemId}`}
                    icon={def.icon}
                    name={def.name}
                    sub={`Expires in ${formatDuration(ttl)}`}
                    qty={row.quantity}
                    price={price}
                    priceLabel="buy"
                    action="Repurchase"
                    disabled={!canAfford}
                    onClick={() =>
                      toastOutcome(
                        useShopStore
                          .getState()
                          .buybackBuy(openShopId, row.itemId, 1),
                        `Bought back 1 ${def.name}.`,
                      )
                    }
                  />
                );
              })
            ))}
        </div>

        <div className="px-footer">
          Right-click to open · ESC / × to close · sell price = ½ buy price
        </div>
      </div>
    </div>
  );
}

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`px-btn shop-tab ${props.active ? "is-active" : ""}`}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function Row(props: {
  icon: string;
  name: string;
  sub?: string;
  qty: number;
  price: number;
  priceLabel: "buy" | "sell";
  action: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="shop-row">
      <div className="px-slot shop-row-slot">
        <img className="shop-row-icon" src={props.icon} alt="" draggable={false} />
        {props.qty > 1 && <span className="px-slot-qty">{props.qty}</span>}
      </div>
      <div className="shop-row-info">
        <div className="shop-row-name">{props.name}</div>
        {props.sub && <div className="shop-row-sub">{props.sub}</div>}
      </div>
      <div className="shop-row-price">
        <span className={`shop-row-coin shop-row-coin-${props.priceLabel}`}>
          {props.price}g
        </span>
      </div>
      <button
        className="px-btn shop-row-btn"
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.action}
      </button>
    </div>
  );
}

function Empty(props: { children: React.ReactNode }) {
  return <div className="shop-empty">{props.children}</div>;
}

function aggregateStock(stock: ShopInstance["stock"]) {
  const by: Record<string, number> = {};
  for (const s of stock) by[s.itemId] = (by[s.itemId] ?? 0) + s.quantity;
  return Object.entries(by)
    .filter(([, q]) => q > 0)
    .map(([itemId, quantity]) => ({ itemId, quantity }));
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

