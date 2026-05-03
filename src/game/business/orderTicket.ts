import type { BusinessId } from "./businessTypes";

/** Lifecycle of a single food order placed at the bar.
 *
 *  ordered    — placed at the bar, sitting in the queue
 *  cooking    — a cook has claimed it; cookLeftMs is ticking down at the stove
 *  ready      — finished, sitting on the pickup counter awaiting a server
 *  delivering — a server has picked it up and is carrying to the seat
 *  delivered  — placed in front of the customer; customer can eat
 *  paid       — payment recorded; ticket retires
 *
 *  Phase 2 collapses cooking→delivering: with no cook FSM yet, we tick down
 *  cookLeftMs internally and jump straight to "delivered" once it expires.
 *  Phase 3 will hand "ordered → cooking → ready" to a real cook agent.
 *  Phase 4 will hand "ready → delivering → delivered" to a real server.
 */
export type TicketState =
  | "ordered"
  | "cooking"
  | "ready"
  | "delivering"
  | "delivered"
  | "paid";

export interface Ticket {
  id: string;
  businessId: BusinessId;
  customerNpcId: string;
  seatUid: string;
  itemId: string;
  pricePerSale: number;
  cookTimeMs: number;
  cookLeftMs: number;
  state: TicketState;
  /** Set when a cook agent claims the ticket (phase 3+). */
  cookNpcId: string | null;
  /** Set when a server agent claims the ticket (phase 4+). */
  serverNpcId: string | null;
  /** ms since this ticket was created — used for soft-stale logging later. */
  ageMs: number;
}

let nextTicketSerial = 0;

export function makeTicket(opts: {
  businessId: BusinessId;
  customerNpcId: string;
  seatUid: string;
  itemId: string;
  pricePerSale: number;
  cookTimeMs: number;
}): Ticket {
  return {
    id: `ticket:${opts.businessId}:${++nextTicketSerial}`,
    businessId: opts.businessId,
    customerNpcId: opts.customerNpcId,
    seatUid: opts.seatUid,
    itemId: opts.itemId,
    pricePerSale: opts.pricePerSale,
    cookTimeMs: opts.cookTimeMs,
    cookLeftMs: opts.cookTimeMs,
    state: "ordered",
    cookNpcId: null,
    serverNpcId: null,
    ageMs: 0,
  };
}
