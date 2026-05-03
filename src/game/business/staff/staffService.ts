import type { NpcAgent } from "../../sim/npcAgent";
import type { BodyHandle } from "../../sim/bodyHandle";
import type { BusinessId, RoleId } from "../businessTypes";

/** Result of `clockIn`. The activity decides what to do with each.
 *  - `accepted` — handle has been transferred into the service; the staff
 *    FSM (cook / server / bartender role-agent inside CustomerSim) now drives
 *    the body. Activity drops its handle reference.
 *  - `rejected` — the service can't take this staffer (closed, role
 *    mismatch, no workstation, service missing). Activity should mark
 *    complete with a failure flag. */
export type ClockInResult =
  | { kind: "accepted" }
  | {
      kind: "rejected";
      reason:
        | "closed"
        | "wrong-business"
        | "unknown-role"
        | "no-workstation"
        | "service-missing"
        | "already-clocked-in";
    };

/** The interface a `CustomerSim` (or any future staff-running subsystem)
 *  exposes to delegated activities. Per-business; one provider per
 *  business id at a time. */
export interface StaffServiceProvider {
  clockIn(npc: NpcAgent, handle: BodyHandle, role: RoleId): ClockInResult;
  clockOut(npcId: string): void;
}

/** Subscriber for "this staffer's shift has ended and they've been released"
 *  notifications. The `WorkAtActivity` uses this to mark its FSM complete; the
 *  next activity in the day plan (e.g. `GoTo(home)`) may then re-claim the
 *  body. */
export type ShiftCompleteHandler = (npcId: string) => void;

const services = new Map<BusinessId, StaffServiceProvider>();
const completionListeners = new Map<BusinessId, Set<ShiftCompleteHandler>>();

/** Feature flag — when true, hired staff are registered as registry NPCs
 *  driving `WorkAt` activities, and CustomerSim's legacy synthetic-spawn
 *  path is suppressed for staff (mirrors the patron flag added in Phase 5).
 *  Default OFF in Phase 8 per the phase plan; flipped via the dev console
 *  for A/B comparison against the current behavior. Phase 9 deletes this
 *  flag and the legacy path together. */
export const npcRegistryStaff: { enabled: boolean } = { enabled: false };

export function registerStaffService(
  businessId: BusinessId,
  provider: StaffServiceProvider,
): void {
  services.set(businessId, provider);
}

export function unregisterStaffService(
  businessId: BusinessId,
  provider: StaffServiceProvider,
): void {
  if (services.get(businessId) === provider) services.delete(businessId);
}

export function getStaffService(
  businessId: BusinessId,
): StaffServiceProvider | null {
  return services.get(businessId) ?? null;
}

export function onShiftComplete(
  businessId: BusinessId,
  handler: ShiftCompleteHandler,
): () => void {
  let set = completionListeners.get(businessId);
  if (!set) {
    set = new Set();
    completionListeners.set(businessId, set);
  }
  set.add(handler);
  return () => {
    const s = completionListeners.get(businessId);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) completionListeners.delete(businessId);
  };
}

/** Called by the staff-running subsystem (CustomerSim) when a borrowed
 *  staffer's shift has fully completed and the held BodyHandle has been
 *  released. The activity listens for the matching `npcId` and marks itself
 *  complete. */
export function emitShiftComplete(businessId: BusinessId, npcId: string): void {
  const set = completionListeners.get(businessId);
  if (!set || set.size === 0) return;
  for (const fn of [...set]) {
    try { fn(npcId); } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[staffService] complete handler threw for '${businessId}':`, e);
    }
  }
}
