import type { NpcAgent } from "../../sim/npcAgent";
import type { BodyHandle } from "../../sim/bodyHandle";
import type { BusinessId } from "../businessTypes";

/** Result of `requestSeat`. The activity decides what to do with each.
 *  - `accepted` — handle has been transferred into the service; the patron
 *    FSM now drives the body. Activity drops its handle reference.
 *  - `queued` — service is full; activity may idle near the door for up to
 *    `etaMs + slack` and retry, or give up.
 *  - `rejected` — service can't take the patron at all (closed / no staff).
 *    Activity should mark complete with a failure flag. */
export type SeatRequestResult =
  | { kind: "accepted" }
  | { kind: "queued"; etaMs: number }
  | {
      kind: "rejected";
      reason: "closed" | "no-staff" | "no-seats" | "service-missing";
    };

/** The interface a `CustomerSim` (or any future patron-running subsystem)
 *  exposes to delegated activities. Per-business; one provider per
 *  business id at a time. */
export interface PatronServiceProvider {
  requestSeat(npc: NpcAgent, handle: BodyHandle): SeatRequestResult;
  releasePatron(npcId: string): void;
}

/** Subscriber for "this patron has finished and left" notifications. The
 *  activity uses this to mark its FSM complete; the next activity in the
 *  day plan may then re-claim the body. */
export type PatronCompleteHandler = (npcId: string) => void;

const services = new Map<BusinessId, PatronServiceProvider>();
const completionListeners = new Map<BusinessId, Set<PatronCompleteHandler>>();

export function registerPatronService(
  businessId: BusinessId,
  provider: PatronServiceProvider,
): void {
  services.set(businessId, provider);
}

export function unregisterPatronService(
  businessId: BusinessId,
  provider: PatronServiceProvider,
): void {
  if (services.get(businessId) === provider) services.delete(businessId);
}

export function getPatronService(
  businessId: BusinessId,
): PatronServiceProvider | null {
  return services.get(businessId) ?? null;
}

export function onPatronComplete(
  businessId: BusinessId,
  handler: PatronCompleteHandler,
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

/** Called by the patron-running subsystem (CustomerSim) when a borrowed
 *  patron's FSM has fully completed and the held BodyHandle has been
 *  released. The activity listens for the matching `npcId` and marks
 *  itself complete. */
export function emitPatronComplete(businessId: BusinessId, npcId: string): void {
  const set = completionListeners.get(businessId);
  if (!set || set.size === 0) return;
  for (const fn of [...set]) {
    try { fn(npcId); } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[patronService] complete handler threw for '${businessId}':`, e);
    }
  }
}
