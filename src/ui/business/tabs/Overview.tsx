import { useMemo, useState } from "react";
import { useBusinessStore } from "../../../game/business/businessStore";
import {
  selectInventorySlots,
  useGameStore,
} from "../../../game/store/gameStore";
import { CURRENCY_ITEM_ID } from "../../../game/inventory/items";
import { showToast } from "../../store/ui";

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

  const todaysNet = 0;
  const capacityUtilPct = 0;
  const ledger = state.ledger.slice(-7);

  const tryDeposit = () => {
    const n = Math.floor(Number(depositAmt));
    if (!Number.isFinite(n) || n <= 0) {
      showToast("Enter a positive amount.", 1500, "warn");
      return;
    }
    const res = useBusinessStore.getState().deposit(businessId, n);
    if (res.ok) {
      showToast(`Deposited ${n} coin.`, 1300, "success");
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
    const n = Math.floor(Number(withdrawAmt));
    if (!Number.isFinite(n) || n <= 0) {
      showToast("Enter a positive amount.", 1500, "warn");
      return;
    }
    const res = useBusinessStore.getState().withdraw(businessId, n);
    if (res.ok) {
      showToast(`Withdrew ${n} coin.`, 1300, "success");
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

  const depositN = Math.max(0, Math.floor(Number(depositAmt) || 0));
  const withdrawN = Math.max(0, Math.floor(Number(withdrawAmt) || 0));
  const depositDisabled = depositN <= 0 || depositN > playerCoin;
  const withdrawDisabled = withdrawN <= 0 || withdrawN > state.coffers;

  return (
    <div className="biz-overview">
      <div className="biz-card">
        <span className="biz-card-label">Coffers</span>
        <span className="biz-card-value is-coin">{state.coffers}g</span>
        <span className="biz-card-sub">On hand: {playerCoin}g</span>
      </div>
      <div className="biz-card">
        <span className="biz-card-label">Today's net</span>
        <span className="biz-card-value">{todaysNet}g</span>
        <span className="biz-card-sub">No data yet.</span>
      </div>
      <div className="biz-card">
        <span className="biz-card-label">Capacity</span>
        <span className="biz-card-value">{capacityUtilPct}%</span>
        <span className="biz-card-sub">No patrons yet.</span>
      </div>
      <div className="biz-card">
        <span className="biz-card-label">Reputation</span>
        <span className="biz-card-value">{state.reputation}</span>
        <span className="biz-card-sub">Hidden from customers.</span>
      </div>

      <div className="biz-chart">
        {ledger.length === 0 ? "No history." : `${ledger.length} day(s) logged.`}
      </div>

      <div className="biz-wallet">
        <div className="biz-wallet-row">
          <label htmlFor="biz-deposit">Deposit</label>
          <input
            id="biz-deposit"
            className="biz-wallet-input"
            type="number"
            min={0}
            max={playerCoin}
            value={depositAmt}
            onChange={(e) => setDepositAmt(e.target.value)}
            placeholder="0"
          />
          <span className="biz-card-sub">→ coffers</span>
          <div className="biz-wallet-actions">
            <button
              className="px-btn"
              disabled={depositDisabled}
              onClick={tryDeposit}
            >
              Deposit
            </button>
          </div>
        </div>
        <div className="biz-wallet-row">
          <label htmlFor="biz-withdraw">Withdraw</label>
          <input
            id="biz-withdraw"
            className="biz-wallet-input"
            type="number"
            min={0}
            max={state.coffers}
            value={withdrawAmt}
            onChange={(e) => setWithdrawAmt(e.target.value)}
            placeholder="0"
          />
          <span className="biz-card-sub">→ purse</span>
          <div className="biz-wallet-actions">
            <button
              className="px-btn"
              disabled={withdrawDisabled}
              onClick={tryWithdraw}
            >
              Withdraw
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

