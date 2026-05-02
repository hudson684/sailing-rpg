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

function stars(n: number): string {
  return "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n));
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

  const refreshIn = daysUntilSlateRefresh(dayCount);

  return (
    <div className="biz-staff">
      <div className="biz-staff-header">
        <div className="biz-staff-summary">
          <span className="biz-card-label">Roster</span>
          <span className="biz-card-value">{state.staff.length}</span>
        </div>
        <div className="biz-staff-summary">
          <span className="biz-card-label">Daily wages</span>
          <span className="biz-card-value is-coin">{totalWages}g</span>
        </div>
        <button
          className="px-btn"
          onClick={() => setHireOpen((v) => !v)}
        >
          {hireOpen ? "Hide candidates" : "Hire…"}
        </button>
      </div>

      {state.staff.length === 0 ? (
        <div className="biz-stub">No one on the payroll yet.</div>
      ) : (
        <ul className="biz-staff-list">
          {state.staff.map((hire) => {
            const def = getHireable(hire.hireableId);
            if (!def) return null;
            const role = kind.roles.find((r) => r.id === hire.roleId);
            return (
              <li key={hire.hireableId} className="biz-staff-row">
                <span className="biz-staff-name">{def.name}</span>
                <span className="biz-staff-role">{role?.id ?? hire.roleId}</span>
                <span className="biz-staff-skill" title={`Skill ${def.skill}/5`}>
                  {stars(def.skill)}
                </span>
                <span className="biz-staff-wage is-coin">{def.wagePerDay}g/day</span>
                {hire.unpaidDays > 0 && (
                  <span className="biz-staff-unpaid" title="Unpaid days">
                    !{hire.unpaidDays}
                  </span>
                )}
                <button
                  className="px-btn"
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
        <div className="biz-hire-panel">
          <div className="biz-hire-header">
            <span className="biz-card-label">Today's candidates</span>
            <span className="biz-card-sub">
              {refreshIn === 0
                ? "Fresh slate today."
                : `Next refresh in ${refreshIn} day${refreshIn === 1 ? "" : "s"}.`}
              {" "}
              (every {SLATE_REFRESH_DAYS} days)
            </span>
          </div>
          {slate.length === 0 ? (
            <div className="biz-stub">No candidates available.</div>
          ) : (
            <ul className="biz-hire-list">
              {slate.map((cand) => (
                <CandidateCard
                  key={cand.id}
                  cand={cand}
                  kindRoles={kind.roles.map((r) => r.id)}
                  onHire={(roleId) => {
                    const res = tryHire(businessId, cand.id, roleId, dayCount);
                    if (res.ok) {
                      showToast(`${cand.name} hired as ${roleId}.`, 1500, "success");
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
    <li className="biz-hire-row">
      <span className="biz-staff-name">{cand.name}</span>
      <span className="biz-staff-skill" title={`Skill ${cand.skill}/5`}>
        {stars(cand.skill)}
      </span>
      <span className="biz-staff-wage is-coin">{cand.wagePerDay}g/day</span>
      {cand.traits.length > 0 && (
        <span className="biz-staff-traits">{cand.traits.join(", ")}</span>
      )}
      <select
        className="biz-portfolio-select"
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
      >
        {eligibleRoles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button
        className="px-btn"
        disabled={!picked}
        onClick={() => onHire(picked)}
      >
        Hire
      </button>
    </li>
  );
}
