import { useMemo, useState } from "react";
import { useBusinessStore } from "../../../game/business/businessStore";
import { businesses, businessKinds } from "../../../game/business/registry";
import { getEffectiveStats } from "../../../game/business/upgradeEffects";
import {
  selectInventorySlots,
  useGameStore,
} from "../../../game/store/gameStore";
import { CURRENCY_ITEM_ID } from "../../../game/inventory/items";
import { showToast } from "../../store/ui";

const QUICK_STEPS = [10, 100, 1000, 10000] as const;

export function Overview({ businessId }: { businessId: string }) {
  const state = useBusinessStore((s) => s.byId[businessId]);
  const slots = useGameStore(selectInventorySlots);
  const [depositAmt, setDepositAmt] = useState<string>("");
  const [withdrawAmt, setWithdrawAmt] = useState<string>("");

  const playerCoin = useMemo(() => {
    let t = 0;
    for (const s of slots) if (s?.itemId === CURRENCY_ITEM_ID) t += s.quantity;
    return t;
  }, [slots]);

  if (!state) return null;

  const def = businesses.tryGet(businessId);
  const kind = def ? businessKinds.tryGet(def.kindId) : null;
  const stats = kind ? getEffectiveStats(state, kind) : null;

  const draft = state.todaysDraft;
  const todaysNet = draft ? draft.revenue - draft.expenses - draft.wages : 0;
  const todaysWalkouts = draft?.walkouts ?? 0;
  const capacity = stats?.capacity ?? 0;
  const ledger = state.ledger.slice(-7);

  const depositN = Math.max(0, Math.floor(Number(depositAmt) || 0));
  const withdrawN = Math.max(0, Math.floor(Number(withdrawAmt) || 0));
  const depositInvalid = depositN > playerCoin;
  const withdrawInvalid = withdrawN > state.coffers;
  const depositDisabled = depositN <= 0 || depositInvalid;
  const withdrawDisabled = withdrawN <= 0 || withdrawInvalid;

  const tryDeposit = () => {
    if (depositDisabled) return;
    const res = useBusinessStore.getState().deposit(businessId, depositN);
    if (res.ok) {
      showToast(`Deposited ${depositN}g.`, 1300, "success");
      setDepositAmt("");
    } else {
      const msg: Record<string, string> = {
        insufficientFunds: "Not enough coin on hand.",
        notOwned: "You don't own this property.",
        invalidAmount: "Invalid amount.",
        unknownBusiness: "Unknown business.",
        inventoryFull: "Inventory full.",
      };
      showToast(msg[res.reason] ?? "Deposit failed.", 1800, "warn");
    }
  };

  const tryWithdraw = () => {
    if (withdrawDisabled) return;
    const res = useBusinessStore.getState().withdraw(businessId, withdrawN);
    if (res.ok) {
      showToast(`Withdrew ${withdrawN}g.`, 1300, "success");
      setWithdrawAmt("");
    } else {
      const msg: Record<string, string> = {
        insufficientFunds: "Coffers don't have that much.",
        notOwned: "You don't own this property.",
        invalidAmount: "Invalid amount.",
        unknownBusiness: "Unknown business.",
        inventoryFull: "Inventory full — make space first.",
      };
      showToast(msg[res.reason] ?? "Withdraw failed.", 1800, "warn");
    }
  };

  const bumpDeposit = (delta: number) =>
    setDepositAmt(String(Math.min(playerCoin, Math.max(0, depositN + delta))));
  const bumpWithdraw = (delta: number) =>
    setWithdrawAmt(
      String(Math.min(state.coffers, Math.max(0, withdrawN + delta))),
    );

  const purseAfterDeposit = playerCoin - depositN;
  const coffersAfterDeposit = state.coffers + depositN;
  const purseAfterWithdraw = playerCoin + withdrawN;
  const coffersAfterWithdraw = state.coffers - withdrawN;

  return (
    <div className="biz-overview">
      <div className="biz-kpi-row">
        <div className="biz-kpi" title="Coin held by this business">
          <span className="biz-kpi-label">Coffers</span>
          <span className="biz-kpi-value is-coin">{state.coffers}g</span>
        </div>
        <div className="biz-kpi" title="Coin you're carrying">
          <span className="biz-kpi-label">Purse</span>
          <span className="biz-kpi-value is-coin">{playerCoin}g</span>
        </div>
        <div
          className="biz-kpi"
          title={
            draft
              ? `${todaysWalkouts} walkout${todaysWalkouts === 1 ? "" : "s"} today`
              : "No activity yet today"
          }
        >
          <span className="biz-kpi-label">Today</span>
          <span
            className={`biz-kpi-value ${todaysNet >= 0 ? "is-pos" : "is-neg"}`}
          >
            {todaysNet >= 0 ? "+" : ""}
            {todaysNet}g
          </span>
        </div>
        <div className="biz-kpi" title="Max patrons at once">
          <span className="biz-kpi-label">Capacity</span>
          <span className="biz-kpi-value">{capacity}</span>
        </div>
        <div className="biz-kpi" title="Hidden from customers">
          <span className="biz-kpi-label">Rep</span>
          <span className="biz-kpi-value">{state.reputation}</span>
        </div>
      </div>

      <div className="biz-bank">
        <div className="biz-bank-flow">
          <span className="biz-bank-side">
            <span className="biz-bank-side-label">Purse</span>
            <span className="biz-bank-side-val is-coin">{playerCoin}g</span>
          </span>
          <span className="biz-bank-arrow" aria-hidden>
            ⇄
          </span>
          <span className="biz-bank-side">
            <span className="biz-bank-side-label">Coffers</span>
            <span className="biz-bank-side-val is-coin">{state.coffers}g</span>
          </span>
        </div>

        <div className="biz-bank-row">
          <span className="biz-bank-rowlabel">Deposit</span>
          <input
            id="biz-deposit"
            className="biz-bank-input"
            type="number"
            min={0}
            max={playerCoin}
            value={depositAmt}
            onChange={(e) => setDepositAmt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") tryDeposit();
            }}
            placeholder="0"
          />
          <div className="biz-bank-chips">
            {QUICK_STEPS.map((n) => (
              <button
                key={n}
                type="button"
                className="biz-chip"
                disabled={playerCoin < n && depositN === 0}
                onClick={() => bumpDeposit(n)}
              >
                +{n >= 1000 ? `${n / 1000}k` : n}
              </button>
            ))}
            <button
              type="button"
              className="biz-chip"
              disabled={playerCoin <= 0}
              onClick={() => setDepositAmt(String(playerCoin))}
            >
              Max
            </button>
            <button
              type="button"
              className="biz-chip"
              disabled={depositN === 0 && depositAmt === ""}
              onClick={() => setDepositAmt("")}
            >
              Clear
            </button>
          </div>
          <button
            type="button"
            className="biz-bank-action is-deposit"
            disabled={depositDisabled}
            onClick={tryDeposit}
          >
            Deposit
          </button>
        </div>
        <div
          className={`biz-bank-preview ${depositInvalid ? "is-warn" : ""}`}
        >
          {depositInvalid
            ? "Not enough coin on hand."
            : depositN > 0
              ? `Purse ${playerCoin}g → ${purseAfterDeposit}g · Coffers ${state.coffers}g → ${coffersAfterDeposit}g`
              : " "}
        </div>

        <div className="biz-bank-row">
          <span className="biz-bank-rowlabel">Withdraw</span>
          <input
            id="biz-withdraw"
            className="biz-bank-input"
            type="number"
            min={0}
            max={state.coffers}
            value={withdrawAmt}
            onChange={(e) => setWithdrawAmt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") tryWithdraw();
            }}
            placeholder="0"
          />
          <div className="biz-bank-chips">
            {QUICK_STEPS.map((n) => (
              <button
                key={n}
                type="button"
                className="biz-chip"
                disabled={state.coffers < n && withdrawN === 0}
                onClick={() => bumpWithdraw(n)}
              >
                +{n >= 1000 ? `${n / 1000}k` : n}
              </button>
            ))}
            <button
              type="button"
              className="biz-chip"
              disabled={state.coffers <= 0}
              onClick={() => setWithdrawAmt(String(state.coffers))}
            >
              Max
            </button>
            <button
              type="button"
              className="biz-chip"
              disabled={withdrawN === 0 && withdrawAmt === ""}
              onClick={() => setWithdrawAmt("")}
            >
              Clear
            </button>
          </div>
          <button
            type="button"
            className="biz-bank-action is-withdraw"
            disabled={withdrawDisabled}
            onClick={tryWithdraw}
          >
            Withdraw
          </button>
        </div>
        <div
          className={`biz-bank-preview ${withdrawInvalid ? "is-warn" : ""}`}
        >
          {withdrawInvalid
            ? "Coffers don't have that much."
            : withdrawN > 0
              ? `Coffers ${state.coffers}g → ${coffersAfterWithdraw}g · Purse ${playerCoin}g → ${purseAfterWithdraw}g`
              : " "}
        </div>
      </div>

      <Sparkline ledger={ledger} />
    </div>
  );
}

