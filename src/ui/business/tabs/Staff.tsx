import { useMemo, useState } from "react";
import { useBusinessStore } from "../../../game/business/businessStore";
import { businesses, businessKinds } from "../../../game/business/registry";
import {
  daysUntilSlateRefresh,
  fire,
  getHireable,
  getSlate,
  SLATE_REFRESH_DAYS,
  tryHire,
  type HireableDef,
} from "../../../game/business/hireables";
import { useTimeStore } from "../../../game/time/timeStore";
import { showToast } from "../../store/ui";

function Stars({ n }: { n: number }) {
  return (
    <span className="biz-stars" title={`Skill ${n}/5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={`biz-star ${i < n ? "is-on" : "is-off"}`}
          aria-hidden
        >
          ★
        </span>
      ))}
    </span>
  );
}

interface StaffProps {
  businessId: string;
}

export function Staff({ businessId }: StaffProps) {
  const state = useBusinessStore((s) => s.byId[businessId]);
  const dayCount = useTimeStore((s) => s.dayCount);
  const [hireOpen, setHireOpen] = useState(false);

  const def = businesses.tryGet(businessId);
  const kind = def ? businessKinds.tryGet(def.kindId) : null;

  const slate = useMemo(
    () => (kind ? getSlate(businessId, dayCount) : []),
    [businessId, dayCount, kind, state?.staff],
  );

  if (!state || !def || !kind) return null;

  const totalWages = state.staff.reduce((acc, h) => {
    const def = getHireable(h.hireableId);
    return acc + (def?.wagePerDay ?? 0);
  }, 0);
  const unpaidCount = state.staff.reduce(
    (a, h) => a + (h.unpaidDays > 0 ? 1 : 0),
    0,
  );

  const refreshIn = daysUntilSlateRefresh(dayCount);

  return (
    <div className="biz-staff">
      <div className="biz-kpi-row biz-staff-kpis">
        <div className="biz-kpi" title="Total people on payroll">
          <span className="biz-kpi-label">Roster</span>
          <span className="biz-kpi-value">{state.staff.length}</span>
        </div>
        <div className="biz-kpi" title="Wages owed per day">
          <span className="biz-kpi-label">Wages / day</span>
          <span className="biz-kpi-value is-coin">{totalWages}g</span>
        </div>
        <div
          className="biz-kpi"
          title="Number of staff with unpaid wages"
        >
          <span className="biz-kpi-label">Unpaid</span>
          <span
            className={`biz-kpi-value ${unpaidCount > 0 ? "is-neg" : ""}`}
          >
            {unpaidCount}
          </span>
        </div>
        <button
          type="button"
          className={`biz-bank-action ${hireOpen ? "is-withdraw" : "is-deposit"} biz-staff-hire-toggle`}
          onClick={() => setHireOpen((v) => !v)}
        >
          {hireOpen ? "Hide" : "Hire…"}
        </button>
      </div>

      {state.staff.length === 0 ? (
        <div className="biz-empty">No one on the payroll yet.</div>
      ) : (
        <ul className="biz-roster">
          {state.staff.map((hire) => {
            const def = getHireable(hire.hireableId);
            if (!def) return null;
            const role = kind.roles.find((r) => r.id === hire.roleId);
            return (
              <li key={hire.hireableId} className="biz-roster-row">
                <span className="biz-roster-name">{def.name}</span>
                <span className="biz-pill">{role?.id ?? hire.roleId}</span>
                <Stars n={def.skill} />
                <span className="biz-roster-wage is-coin">
                  {def.wagePerDay}g<span className="biz-roster-wage-unit">/day</span>
                </span>
                {hire.unpaidDays > 0 && (
                  <span
                    className="biz-roster-unpaid"
                    title={`Unpaid for ${hire.unpaidDays} day${hire.unpaidDays === 1 ? "" : "s"}`}
                  >
                    !{hire.unpaidDays}
                  </span>
                )}
                <button
                  type="button"
                  className="biz-mini-btn is-danger"
                  onClick={() => {
                    fire(businessId, hire.hireableId);
                    showToast(`${def.name} let go.`, 1500);
                  }}
                >
                  Fire
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {hireOpen && (
        <div className="biz-hire">
          <div className="biz-hire-head">
            <span className="biz-hire-title">Today's candidates</span>
            <span className="biz-hire-refresh">
              {refreshIn === 0
                ? "Fresh slate today."
                : `Refresh in ${refreshIn}d`}{" "}
              <span className="biz-hire-refresh-hint">
                (every {SLATE_REFRESH_DAYS}d)
              </span>
            </span>
          </div>
          {slate.length === 0 ? (
            <div className="biz-empty">No candidates available.</div>
          ) : (
            <ul className="biz-roster">
              {slate.map((cand) => (
                <CandidateCard
                  key={cand.id}
                  cand={cand}
                  kindRoles={kind.roles.map((r) => r.id)}
                  onHire={(roleId) => {
                    const res = tryHire(businessId, cand.id, roleId, dayCount);
                    if (res.ok) {
                      showToast(
                        `${cand.name} hired as ${roleId}.`,
                        1500,
                        "success",
                      );
                    } else {
                      const msg: Record<string, string> = {
                        unknownBusiness: "Unknown business.",
                        notOwned: "You don't own this property.",
                        unknownHireable: "Unknown candidate.",
                        unknownRole: "Candidate can't fill that role.",
                        alreadyHired: "Already on payroll.",
                      };
                      showToast(msg[res.reason] ?? "Hire failed.", 1800, "warn");
                    }
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

interface CandidateCardProps {
  cand: HireableDef;
  kindRoles: string[];
  onHire: (roleId: string) => void;
}

function CandidateCard({ cand, kindRoles, onHire }: CandidateCardProps) {
  const eligibleRoles = cand.roles.filter((r) => kindRoles.includes(r));
  const [picked, setPicked] = useState<string>(eligibleRoles[0] ?? "");
  if (eligibleRoles.length === 0) return null;
  return (
    <li className="biz-roster-row is-candidate">
      <span className="biz-roster-name">{cand.name}</span>
      <Stars n={cand.skill} />
      <span className="biz-roster-wage is-coin">
        {cand.wagePerDay}g<span className="biz-roster-wage-unit">/day</span>
      </span>
      {cand.traits.length > 0 && (
        <span className="biz-roster-traits" title={cand.traits.join(", ")}>
          {cand.traits.join(" · ")}
        </span>
      )}
      {eligibleRoles.length > 1 ? (
        <select
          className="biz-role-select"
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
        >
          {eligibleRoles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      ) : (
        <span className="biz-pill">{picked}</span>
      )}
      <button
        type="button"
        className="biz-mini-btn is-primary"
        disabled={!picked}
        onClick={() => onHire(picked)}
      >
        Hire
      </button>
    </li>
  );
}