function Sparkline({
  ledger,
}: {
  ledger: ReadonlyArray<{
    revenue: number;
    expenses: number;
    wages: number;
  }>;
}) {
  const days = 7;
  const nets = ledger.map((d) => d.revenue - d.expenses - d.wages);
  const totals = ledger.reduce(
    (acc, d) => {
      acc.rev += d.revenue;
      acc.exp += d.expenses + d.wages;
      acc.net += d.revenue - d.expenses - d.wages;
      return acc;
    },
    { rev: 0, exp: 0, net: 0 },
  );
  const maxAbs = Math.max(1, ...nets.map((n) => Math.abs(n)));
  const w = 168;
  const h = 36;
  const pad = 2;
  const slot = (w - pad * 2) / days;
  const barW = Math.max(4, Math.floor(slot * 0.7));
  const mid = h / 2;

  return (
    <div className="biz-spark">
      <div className="biz-spark-head">
        <span className="biz-spark-title">Last 7 days</span>
        {ledger.length === 0 ? (
          <span className="biz-spark-empty">No history yet.</span>
        ) : (
          <span className="biz-spark-totals">
            Net{" "}
            <b className={totals.net >= 0 ? "is-pos" : "is-neg"}>
              {totals.net >= 0 ? "+" : ""}
              {totals.net}g
            </b>
            <span className="biz-spark-sep">·</span>
            Rev <b>{totals.rev}g</b>
            <span className="biz-spark-sep">·</span>
            Exp <b>{totals.exp}g</b>
          </span>
        )}
      </div>
      <svg className="biz-spark-svg" viewBox={`0 0 ${w} ${h}`} role="img">
        <line
          x1={0}
          x2={w}
          y1={mid}
          y2={mid}
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeDasharray="2 2"
        />
        {nets.map((n, i) => {
          const halfH = (Math.abs(n) / maxAbs) * (mid - 1);
          const x = pad + i * slot + (slot - barW) / 2;
          const y = n >= 0 ? mid - halfH : mid;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={barW}
              height={Math.max(1, halfH)}
              className={n >= 0 ? "biz-spark-bar is-pos" : "biz-spark-bar is-neg"}
            >
              <title>
                Day {ledger[i]?.revenue !== undefined ? "" : ""}
                Net {n >= 0 ? "+" : ""}
                {n}g
              </title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}
