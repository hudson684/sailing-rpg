import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { bus } from "../bus";
import { entityRegistry } from "../entities/registry";
import { NpcModel } from "../entities/NpcModel";
import { useTimeStore } from "../time/timeStore";
import { useBusinessStore } from "./businessStore";
import { businesses, businessKinds } from "./registry";
import { statusForPhase } from "./schedule";
import { getEffectiveStats, staffByRole } from "./upgradeEffects";
import type {
  BusinessId,
  BusinessKindDef,
  CustomerProfileDef,
  HiredNpc,
  RevenueSourceDef,
  RoleDef,
} from "./businessTypes";
import type { SeatSpawn, WorkstationSpawn } from "../world/spawns";
import type { InteriorTilemap } from "../world/interiorTilemap";
import { makeTicket, type Ticket } from "./orderTicket";

/** Mean dwell time (ms) for a tavern visit's seated portion: order service +
 *  eat + pay service. Used by `requestSeat` to estimate queue ETA. */
const MEAN_DWELL_MS = 4_000 + 6_000 + 4_000;
import { itemIconTextureKey } from "../assets/keys";
import { pathfindPx, pathStale, type Waypoint } from "../world/pathfinding";
import type { NpcAgent } from "../sim/npcAgent";
import type { BodyHandle } from "../sim/bodyHandle";
import {
  emitPatronComplete,
  registerPatronService,
  unregisterPatronService,
  type PatronServiceProvider,
  type SeatRequestResult,
} from "./customerSim/patronService";
import {
  emitShiftComplete,
  npcRegistryStaff,
  registerStaffService,
  unregisterStaffService,
  type ClockInResult,
  type StaffServiceProvider,
} from "./staff/staffService";

// ─── Cook agent state ────────────────────────────────────────────────────

const STAFF_SPEED = 32; // px/s — staff move a touch slower than customers

// ─── Dev logging ─────────────────────────────────────────────────────────
// Gated on import.meta.env.DEV so prod bundles ship without the strings or
// the call sites' stringified state names. Logs every FSM state transition
// for customers / cooks / servers, plus a "stuck" warning when a scripted
// agent's step is blocked by collision and silently treated as arrived
// (the most common pathing failure mode).

const DEV_LOG = import.meta.env.DEV;

function dlog(tag: string, ...args: unknown[]): void {
  if (!DEV_LOG) return;
  // eslint-disable-next-line no-console
  console.log(`[tavern ${tag}]`, ...args);
}

function dwarn(tag: string, ...args: unknown[]): void {
  if (!DEV_LOG) return;
  // eslint-disable-next-line no-console
  console.warn(`[tavern ${tag}]`, ...args);
}

function shortNpcId(id: string): string {
  // npc:staff:<bizId>:<hireableId> → staff:<hireableId>
  // customer:<bizId>:<n> → cust:<n>
  if (id.startsWith("npc:staff:")) {
    const parts = id.split(":");
    return `staff:${parts[parts.length - 1]}`;
  }
  if (id.startsWith("customer:")) {
    const parts = id.split(":");
    return `cust:${parts[parts.length - 1]}`;
  }
  return id;
}

type CookState = "idle" | "walkToStove" | "cooking" | "walkToPickup" | "returning";

interface CookAgent {
  npcId: string;
  state: CookState;
  ticket: Ticket | null;
  homePx: { x: number; y: number };
  stovePx: { x: number; y: number };
  pickupPx: { x: number; y: number };
  walkTarget: { x: number; y: number } | null;
  /** Tile-center waypoints from current position to walkTarget, computed
   *  lazily by stepWalker when walkTarget changes. Null when no path is
   *  currently active. */
  walkPath: Array<{ x: number; y: number }> | null;
  carryIcon: Phaser.GameObjects.Image | null;
}

type ServerState = "idle" | "walkToPickup" | "walkToSeat" | "returning";

interface ServerAgent {
  npcId: string;
  state: ServerState;
  ticket: Ticket | null;
  homePx: { x: number; y: number };
  pickupPx: { x: number; y: number };
  walkTarget: { x: number; y: number } | null;
  walkPath: Array<{ x: number; y: number }> | null;
  carryIcon: Phaser.GameObjects.Image | null;
}

// ─── Tunables ────────────────────────────────────────────────────────────

const CUSTOMER_SPEED = 36;
const ARRIVE_RADIUS = 4;
const DESPAWN_GRACE_MS = 250;
const EATING_MS = 6000;
/** How long a seated customer waits for food before walking out. Includes
 *  cook + serve time, so this should be comfortably larger than the slowest
 *  menu item's serviceTimeMs plus delivery walking. */
const FOOD_PATIENCE_MS = 30_000;
/** How long a customer at the bar waits for a free bartender to take their
 *  order before giving up and walking out. */
const ORDER_BARTENDER_PATIENCE_MS = 10_000;
/** Time the bartender spends taking the order before the ticket is placed. */
const ORDER_SERVICE_MS = 4_000;
/** Time the bartender spends ringing up the bill before the customer leaves. */
const PAY_SERVICE_MS = 4_000;
// ─── Customer state machine ──────────────────────────────────────────────

type CustomerState =
  | "enter"                     // walking from entry to bar order point
  | "waitingForOrderBartender"  // at bar, waiting for a free bartender
  | "ordering"                  // bartender taking order (4s timer)
  | "walkToSeat"                // walking to claimed seat
  | "waitingForFood"            // seated, ticket not yet delivered
  | "selfServeToPickup"         // no server hired — fetch own food
  | "selfServeToSeat"           // walking back to seat with own food
  | "eating"                    // food on table, eating timer
  | "walkToBarPay"              // walking back to bar to pay
  | "waitingForPayBartender"    // at bar, waiting (forever) for a free bartender
  | "paying"                    // bartender ringing up bill (4s timer)
  | "leaving"                   // walking to exit after pay
  | "walkout"                   // walking to exit after a failure
  | "done";

/** When a patron arrives via `requestSeat`, the FSM "borrows" their NpcAgent
 *  body via the held BodyHandle instead of owning a synthetic NpcDef + model.
 *  Position / facing / anim writes go through the handle so the activity
 *  layer's body-driver invariant ("exactly one writer") holds across the
 *  delegation. The same NpcModel still exists in the entity registry — it's
 *  just a presentation mirror, kept in sync by NpcProxy each frame and also
 *  written-through by `stepNpcToward` so per-tick FSM reads see fresh
 *  position. */
interface BorrowedDriver {
  npc: NpcAgent;
  handle: BodyHandle;
}

interface Customer {
  model: NpcModel;
  /** Non-null when this customer was delegated in via `requestSeat` (the
   *  `npcRegistryPatrons` flag-on path). Null = legacy owned synthetic
   *  customer created by `spawnCustomer`. */
  borrowed: BorrowedDriver | null;
  state: CustomerState;
  seat: SeatSpawn | null;
  ticket: Ticket | null;
  /** Customer profile id (`kind.customerProfiles[].id`) — captured into the
   *  snapshot so re-entering the interior restores the same sprite/profile in
   *  each occupied seat. */
  profileId: string;
  walkTarget: { x: number; y: number } | null;
  walkPath: Array<{ x: number; y: number }> | null;
  graceLeftMs: number;
  eatingLeftMs: number;
  waitLeftMs: number;
  /** Countdown for bartender-driven service timers (ordering / paying). */
  serveLeftMs: number;
  /** True once the customer has reached the front of the bar queue, so the
   *  10s order patience timer only ticks while they're actually being
   *  ignored at slot 0. Reset whenever the customer leaves the queue. */
  atBarHead: boolean;
  /** NPC id of the bartender currently reserved for this customer. */
  bartenderNpcId: string | null;
  carryIcon: Phaser.GameObjects.Image | null;
}

/** Schedule-driven per-staff lifecycle. `arriving` = walking from the
 *  entry door to their workstation; `present` = at workstation, role-agent
 *  in charge; `departing` = walking back to the door, despawn on arrival.
 *  While arriving/departing, role-agents (cook/server/bartender) skip
 *  this hire so the body of the FSM can't fight the door walk. */
type StaffPresenceState = "arriving" | "present" | "departing";

interface StaffAgent {
  hireableId: string;
  roleId: string;
  npcId: string;
  presence: StaffPresenceState;
  workstationPx: { x: number; y: number };
  workstationTile: { tileX: number; tileY: number };
  walkTarget: { x: number; y: number } | null;
  walkPath: Array<{ x: number; y: number }> | null;
  carryIcon: null;
}

type BartenderState = "idle" | "walking" | "serving" | "returning";

interface BartenderAgent {
  npcId: string;
  state: BartenderState;
  /** Customer NPC id holding the reservation, or null if the bartender is
   *  free. While reserved, the bartender is `scripted = true` so they do
   *  not wander. */
  reservedBy: string | null;
  taskKind: "order" | "pay" | null;
  homePx: { x: number; y: number };
  walkTarget: { x: number; y: number } | null;
  walkPath: Array<{ x: number; y: number }> | null;
  /** Unused — kept for symmetry with the cook/server stepWalker shape. */
  carryIcon: Phaser.GameObjects.Image | null;
}

function pickProfileWeighted(
  profiles: ReadonlyArray<CustomerProfileDef>,
  phase: "day" | "night",
): CustomerProfileDef | null {
  if (profiles.length === 0) return null;
  const weights = profiles.map(
    (p) => Math.max(0, p.spawnWeight) * Math.max(0, p.phaseMultiplier[phase]),
  );
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let pick = Math.random() * total;
  for (let i = 0; i < profiles.length; i++) {
    pick -= weights[i];
    if (pick <= 0) return profiles[i];
  }
  return profiles[profiles.length - 1];
}

/** Live tavern simulation for one owned business interior. Owns a Phaser
 *  timer that adds customers at a calculated rate and a queue of open
 *  tickets, and advances each customer's state machine on `tick(dtMs)`.
 *
 *  The FSM models the full bar/kitchen loop:
 *    spawn → walk to bar → order → walk to seat → wait for food → eat
 *    → walk to bar → pay → leave.
 *  In phase 2 the cook and server are simulated as inline timers; phases
 *  3 and 4 will replace those with real cook/server agents that consume
 *  this same ticket queue.
 */
export class CustomerSim {
  private readonly scene: Phaser.Scene;
  private readonly businessId: BusinessId;
  private readonly interior: InteriorTilemap;
  private readonly isWalkablePx: (px: number, py: number) => boolean;
  private readonly customers: Customer[] = [];
  private readonly claimedSeats = new Set<string>();
  private readonly tickets: Ticket[] = [];
  /** Visuals for plated dishes sitting on the pickup counter — one per
   *  ticket whose state === "ready" and which no server has claimed yet.
   *  Keyed by ticket id so we can attach/detach without churn. */
  private readonly counterIcons = new Map<string, Phaser.GameObjects.Image>();
  private readonly cookAgents = new Map<string, CookAgent>();
  private readonly serverAgents = new Map<string, ServerAgent>();
  private readonly bartenderAgents = new Map<string, BartenderAgent>();
  /** Customers currently queued at the bar (either to order or to pay). The
   *  array order is the line order: index 0 is the head spot at
   *  `barOrderPx`, with each subsequent slot one tile further along the
   *  queue direction. Customers are added on spawn / on entering
   *  walkToBarPay, and removed on transitioning into ordering / paying or
   *  on walkout. */
  private readonly barQueue: Customer[] = [];
  private staffUnsub: (() => void) | null = null;
  /** Schedule-driven per-hire arrival/departure state. Only populated when
   *  the business has a `schedule`; otherwise InteriorScene handles staff
   *  spawn/despawn statically. Keyed by hireableId. */
  private readonly staffAgents = new Map<string, StaffAgent>();
  /** Previous tick's `staffPresent` for edge detection. Null = first tick. */
  private lastStaffPresent: boolean | null = null;
  /** Spawn / despawn callbacks supplied by InteriorScene for the
   *  schedule-driven path. Null when the business has no schedule (the
   *  scene's static spawnHiredStaff handles those). */
  private readonly spawnStaffNpc:
    | ((hire: HiredNpc, tileX: number, tileY: number) => string | null)
    | null;
  private readonly despawnStaffNpc: ((npcId: string) => void) | null;
  private readonly hasSchedule: boolean;
  /** Phase 8: registry-driven staff (`WorkAt` activity) currently clocked in
   *  at this business. Keyed by npc model id (`npc:staff:<bizId>:<hireableId>`).
   *  The held BodyHandle is threaded into role-agent step writes so the
   *  activity layer's exclusive-driver invariant survives across the
   *  delegation. */
  private readonly borrowedStaff = new Map<string, {
    npc: NpcAgent;
    handle: BodyHandle;
    hireableId: string;
    roleId: string;
  }>();

  constructor(opts: {
    scene: Phaser.Scene;
    businessId: BusinessId;
    interiorKey: string;
    interior: InteriorTilemap;
    isWalkablePx: (px: number, py: number) => boolean;
    /** Required when the business has an `openMinute` / `closeMinute`
     *  schedule — used to spawn the NPC at the door when staff arrive
     *  for opening, and to despawn them after they walk out at close. */
    spawnStaffNpc?: (hire: HiredNpc, tileX: number, tileY: number) => string | null;
    despawnStaffNpc?: (npcId: string) => void;
  }) {
    this.scene = opts.scene;
    this.businessId = opts.businessId;
    this.interior = opts.interior;
    this.isWalkablePx = opts.isWalkablePx;
    this.spawnStaffNpc = opts.spawnStaffNpc ?? null;
    this.despawnStaffNpc = opts.despawnStaffNpc ?? null;
    const def = businesses.tryGet(opts.businessId);
    this.hasSchedule = !!def?.schedule;
  }

  start(): void {
    // Phase 9: the legacy spawn loop and the snapshot/synthesis "while you
    // were away" tavern population are both gone. Every patron now arrives
    // via `PatronTavernActivity.requestSeat`; an abstract patron whose
    // dwell hasn't expired re-runs `requestSeat` from `materialize` when
    // the player walks back in.
    // Seed schedule-driven staff (spawn at workstation if currently open,
    // at door arriving if in pre-open buffer, none if closed). Must run
    // before refreshXxxAgents so role-agents see the right NPC set.
    this.reconcileStaffSchedule(/*initial=*/ true);
    this.refreshCookAgents();
    this.refreshServerAgents();
    this.refreshBartenderAgents();
    const handler = ({ businessId }: { businessId: string }) => {
      if (businessId !== this.businessId) return;
      this.refreshCookAgents();
      this.refreshServerAgents();
      this.refreshBartenderAgents();
    };
    bus.onTyped("business:staffChanged", handler);
    this.staffUnsub = () => bus.offTyped("business:staffChanged", handler);
    // Phase 5: register as the per-business patron service. Activities
    // (PatronTavernActivity) call `requestSeat` to hand a borrowed body in.
    registerPatronService(this.businessId, this.serviceProvider);
    // Phase 8: register as the per-business staff service. Activities
    // (WorkAtActivity) call `clockIn` to hand a borrowed body in.
    registerStaffService(this.businessId, this.staffServiceProvider);
  }

  stop(): void {
    this.staffUnsub?.();
    this.staffUnsub = null;
    unregisterPatronService(this.businessId, this.serviceProvider);
    unregisterStaffService(this.businessId, this.staffServiceProvider);
    // Release every borrowed staffer: drop the held handle and signal the
    // WorkAt activity that the shift has ended. The agent + model stay alive
    // — they belong to the registry / scene binder. Mirrors the patron path
    // above.
    for (const borrowed of this.borrowedStaff.values()) {
      try { borrowed.handle.release(); } catch (_e) { /* may already be released */ }
      emitShiftComplete(this.businessId, borrowed.npc.id);
    }
    this.borrowedStaff.clear();
    for (const c of this.customers) {
      this.destroyIcon(c);
      // Borrowed patrons: release the handle and signal completion so the
      // delegating activity can mark itself done. The agent + model stay
      // alive — they belong to the registry / scene binder.
      if (c.borrowed) {
        try { c.borrowed.handle.release(); } catch (_e) { /* may already be released */ }
        emitPatronComplete(this.businessId, c.borrowed.npc.id);
        c.borrowed = null;
        continue;
      }
      if (entityRegistry.get(c.model.id)) entityRegistry.remove(c.model.id);
    }
    this.customers.length = 0;
    this.barQueue.length = 0;
    this.claimedSeats.clear();
    this.tickets.length = 0;
    for (const agent of this.cookAgents.values()) this.destroyIcon(agent);
    this.releaseAllCookScripting();
    this.cookAgents.clear();
    for (const agent of this.serverAgents.values()) this.destroyIcon(agent);
    this.releaseAllServerScripting();
    this.serverAgents.clear();
    this.releaseAllBartenderScripting();
    this.bartenderAgents.clear();
    // Schedule-spawned staff stay in the registry across scene exits — the
    // scene's despawnHiredStaff cleans them up the same way as static spawns.
    // We just drop our local lifecycle state.
    this.staffAgents.clear();
    for (const icon of this.counterIcons.values()) icon.destroy();
    this.counterIcons.clear();
  }

  /** Frame tick — drives the ticket pipeline and every customer FSM. */
  tick(dtMs: number): void {
    this.reconcileStaffSchedule(false);
    this.tickStaffAgents(dtMs);
    this.tickCookAgents(dtMs);
    this.tickServerAgents(dtMs);
    this.tickBartenderAgents(dtMs);
    this.tickTickets(dtMs);
    for (const c of this.customers) this.tickCustomer(c, dtMs);
    this.syncCarryIcons();
    let w = 0;
    for (let r = 0; r < this.customers.length; r++) {
      const c = this.customers[r];
      if (c.state === "done") continue;
      this.customers[w++] = c;
    }
    this.customers.length = w;
  }

  // ── Carry-icon visuals ────────────────────────────────────────────────

  private syncCarryIcons(): void {
    for (const agent of this.cookAgents.values()) {
      const carrying = agent.state === "walkToPickup" && agent.ticket
        ? agent.ticket.itemId
        : null;
      this.syncIconFor(agent, carrying, agent.npcId);
    }
    for (const agent of this.serverAgents.values()) {
      const carrying = agent.state === "walkToSeat" && agent.ticket
        ? agent.ticket.itemId
        : null;
      this.syncIconFor(agent, carrying, agent.npcId);
    }
    for (const c of this.customers) {
      const showIcon = (c.state === "eating" || c.state === "selfServeToSeat")
        && c.ticket
        ? c.ticket.itemId
        : null;
      this.syncIconForCustomer(c, showIcon);
    }
    this.syncCounterIcons();
  }

  /** Render an item icon on the pickup counter for every plated dish that
   *  hasn't been physically picked up yet. State === "ready" covers both
   *  "no server reserved this yet" and "a server has reserved it but is
   *  still walking over"; the dish only disappears from the counter once
   *  state flips to "delivering" (server arrived) or "delivered"
   *  (self-serve customer arrived). */
  private syncCounterIcons(): void {
    const pickupPx = this.workstationPx("kitchen_pickup")
      ?? this.workstationPx("kitchen");
    const wanted = new Set<string>();
    if (pickupPx) {
      for (const t of this.tickets) {
        if (t.state !== "ready") continue;
        wanted.add(t.id);
        let icon = this.counterIcons.get(t.id);
        if (!icon) {
          icon = this.scene.add
            .image(pickupPx.x, pickupPx.y - 8, itemIconTextureKey(t.itemId))
            .setOrigin(0.5);
          icon.setDisplaySize(12, 12);
          this.counterIcons.set(t.id, icon);
        }
        icon.setPosition(pickupPx.x, pickupPx.y - 8);
        icon.setDepth(pickupPx.y + 999);
      }
    }
    for (const [id, icon] of this.counterIcons) {
      if (wanted.has(id)) continue;
      icon.destroy();
      this.counterIcons.delete(id);
    }
  }

  private syncIconFor(
    holder: { carryIcon: Phaser.GameObjects.Image | null },
    itemId: string | null,
    npcId: string,
  ): void {
    const model = entityRegistry.get(npcId) as NpcModel | undefined;
    if (!model) {
      this.destroyIcon(holder);
      return;
    }
    this.applyIcon(holder, itemId, model.x, model.y);
  }

  private syncIconForCustomer(c: Customer, itemId: string | null): void {
    this.applyIcon(c, itemId, c.model.x, c.model.y);
  }

  private applyIcon(
    holder: { carryIcon: Phaser.GameObjects.Image | null },
    itemId: string | null,
    x: number,
    y: number,
  ): void {
    if (!itemId) {
      this.destroyIcon(holder);
      return;
    }
    if (!holder.carryIcon) {
      const img = this.scene.add
        .image(x, y - 14, itemIconTextureKey(itemId))
        .setOrigin(0.5);
      img.setDisplaySize(10, 10);
      holder.carryIcon = img;
    }
    holder.carryIcon.setPosition(x, y - 14);
    holder.carryIcon.setDepth(y + 1000);
  }

  private destroyIcon(holder: { carryIcon: Phaser.GameObjects.Image | null }): void {
    if (holder.carryIcon) {
      holder.carryIcon.destroy();
      holder.carryIcon = null;
    }
  }

  // ── Patron service (Phase 5: borrowed-body delegation) ──────────────
  //
  // Activities (PatronTavernActivity) call `requestSeat` to hand a borrowed
  // body to the FSM. We treat the request as a thin admission gate against
  // the current capacity / open status, then funnel the patron into the
  // same FSM the legacy `spawnCustomer` path uses — only difference is the
  // Customer record carries a `borrowed` driver instead of an owned synth.

  private readonly serviceProvider: PatronServiceProvider = {
    requestSeat: (npc, handle) => this.requestSeatImpl(npc, handle),
    releasePatron: (npcId) => this.releasePatronImpl(npcId),
  };

  private requestSeatImpl(npc: NpcAgent, handle: BodyHandle): SeatRequestResult {
    const def = businesses.tryGet(this.businessId);
    if (!def) return { kind: "rejected", reason: "service-missing" };
    const kind = businessKinds.tryGet(def.kindId);
    if (!kind) return { kind: "rejected", reason: "service-missing" };
    const state = useBusinessStore.getState().get(this.businessId);
    if (!state || !state.owned) return { kind: "rejected", reason: "service-missing" };

    const time = useTimeStore.getState();
    const status = statusForPhase(def.schedule, time.phase, time.elapsedInPhaseMs);
    if (!status.acceptingCustomers) return { kind: "rejected", reason: "closed" };

    const stats = getEffectiveStats(state, kind);
    if (this.customers.length >= stats.capacity) {
      // ETA is rough: assume one seat clears every MEAN_DWELL_MS / capacity
      // on average, so a queued patron waits proportional to how many ahead.
      const overflow = this.customers.length - stats.capacity + 1;
      const slotMs = Math.max(1000, MEAN_DWELL_MS / Math.max(1, stats.capacity));
      return { kind: "queued", etaMs: overflow * slotMs };
    }

    const ok = this.enterAsBorrowedPatron(npc, handle, kind);
    if (!ok) return { kind: "rejected", reason: "service-missing" };
    return { kind: "accepted" };
  }

  private releasePatronImpl(npcId: string): void {
    // Defensive: an activity may call releasePatron from a failure path
    // where we never accepted them. Tolerate the no-op.
    let removed: Customer | null = null;
    for (const c of this.customers) {
      if (c.borrowed?.npc.id === npcId) { removed = c; break; }
    }
    if (!removed) {
      emitPatronComplete(this.businessId, npcId);
      return;
    }
    this.releaseCustomer(removed);
    // releaseCustomer itself emits the completion event for borrowed.
  }

  private enterAsBorrowedPatron(
    npc: NpcAgent,
    handle: BodyHandle,
    kind: BusinessKindDef,
  ): boolean {
    const model = entityRegistry.get(npc.id) as NpcModel | undefined;
    if (!model || model.kind !== "npc") {
      return false;
    }
    // Take ownership: any further writes from the activity layer through
    // its old handle reference are stale (the activity must drop it).
    let owned: BodyHandle;
    try {
      owned = handle.transfer(this.serviceProvider);
    } catch (_e) {
      return false;
    }
    // Snap model to body so the FSM's first read sees fresh position.
    model.x = npc.body.px;
    model.y = npc.body.py;
    model.facing = npc.body.facing;
    model.animState = "idle";
    model.scripted = false; // body→model mirror handles presentation.

    // Pick a profile so snapshot capture / icon visuals have one.
    const phase = useTimeStore.getState().phase;
    const profile =
      pickProfileWeighted(kind.customerProfiles, phase) ??
      kind.customerProfiles[0];
    if (!profile) {
      try { owned.release(); } catch (_e) { /* ignore */ }
      return false;
    }

    const newCustomer: Customer = {
      model,
      borrowed: { npc, handle: owned },
      state: "enter",
      seat: null,
      ticket: null,
      profileId: profile.id,
      walkTarget: null,
      walkPath: null,
      graceLeftMs: 0,
      eatingLeftMs: 0,
      waitLeftMs: 0,
      serveLeftMs: 0,
      atBarHead: false,
      bartenderNpcId: null,
      carryIcon: null,
    };
    this.customers.push(newCustomer);
    this.enqueueAtBar(newCustomer);
    dlog(
      this.businessId,
      `${shortNpcId(model.id)} accepted as patron (borrowed) → enter`,
    );
    return true;
  }

  // ── Staff service (Phase 8: borrowed-body delegation) ─────────────
  //
  // Symmetric mirror of the patron service above. `WorkAtActivity` calls
  // `clockIn` after walking to a workstation tile. We accept the borrowed
  // body, transfer the handle into the service claimant, and stash it so the
  // role-agent step writes thread it through. `clockOut` (or the close-edge
  // shift end inside `reconcileStaffSchedule`) releases the handle and emits
  // the completion event the activity is listening for.

  private readonly staffServiceProvider: StaffServiceProvider = {
    clockIn: (npc, handle, role) => this.clockInImpl(npc, handle, role),
    clockOut: (npcId) => this.clockOutImpl(npcId),
  };

  private clockInImpl(
    npc: NpcAgent,
    handle: BodyHandle,
    role: string,
  ): ClockInResult {
    const def = businesses.tryGet(this.businessId);
    if (!def) return { kind: "rejected", reason: "service-missing" };
    const kind = businessKinds.tryGet(def.kindId);
    if (!kind) return { kind: "rejected", reason: "service-missing" };
    const state = useBusinessStore.getState().get(this.businessId);
    if (!state || !state.owned) return { kind: "rejected", reason: "service-missing" };

    if (this.hasSchedule) {
      const time = useTimeStore.getState();
      const status = statusForPhase(def.schedule, time.phase, time.elapsedInPhaseMs);
      if (!status.staffPresent) return { kind: "rejected", reason: "closed" };
    }

    const roleDef = kind.roles.find((r) => r.id === role);
    if (!roleDef) return { kind: "rejected", reason: "unknown-role" };

    // Resolve the staffer's hire record by npc id. The bootstrap path uses
    // `npc:staff:<bizId>:<hireableId>` so we can extract the hireable id
    // from the npcId. Reject if the staffer isn't actually hired here.
    const prefix = `npc:staff:${this.businessId}:`;
    if (!npc.id.startsWith(prefix)) {
      return { kind: "rejected", reason: "wrong-business" };
    }
    const hireableId = npc.id.slice(prefix.length);
    const hire = state.staff.find((s) => s.hireableId === hireableId);
    if (!hire) return { kind: "rejected", reason: "wrong-business" };
    if (hire.roleId !== role) return { kind: "rejected", reason: "unknown-role" };

    if (this.borrowedStaff.has(npc.id)) {
      return { kind: "rejected", reason: "already-clocked-in" };
    }

    // The model must already exist in the entity registry (the scene binder's
    // proxy pairs body↔model on agent registration). If it's missing, the
    // role-agent refresh would never see this hire and the staffer would be
    // invisible — fail clearly instead of silently parking the agent.
    const model = entityRegistry.get(npc.id) as NpcModel | undefined;
    if (!model || model.kind !== "npc") {
      return { kind: "rejected", reason: "no-workstation" };
    }

    let owned: BodyHandle;
    try {
      owned = handle.transfer(this.staffServiceProvider);
    } catch (_e) {
      return { kind: "rejected", reason: "service-missing" };
    }

    // Snap model to body so role-agent first reads see fresh position.
    model.x = npc.body.px;
    model.y = npc.body.py;
    model.facing = npc.body.facing;
    model.animState = "idle";
    model.scripted = false;

    this.borrowedStaff.set(npc.id, { npc, handle: owned, hireableId, roleId: role });
    // Refresh role-agent maps so the appropriate FSM picks up the new body.
    if (role === "cook") this.refreshCookAgents();
    else if (role === "server") this.refreshServerAgents();
    else if (role === "bartender") this.refreshBartenderAgents();
    dlog(this.businessId, `staff ${shortNpcId(npc.id)} clocked in (${role})`);
    return { kind: "accepted" };
  }

  private clockOutImpl(npcId: string): void {
    const borrowed = this.borrowedStaff.get(npcId);
    if (!borrowed) {
      // Activity may call clockOut from a failure path where we never
      // accepted them — emit the completion event so the activity unblocks
      // and tolerate the no-op.
      emitShiftComplete(this.businessId, npcId);
      return;
    }
    // Drop the role-agent record so the FSM stops driving this body. Done
    // before releasing the handle so an in-flight role-agent step doesn't
    // try to write through a stale handle.
    this.cookAgents.delete(npcId);
    this.serverAgents.delete(npcId);
    this.bartenderAgents.delete(npcId);
    try { borrowed.handle.release(); } catch (_e) { /* may already be released */ }
    this.borrowedStaff.delete(npcId);
    emitShiftComplete(this.businessId, npcId);
    dlog(this.businessId, `staff ${shortNpcId(npcId)} clocked out`);
  }

  /** Resolve the live BodyHandle for a borrowed staffer's npc id, or null
   *  for legacy synthetic-spawn staff. Threaded into role-agent step writes
   *  so the activity layer's exclusive-driver invariant holds. */
  private staffHandleFor(npcId: string): BodyHandle | null {
    return this.borrowedStaff.get(npcId)?.handle ?? null;
  }

  // ── Ticket pipeline ───────────────────────────────────────────────────
  // Tickets transition from "ordered" → "cooking" → "ready" via cook agents
  // (see tickCookAgents). Phase 4 will replace the ready→delivered hop with
  // a real server agent; for now food teleports from pickup to the seat.

  private tickTickets(dtMs: number): void {
    for (const t of this.tickets) {
      t.ageMs += dtMs;
    }
    let w = 0;
    for (let r = 0; r < this.tickets.length; r++) {
      const t = this.tickets[r];
      if (t.state === "paid") continue;
      this.tickets[w++] = t;
    }
    this.tickets.length = w;
  }

  // ── Cook agents ───────────────────────────────────────────────────────

  /** Build a CookAgent for every hired cook NPC currently in the registry.
   *  Called on start and on `business:staffChanged`. Preserves in-flight
   *  agents whose npc still exists. */
  private refreshCookAgents(): void {
    const state = useBusinessStore.getState().get(this.businessId);
    if (!state) {
      this.releaseAllCookScripting();
      this.cookAgents.clear();
      return;
    }
    const stovePx = this.workstationPx("kitchen_stove") ?? this.workstationPx("kitchen");
    const pickupPx = this.workstationPx("kitchen_pickup") ?? stovePx;
    const homePx = this.workstationPx("kitchen") ?? stovePx;

    const wanted = new Set<string>();
    for (const hire of state.staff) {
      if (hire.roleId !== "cook") continue;
      if (this.staffInTransit(hire.hireableId)) continue;
      const npcId = `npc:staff:${this.businessId}:${hire.hireableId}`;
      if (!entityRegistry.get(npcId)) continue;
      wanted.add(npcId);
      if (this.cookAgents.has(npcId)) continue;
      if (!stovePx || !pickupPx || !homePx) {
        dwarn(
          this.businessId,
          `cook ${shortNpcId(npcId)} cannot spawn — missing workstation: ` +
            `stove=${stovePx ? "ok" : "MISSING"} ` +
            `pickup=${pickupPx ? "ok" : "MISSING"} ` +
            `home=${homePx ? "ok" : "MISSING"}`,
        );
        continue;
      }
      const samePickup = pickupPx.x === stovePx.x && pickupPx.y === stovePx.y;
      dlog(
        this.businessId,
        `cook ${shortNpcId(npcId)} hired: ` +
          `stove=(${stovePx.x.toFixed(0)},${stovePx.y.toFixed(0)}) ` +
          `pickup=(${pickupPx.x.toFixed(0)},${pickupPx.y.toFixed(0)})` +
          `${samePickup ? " [same as stove — kitchen_pickup workstation not authored]" : ""} ` +
          `home=(${homePx.x.toFixed(0)},${homePx.y.toFixed(0)})`,
      );
      this.cookAgents.set(npcId, {
        npcId,
        state: "idle",
        ticket: null,
        homePx,
        stovePx,
        pickupPx,
        walkTarget: null,
        walkPath: null,
        carryIcon: null,
      });
    }
    // Drop agents whose npc was despawned.
    for (const [id, agent] of this.cookAgents) {
      if (wanted.has(id)) continue;
      this.unscriptCook(agent);
      // Abandon any ticket the cook held — it goes back to "ordered" so
      // another cook (if any) can pick it up.
      if (agent.ticket && agent.ticket.state === "cooking") {
        agent.ticket.state = "ordered";
        agent.ticket.cookNpcId = null;
      }
      this.cookAgents.delete(id);
    }
  }

  private releaseAllCookScripting(): void {
    for (const agent of this.cookAgents.values()) this.unscriptCook(agent);
  }

  private unscriptCook(agent: CookAgent): void {
    const model = entityRegistry.get(agent.npcId);
    if (model && (model as NpcModel).kind === "npc") {
      (model as NpcModel).scripted = false;
      (model as NpcModel).animState = "idle";
    }
  }

  private tickCookAgents(dtMs: number): void {
    for (const agent of this.cookAgents.values()) this.tickCookAgent(agent, dtMs);
  }

  private tickCookAgent(agent: CookAgent, dtMs: number): void {
    const model = entityRegistry.get(agent.npcId) as NpcModel | undefined;
    if (!model) return;
    const handle = this.staffHandleFor(agent.npcId);

    switch (agent.state) {
      case "idle": {
        const ticket = this.claimNextTicketForCook(agent.npcId);
        if (!ticket) return;
        agent.ticket = ticket;
        ticket.state = "cooking";
        ticket.cookNpcId = agent.npcId;
        agent.walkTarget = this.approachPx(agent.stovePx, {
          x: model.x,
          y: model.y,
        });
        if (!handle) model.scripted = true;
        agent.state = "walkToStove";
        dlog(
          this.businessId,
          `cook ${shortNpcId(agent.npcId)} idle → walkToStove ` +
            `ticket=${ticket.itemId} cookMs=${ticket.cookLeftMs.toFixed(0)}`,
        );
        return;
      }
      case "walkToStove":
        if (this.stepWalker(agent, model, dtMs, STAFF_SPEED, handle)) {
          agent.state = "cooking";
          model.animState = "idle";
          if (handle) handle.setAnim("idle");
          dlog(
            this.businessId,
            `cook ${shortNpcId(agent.npcId)} walkToStove → cooking ` +
              `pos=(${model.x.toFixed(0)},${model.y.toFixed(0)})`,
          );
        }
        return;
      case "cooking": {
        const t = agent.ticket;
        if (!t) {
          agent.state = "returning";
          agent.walkTarget = agent.homePx;
          dwarn(
            this.businessId,
            `cook ${shortNpcId(agent.npcId)} cooking → returning (ticket vanished)`,
          );
          return;
        }
        t.cookLeftMs -= dtMs;
        if (t.cookLeftMs <= 0) {
          // Ticket stays in "cooking" state while cook walks the dish to
          // the pickup counter — flips to "ready" only when cook physically
          // arrives, so servers can't grab it mid-air.
          agent.walkTarget = this.approachPx(agent.pickupPx, {
            x: model.x,
            y: model.y,
          });
          agent.state = "walkToPickup";
          dlog(
            this.businessId,
            `cook ${shortNpcId(agent.npcId)} cooking → walkToPickup ` +
              `ticket=${t.itemId} target=(${agent.pickupPx.x.toFixed(0)},${agent.pickupPx.y.toFixed(0)})`,
          );
        }
        return;
      }
      case "walkToPickup":
        if (this.stepWalker(agent, model, dtMs, STAFF_SPEED, handle)) {
          // Cook arrived at the pickup counter: dish is now plated and
          // available for a server (or self-serve customer) to grab. The
          // counter-icon visual will appear via syncCarryIcons.
          const t = agent.ticket;
          if (t) t.state = "ready";
          dlog(
            this.businessId,
            `cook ${shortNpcId(agent.npcId)} walkToPickup → returning ` +
              `(plated ${t?.itemId ?? "?"} on counter, ` +
              `pos=(${model.x.toFixed(0)},${model.y.toFixed(0)}))`,
          );
          agent.ticket = null;
          agent.walkTarget = agent.homePx;
          agent.state = "returning";
        }
        return;
      case "returning":
        if (this.stepWalker(agent, model, dtMs, STAFF_SPEED, handle)) {
          agent.state = "idle";
          agent.walkTarget = null;
          if (!handle) this.unscriptCook(agent);
          else { model.animState = "idle"; handle.setAnim("idle"); }
          dlog(
            this.businessId,
            `cook ${shortNpcId(agent.npcId)} returning → idle`,
          );
        }
        return;
    }
  }

  // ── Server agents ─────────────────────────────────────────────────────

  private refreshServerAgents(): void {
    const state = useBusinessStore.getState().get(this.businessId);
    if (!state) {
      this.releaseAllServerScripting();
      this.serverAgents.clear();
      return;
    }
    const pickupPx = this.workstationPx("kitchen_pickup") ?? this.workstationPx("kitchen");
    const homePx = this.workstationPx("floor") ?? pickupPx;

    const wanted = new Set<string>();
    for (const hire of state.staff) {
      if (hire.roleId !== "server") continue;
      if (this.staffInTransit(hire.hireableId)) continue;
      const npcId = `npc:staff:${this.businessId}:${hire.hireableId}`;
      if (!entityRegistry.get(npcId)) continue;
      wanted.add(npcId);
      if (this.serverAgents.has(npcId)) continue;
      if (!pickupPx || !homePx) {
        dwarn(
          this.businessId,
          `server ${shortNpcId(npcId)} cannot spawn — missing workstation: ` +
            `pickup=${pickupPx ? "ok" : "MISSING"} home=${homePx ? "ok" : "MISSING"}`,
        );
        continue;
      }
      dlog(
        this.businessId,
        `server ${shortNpcId(npcId)} hired: ` +
          `pickup=(${pickupPx.x.toFixed(0)},${pickupPx.y.toFixed(0)}) ` +
          `home=(${homePx.x.toFixed(0)},${homePx.y.toFixed(0)})`,
      );
      this.serverAgents.set(npcId, {
        npcId,
        state: "idle",
        ticket: null,
        homePx,
        pickupPx,
        walkTarget: null,
        walkPath: null,
        carryIcon: null,
      });
    }
    for (const [id, agent] of this.serverAgents) {
      if (wanted.has(id)) continue;
      this.unscriptServer(agent);
      // Abandon any ticket the server held. They may have already grabbed
      // the dish (state === "delivering") or merely reserved it while
      // walking to the counter (state === "ready" but serverNpcId set).
      // Either way, release the reservation and let another server (or a
      // self-serve customer) pick it up. If the dish was already in the
      // server's hands, put it back on the counter as "ready".
      if (agent.ticket) {
        if (agent.ticket.state === "delivering") agent.ticket.state = "ready";
        agent.ticket.serverNpcId = null;
      }
      this.serverAgents.delete(id);
    }
  }

  private hasServerStaff(): boolean {
    return this.serverAgents.size > 0;
  }

  private releaseAllServerScripting(): void {
    for (const agent of this.serverAgents.values()) this.unscriptServer(agent);
  }

  private unscriptServer(agent: ServerAgent): void {
    const model = entityRegistry.get(agent.npcId);
    if (model && (model as NpcModel).kind === "npc") {
      (model as NpcModel).scripted = false;
      (model as NpcModel).animState = "idle";
    }
  }

  private tickServerAgents(dtMs: number): void {
    for (const agent of this.serverAgents.values()) this.tickServerAgent(agent, dtMs);
  }

  private tickServerAgent(agent: ServerAgent, dtMs: number): void {
    const model = entityRegistry.get(agent.npcId) as NpcModel | undefined;
    if (!model) return;
    const handle = this.staffHandleFor(agent.npcId);

    switch (agent.state) {
      case "idle": {
        const ticket = this.claimNextTicketForServer();
        if (!ticket) return;
        agent.ticket = ticket;
        // Reserve the ticket so no other server can claim it, but leave
        // state === "ready" so the dish stays visually on the counter
        // until this server physically arrives. State flips to
        // "delivering" in the walkToPickup → walkToSeat transition below.
        ticket.serverNpcId = agent.npcId;
        agent.walkTarget = this.approachPx(agent.pickupPx, {
          x: model.x,
          y: model.y,
        });
        if (!handle) model.scripted = true;
        agent.state = "walkToPickup";
        dlog(
          this.businessId,
          `server ${shortNpcId(agent.npcId)} idle → walkToPickup ticket=${ticket.itemId}`,
        );
        return;
      }
      case "walkToPickup":
        if (this.stepWalker(agent, model, dtMs, STAFF_SPEED, handle)) {
          const t = agent.ticket;
          if (!t) {
            agent.state = "returning";
            agent.walkTarget = agent.homePx;
            dwarn(
              this.businessId,
              `server ${shortNpcId(agent.npcId)} walkToPickup → returning (ticket vanished)`,
            );
            return;
          }
          // Server physically grabs the dish off the counter — counter
          // icon disappears, server's carry icon takes over via
          // syncCarryIcons (which checks state === "walkToSeat").
          t.state = "delivering";
          const seatPx = this.seatPxForTicket(t);
          agent.walkTarget = seatPx ?? agent.homePx;
          agent.state = "walkToSeat";
          dlog(
            this.businessId,
            `server ${shortNpcId(agent.npcId)} walkToPickup → walkToSeat ` +
              `seat=${t.seatUid}${seatPx ? "" : " [SEAT MISSING — heading home]"}`,
          );
        }
        return;
      case "walkToSeat":
        if (this.stepWalker(agent, model, dtMs, STAFF_SPEED, handle)) {
          const t = agent.ticket;
          if (t) t.state = "delivered";
          dlog(
            this.businessId,
            `server ${shortNpcId(agent.npcId)} walkToSeat → returning ` +
              `(delivered ${t?.itemId ?? "?"} to ${t?.seatUid ?? "?"})`,
          );
          agent.ticket = null;
          agent.walkTarget = agent.homePx;
          agent.state = "returning";
        }
        return;
      case "returning":
        if (this.stepWalker(agent, model, dtMs, STAFF_SPEED, handle)) {
          agent.state = "idle";
          agent.walkTarget = null;
          if (!handle) this.unscriptServer(agent);
          else { model.animState = "idle"; handle.setAnim("idle"); }
          dlog(
            this.businessId,
            `server ${shortNpcId(agent.npcId)} returning → idle`,
          );
        }
        return;
    }
  }

  private claimNextTicketForServer(): Ticket | null {
    for (const t of this.tickets) {
      if (t.state === "ready" && !t.serverNpcId) return t;
    }
    return null;
  }

  private seatPxForTicket(t: Ticket): { x: number; y: number } | null {
    for (const s of this.interior.seats) {
      if (s.uid === t.seatUid) return tileCenter(s);
    }
    return null;
  }

  /** Find the oldest "ordered" ticket whose required role is "cook". Returns
   *  null if there's nothing to do. */
  private claimNextTicketForCook(_cookNpcId: string): Ticket | null {
    for (const t of this.tickets) {
      if (t.state !== "ordered") continue;
      // Could filter by item.requiresRole === "cook" once non-cook items
      // exist; for now every revenueSource requires cook.
      return t;
    }
    return null;
  }

  private stepNpcToward(
    model: NpcModel,
    target: { x: number; y: number } | null,
    dtMs: number,
    speedPxPerSec: number = STAFF_SPEED,
    handle: BodyHandle | null = null,
  ): boolean {
    if (!target) return true;
    const dx = target.x - model.x;
    const dy = target.y - model.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= ARRIVE_RADIUS) {
      model.animState = "idle";
      if (handle) handle.setAnim("idle");
      return true;
    }
    const step = Math.min(dist, speedPxPerSec * (dtMs / 1000));
    const nx = model.x + (dx / dist) * step;
    const ny = model.y + (dy / dist) * step;
    const prevX = model.x;
    const prevY = model.y;
    if (this.isWalkablePx(nx, model.y)) model.x = nx;
    if (this.isWalkablePx(model.x, ny)) model.y = ny;
    const moved = model.x !== prevX || model.y !== prevY;
    if (!moved) {
      // Both axes fully blocked. Pathfinding normally prevents this by
      // routing waypoints through walkable pixels, so this fires only on
      // genuinely bad geometry or when an agent's been pushed off-path.
      // Force-arrive so the FSM can't stall.
      if (DEV_LOG) {
        dwarn(
          this.businessId,
          `stuck ${shortNpcId(model.id)} pos=(${model.x.toFixed(0)},${model.y.toFixed(0)}) ` +
            `target=(${target.x.toFixed(0)},${target.y.toFixed(0)}) ` +
            `Δ=(${(target.x - model.x).toFixed(0)},${(target.y - model.y).toFixed(0)}) ` +
            `dist=${dist.toFixed(1)}px — both axes blocked, advancing FSM as if arrived`,
        );
      }
      model.animState = "idle";
      if (handle) handle.setAnim("idle");
      return true;
    }
    if (Math.abs(dy) > Math.abs(dx)) {
      model.facing = dy < 0 ? "up" : "down";
    } else {
      model.facing = dx < 0 ? "left" : "right";
    }
    model.animState = "walk";
    if (handle) {
      handle.setPosition(model.x, model.y);
      handle.setFacing(model.facing);
      handle.setAnim("walk");
    }
    return false;
  }

  private workstationPx(tag: string): { x: number; y: number } | null {
    const ws = this.findWorkstation(tag);
    return ws ? tileCenter(ws) : null;
  }

  /** Walk an agent toward its `walkTarget`, computing and following a
   *  BFS path through walkable tiles. Recomputes the path automatically
   *  when the target changes (detected by comparing to the path's last
   *  waypoint). Returns true when the agent has reached the final target.
   *
   *  Falls back to a direct `stepNpcToward` if pathfinding fails (no
   *  reachable route) — the stuck detector then force-advances the FSM so
   *  the simulation can't deadlock on bad geometry. */
  private stepWalker(
    walker: {
      walkTarget: Waypoint | null;
      walkPath: Waypoint[] | null;
    },
    model: NpcModel,
    dtMs: number,
    speed: number = STAFF_SPEED,
    handle: BodyHandle | null = null,
  ): boolean {
    const target = walker.walkTarget;
    if (!target) return true;
    if (pathStale(walker.walkPath, target)) {
      walker.walkPath = pathfindPx({
        isWalkablePx: this.isWalkablePx,
        fromPx: { x: model.x, y: model.y },
        toPx: target,
      });
      if (DEV_LOG) {
        if (walker.walkPath) {
          dlog(
            this.businessId,
            `pathfind ${shortNpcId(model.id)} ` +
              `from=(${model.x.toFixed(0)},${model.y.toFixed(0)}) ` +
              `to=(${target.x.toFixed(0)},${target.y.toFixed(0)}) ` +
              `→ ${walker.walkPath.length} waypoints`,
          );
        } else {
          dwarn(
            this.businessId,
            `pathfind FAILED ${shortNpcId(model.id)} ` +
              `from=(${model.x.toFixed(0)},${model.y.toFixed(0)}) ` +
              `to=(${target.x.toFixed(0)},${target.y.toFixed(0)}) ` +
              `— falling back to direct walk`,
          );
        }
      }
    }
    const path = walker.walkPath;
    if (!path || path.length === 0) {
      return this.stepNpcToward(model, target, dtMs, speed, handle);
    }
    const next = path[0];
    if (this.stepNpcToward(model, next, dtMs, speed, handle)) {
      path.shift();
    }
    if (path.length === 0) {
      walker.walkPath = null;
      return true;
    }
    return false;
  }

  /** Pick a walkable approach tile next to a workstation. Workstation tiles
   *  (stoves, counters, bars) are typically non-walkable, so naively walking
   *  *to* the tile dead-ends the agent against the wall. This returns the
   *  4-neighbor of `target` that is (a) walkable and (b) closest to `fromPx`,
   *  so the cook approaches from the kitchen side and the server approaches
   *  from the customer side of the same shared `kitchen_pickup` tile.
   *
   *  Falls back to the original target if no neighbor is walkable (e.g. a
   *  badly-authored interior) — the stuck-pathing detector will then force-
   *  arrive the agent so the FSM doesn't deadlock. */
  private approachPx(
    target: { x: number; y: number },
    fromPx: { x: number; y: number },
  ): { x: number; y: number } {
    if (this.isWalkablePx(target.x, target.y)) return target;
    const candidates = [
      { x: target.x - TILE_SIZE, y: target.y },
      { x: target.x + TILE_SIZE, y: target.y },
      { x: target.x, y: target.y - TILE_SIZE },
      { x: target.x, y: target.y + TILE_SIZE },
    ].filter((c) => this.isWalkablePx(c.x, c.y));
    if (candidates.length === 0) return target;
    let best = candidates[0];
    let bestD = Math.hypot(best.x - fromPx.x, best.y - fromPx.y);
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i];
      const d = Math.hypot(c.x - fromPx.x, c.y - fromPx.y);
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
    return best;
  }

  // ── Bartender agents ──────────────────────────────────────────────────
  //
  // Bartenders normally wander around their `bar` workstation under the
  // standard NpcModel wander movement. Customers reserve them for two
  // discrete tasks:
  //
  //   • "order" — bartender stays at home; customer ticks down a 4s timer.
  //   • "pay"   — bartender walks out to align horizontally with the paying
  //               customer (keeping the bar's y row), holds for 4s, then
  //               returns home.
  //
  // While reserved, the bartender's NpcModel is `scripted = true` so the
  // wander tick is suppressed. Released bartenders flip back to unscripted
  // and resume wandering.

  private refreshBartenderAgents(): void {
    const state = useBusinessStore.getState().get(this.businessId);
    if (!state) {
      this.releaseAllBartenderScripting();
      this.bartenderAgents.clear();
      return;
    }
    const barWorkstations = this.interior.workstations.filter(
      (w) => w.tag === "bar",
    );

    const wanted = new Set<string>();
    for (const hire of state.staff) {
      if (hire.roleId !== "bartender") continue;
      if (this.staffInTransit(hire.hireableId)) continue;
      const npcId = `npc:staff:${this.businessId}:${hire.hireableId}`;
      if (!entityRegistry.get(npcId)) continue;
      wanted.add(npcId);
      if (this.bartenderAgents.has(npcId)) continue;
      if (barWorkstations.length === 0) {
        dwarn(
          this.businessId,
          `bartender ${shortNpcId(npcId)} cannot spawn — no bar workstation`,
        );
        continue;
      }
      const ws =
        barWorkstations[hashIndex(hire.hireableId, barWorkstations.length)];
      const homePx = tileCenter(ws);
      dlog(
        this.businessId,
        `bartender ${shortNpcId(npcId)} hired: ` +
          `home=(${homePx.x.toFixed(0)},${homePx.y.toFixed(0)})`,
      );
      this.bartenderAgents.set(npcId, {
        npcId,
        state: "idle",
        reservedBy: null,
        taskKind: null,
        homePx,
        walkTarget: null,
        walkPath: null,
        carryIcon: null,
      });
    }
    for (const [id, agent] of this.bartenderAgents) {
      if (wanted.has(id)) continue;
      this.unscriptBartender(agent);
      this.bartenderAgents.delete(id);
    }
  }

  private releaseAllBartenderScripting(): void {
    for (const agent of this.bartenderAgents.values()) {
      this.unscriptBartender(agent);
    }
  }

  private unscriptBartender(agent: BartenderAgent): void {
    const model = entityRegistry.get(agent.npcId);
    if (model && (model as NpcModel).kind === "npc") {
      (model as NpcModel).scripted = false;
      (model as NpcModel).animState = "idle";
    }
  }

  private claimFreeBartender(
    customerNpcId: string,
    taskKind: "order" | "pay",
    payCustomerPx?: { x: number; y: number },
  ): BartenderAgent | null {
    for (const agent of this.bartenderAgents.values()) {
      if (agent.reservedBy !== null) continue;
      const model = entityRegistry.get(agent.npcId) as NpcModel | undefined;
      if (!model) continue;
      agent.reservedBy = customerNpcId;
      agent.taskKind = taskKind;
      if (!this.staffHandleFor(agent.npcId)) model.scripted = true;
      if (taskKind === "order") {
        // Stays at home — no walk phase.
        agent.state = "serving";
        agent.walkTarget = null;
        agent.walkPath = null;
        model.animState = "idle";
      } else {
        // Walk out along the bar to align with the customer's x. y stays at
        // the bar workstation row so the bartender doesn't leave the bar.
        const ax = payCustomerPx?.x ?? agent.homePx.x;
        agent.walkTarget = { x: ax, y: agent.homePx.y };
        agent.walkPath = null;
        agent.state = "walking";
      }
      return agent;
    }
    return null;
  }

  private releaseBartender(agent: BartenderAgent): void {
    const wasOrder = agent.taskKind === "order";
    agent.reservedBy = null;
    agent.taskKind = null;
    if (wasOrder) {
      // Bartender never moved — flip straight back to wander.
      agent.state = "idle";
      agent.walkTarget = null;
      agent.walkPath = null;
      if (!this.staffHandleFor(agent.npcId)) this.unscriptBartender(agent);
    } else {
      // Walked out to a paying customer — head home before resuming wander.
      agent.state = "returning";
      agent.walkTarget = agent.homePx;
      agent.walkPath = null;
    }
  }

  private tickBartenderAgents(dtMs: number): void {
    for (const agent of this.bartenderAgents.values()) {
      this.tickBartenderAgent(agent, dtMs);
    }
  }

  private tickBartenderAgent(agent: BartenderAgent, dtMs: number): void {
    const model = entityRegistry.get(agent.npcId) as NpcModel | undefined;
    if (!model) return;
    const handle = this.staffHandleFor(agent.npcId);
    switch (agent.state) {
      case "idle":
        // Not scripted — NpcModel wander handles motion.
        return;
      case "walking":
        if (this.stepWalker(agent, model, dtMs, STAFF_SPEED, handle)) {
          agent.state = "serving";
          model.animState = "idle";
          if (handle) handle.setAnim("idle");
        }
        return;
      case "serving":
        // Stand still while the customer ticks down their service timer.
        model.animState = "idle";
        if (handle) handle.setAnim("idle");
        return;
      case "returning":
        if (this.stepWalker(agent, model, dtMs, STAFF_SPEED, handle)) {
          agent.state = "idle";
          agent.walkTarget = null;
          if (!handle) this.unscriptBartender(agent);
          else { model.animState = "idle"; handle.setAnim("idle"); }
        }
        return;
    }
  }

  // ── Per-customer state machine ────────────────────────────────────────

  private tickCustomer(c: Customer, dtMs: number): void {
    switch (c.state) {
      case "enter":
        // Walk toward our assigned bar-queue slot. The slot may shift
        // forward as customers ahead of us are served — refreshQueueTargets
        // updates `c.walkTarget` and stepWalker repaths automatically.
        if (this.stepWalker(c, c.model, dtMs, CUSTOMER_SPEED, c.borrowed?.handle ?? null)) {
          c.state = "waitingForOrderBartender";
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} enter → waitingForOrderBartender ` +
              `slot=${this.barQueue.indexOf(c)}`,
          );
        }
        return;

      case "waitingForOrderBartender": {
        // Keep walking forward when the queue shifts.
        this.stepWalker(c, c.model, dtMs, CUSTOMER_SPEED, c.borrowed?.handle ?? null);
        const idx = this.barQueue.indexOf(c);
        if (idx !== 0) return;
        // Front of line — start the patience timer once we've spatially
        // arrived at the head spot, then try to claim a bartender.
        if (!c.atBarHead) {
          const head = this.barOrderPx();
          const dist = Math.hypot(c.model.x - head.x, c.model.y - head.y);
          if (dist > ARRIVE_RADIUS * 2) return;
          c.atBarHead = true;
          c.waitLeftMs = ORDER_BARTENDER_PATIENCE_MS;
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} reached bar head ` +
              `(patience=${ORDER_BARTENDER_PATIENCE_MS}ms)`,
          );
        }
        const bartender = this.claimFreeBartender(c.model.id, "order");
        if (bartender) {
          this.dequeueFromBar(c);
          c.bartenderNpcId = bartender.npcId;
          c.serveLeftMs = ORDER_SERVICE_MS;
          c.state = "ordering";
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} waitingForOrderBartender → ordering ` +
              `bartender=${shortNpcId(bartender.npcId)}`,
          );
          return;
        }
        c.waitLeftMs -= dtMs;
        if (c.waitLeftMs <= 0) {
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} waitingForOrderBartender → walkout ` +
              `(no free bartender within ${ORDER_BARTENDER_PATIENCE_MS}ms)`,
          );
          this.startWalkout(c);
        }
        return;
      }

      case "ordering": {
        const agent = c.bartenderNpcId
          ? this.bartenderAgents.get(c.bartenderNpcId)
          : null;
        if (!agent || agent.reservedBy !== c.model.id) {
          dwarn(
            this.businessId,
            `${shortNpcId(c.model.id)} ordering → walkout ` +
              `(bartender vanished mid-order)`,
          );
          c.bartenderNpcId = null;
          this.startWalkout(c);
          return;
        }
        if (agent.state !== "serving") return;
        c.serveLeftMs -= dtMs;
        if (c.serveLeftMs > 0) return;

        const seat = this.claimFreeSeat();
        if (!seat) {
          this.releaseBartender(agent);
          c.bartenderNpcId = null;
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} ordering → walkout (no free seat)`,
          );
          this.startWalkout(c);
          return;
        }
        c.seat = seat;
        const picked = this.placeOrder(c, seat.uid);
        this.releaseBartender(agent);
        c.bartenderNpcId = null;
        if (!picked) {
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} ordering → walkout ` +
              `(no menu item buildable — missing required-role staff)`,
          );
          this.startWalkout(c);
          return;
        }
        c.ticket = picked;
        this.tickets.push(picked);
        c.walkTarget = tileCenter(seat);
        c.waitLeftMs = FOOD_PATIENCE_MS;
        c.state = "walkToSeat";
        dlog(
          this.businessId,
          `${shortNpcId(c.model.id)} ordering → walkToSeat ` +
            `seat=${seat.uid} item=${picked.itemId} price=${picked.pricePerSale}g`,
        );
        return;
      }

      case "walkToSeat":
        if (this.stepWalker(c, c.model, dtMs, CUSTOMER_SPEED, c.borrowed?.handle ?? null)) {
          c.state = "waitingForFood";
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} walkToSeat → waitingForFood ` +
              `(patience=${FOOD_PATIENCE_MS}ms)`,
          );
        }
        return;

      case "waitingForFood": {
        const t = c.ticket;
        if (!t) return;
        if (t.state === "delivered") {
          c.eatingLeftMs = EATING_MS;
          c.state = "eating";
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} waitingForFood → eating (food delivered)`,
          );
          return;
        }
        // Self-serve: if the order is ready on the pickup counter and there
        // are no servers hired to bring it, customer fetches it themselves.
        // Note: a "ready" ticket may have serverNpcId set if a server is
        // walking over to claim it — don't poach in that case.
        if (t.state === "ready" && !t.serverNpcId && !this.hasServerStaff()) {
          const target = this.workstationPx("kitchen_pickup")
            ?? this.workstationPx("kitchen");
          c.walkTarget = target
            ? this.approachPx(target, { x: c.model.x, y: c.model.y })
            : c.walkTarget;
          c.state = "selfServeToPickup";
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} waitingForFood → selfServeToPickup ` +
              `(no server hired)`,
          );
          return;
        }
        c.waitLeftMs -= dtMs;
        if (c.waitLeftMs <= 0) {
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} waitingForFood → walkout ` +
              `(timed out, ticket state=${t.state})`,
          );
          this.startWalkout(c);
        }
        return;
      }

      case "selfServeToPickup":
        if (this.stepWalker(c, c.model, dtMs, CUSTOMER_SPEED, c.borrowed?.handle ?? null)) {
          if (c.ticket) c.ticket.state = "delivered";
          if (c.seat) c.walkTarget = tileCenter(c.seat);
          c.state = "selfServeToSeat";
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} selfServeToPickup → selfServeToSeat`,
          );
        }
        return;

      case "selfServeToSeat":
        if (this.stepWalker(c, c.model, dtMs, CUSTOMER_SPEED, c.borrowed?.handle ?? null)) {
          c.eatingLeftMs = EATING_MS;
          c.state = "eating";
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} selfServeToSeat → eating`,
          );
        }
        return;

      case "eating":
        c.eatingLeftMs -= dtMs;
        if (c.eatingLeftMs <= 0) {
          this.releaseSeat(c);
          this.enqueueAtBar(c);
          c.state = "walkToBarPay";
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} eating → walkToBarPay ` +
              `slot=${this.barQueue.indexOf(c)}`,
          );
        }
        return;

      case "walkToBarPay":
        if (this.stepWalker(c, c.model, dtMs, CUSTOMER_SPEED, c.borrowed?.handle ?? null)) {
          c.state = "waitingForPayBartender";
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} walkToBarPay → waitingForPayBartender ` +
              `slot=${this.barQueue.indexOf(c)}`,
          );
        }
        return;

      case "waitingForPayBartender": {
        // Keep walking forward when the queue shifts.
        this.stepWalker(c, c.model, dtMs, CUSTOMER_SPEED, c.borrowed?.handle ?? null);
        const idx = this.barQueue.indexOf(c);
        if (idx !== 0) return;
        // Only the front-of-line customer reserves a bartender.
        // No timeout — patrons wait indefinitely to pay.
        const bartender = this.claimFreeBartender(c.model.id, "pay", {
          x: c.model.x,
          y: c.model.y,
        });
        if (!bartender) return;
        this.dequeueFromBar(c);
        c.bartenderNpcId = bartender.npcId;
        c.serveLeftMs = PAY_SERVICE_MS;
        c.state = "paying";
        dlog(
          this.businessId,
          `${shortNpcId(c.model.id)} waitingForPayBartender → paying ` +
            `bartender=${shortNpcId(bartender.npcId)}`,
        );
        return;
      }

      case "paying": {
        const agent = c.bartenderNpcId
          ? this.bartenderAgents.get(c.bartenderNpcId)
          : null;
        if (!agent || agent.reservedBy !== c.model.id) {
          // Bartender vanished mid-pay — go back to waiting (patrons wait
          // indefinitely to pay, so we never give up here).
          dwarn(
            this.businessId,
            `${shortNpcId(c.model.id)} paying → waitingForPayBartender ` +
              `(bartender vanished, retrying)`,
          );
          c.bartenderNpcId = null;
          this.enqueueAtBar(c);
          c.state = "waitingForPayBartender";
          return;
        }
        if (agent.state !== "serving") return;
        c.serveLeftMs -= dtMs;
        if (c.serveLeftMs > 0) return;

        const t = c.ticket;
        if (t) {
          const dayCount = useTimeStore.getState().dayCount;
          useBusinessStore
            .getState()
            .recordSale(this.businessId, t.pricePerSale, dayCount);
          bus.emitTyped("business:saleRecorded", {
            businessId: this.businessId,
            sourceId: t.itemId,
            amount: t.pricePerSale,
          });
          t.state = "paid";
          c.ticket = null;
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} paying → leaving (paid ${t.pricePerSale}g)`,
          );
        } else {
          dlog(this.businessId, `${shortNpcId(c.model.id)} paying → leaving`);
        }
        this.releaseBartender(agent);
        c.bartenderNpcId = null;
        c.walkTarget = this.exitWalkTarget();
        c.state = "leaving";
        return;
      }

      case "leaving":
      case "walkout":
        if (this.stepWalker(c, c.model, dtMs, CUSTOMER_SPEED, c.borrowed?.handle ?? null)) {
          c.graceLeftMs = DESPAWN_GRACE_MS;
          dlog(
            this.businessId,
            `${shortNpcId(c.model.id)} ${c.state} → done (despawn)`,
          );
          c.state = "done";
          this.releaseCustomer(c);
        }
        return;

      case "done":
        return;
    }
  }

  private placeOrder(c: Customer, seatUid: string): Ticket | null {
    const def = businesses.tryGet(this.businessId);
    if (!def) return null;
    const kind = businessKinds.tryGet(def.kindId);
    if (!kind) return null;
    const state = useBusinessStore.getState().get(this.businessId);
    if (!state) return null;
    const stats = getEffectiveStats(state, kind);
    const byRole = staffByRole(state);

    // Bartender required to take the order at all.
    if ((byRole["bartender"] ?? []).length === 0) return null;

    // Pick a menu item that's unlocked AND has a staff member who can make it.
    const candidates: RevenueSourceDef[] = [];
    for (const source of kind.revenueSources) {
      if (!stats.unlockedMenus.has(source.id)) continue;
      const staffPool = byRole[source.requiresRole] ?? [];
      if (staffPool.length === 0) continue;
      candidates.push(source);
    }
    if (candidates.length === 0) return null;
    const source = candidates[Math.floor(Math.random() * candidates.length)];

    return makeTicket({
      businessId: this.businessId,
      customerNpcId: c.model.id,
      seatUid,
      itemId: source.id,
      pricePerSale: source.pricePerSale,
      cookTimeMs: source.serviceTimeMs,
    });
  }

  private startWalkout(c: Customer): void {
    if (c.ticket) {
      c.ticket.state = "paid"; // retire abandoned ticket
      c.ticket = null;
    }
    if (c.bartenderNpcId) {
      const agent = this.bartenderAgents.get(c.bartenderNpcId);
      if (agent && agent.reservedBy === c.model.id) this.releaseBartender(agent);
      c.bartenderNpcId = null;
    }
    this.dequeueFromBar(c);
    this.releaseSeat(c);
    const dayCount = useTimeStore.getState().dayCount;
    useBusinessStore.getState().recordWalkout(this.businessId, dayCount);
    c.walkTarget = this.exitWalkTarget();
    c.state = "walkout";
  }

  private releaseSeat(c: Customer): void {
    if (c.seat) {
      this.claimedSeats.delete(c.seat.uid);
      c.seat = null;
    }
  }

  private releaseCustomer(c: Customer): void {
    this.destroyIcon(c);
    if (c.borrowed) {
      // Return the body to the activity layer: release the held handle and
      // notify subscribers so the delegating PatronTavernActivity completes.
      // The NpcModel + agent stay in the registry — they belong to the
      // scene binder, not us.
      const npcId = c.borrowed.npc.id;
      try { c.borrowed.handle.release(); } catch (_e) { /* may already be released */ }
      c.borrowed = null;
      // Drop from customers eagerly here too so a follow-up requestSeat in
      // the same tick (e.g. activity replans) doesn't see this slot.
      const i = this.customers.indexOf(c);
      if (i >= 0) {
        // Mark done so the per-tick compactor at the end of `tick` removes us.
        c.state = "done";
      }
      emitPatronComplete(this.businessId, npcId);
      return;
    }
    if (entityRegistry.get(c.model.id)) entityRegistry.remove(c.model.id);
  }

  private exitWalkTarget(): { x: number; y: number } {
    const exit = this.interior.exits[0] ?? this.interior.entries[0];
    if (!exit) return { x: 0, y: 0 };
    return tileCenter(exit);
  }

  /** Pixel target for "stand at the bar to order/pay". Prefers an explicit
   *  `bar_order` workstation if authored; falls back to the bartender's
   *  `bar` workstation tile if not. */
  private barOrderPx(): { x: number; y: number } {
    const ws = this.findWorkstation("bar_order") ?? this.findWorkstation("bar");
    if (ws) return tileCenter(ws);
    return this.exitWalkTarget();
  }

  /** Unit vector pointing from the bar workstation toward the bar_order
   *  tile — i.e., the side from which customers approach. The queue
   *  extends beyond the head along this direction so customers line up
   *  away from the bar instead of stacking on the head spot. */
  private barQueueDirection(): { x: number; y: number } {
    const bar = this.findWorkstation("bar");
    const order = this.findWorkstation("bar_order");
    if (!bar || !order) return { x: 0, y: 1 };
    const dx = order.tileX - bar.tileX;
    const dy = order.tileY - bar.tileY;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x: 0, y: 1 };
    return { x: dx / len, y: dy / len };
  }

  /** Pixel position for a given queue slot. Slot 0 is the head spot at
   *  `barOrderPx`; slot N is N tiles further along the queue direction.
   *  Customers walk to their slot via stepWalker, so brief overlaps with
   *  walls or props are smoothed by pathfinding rather than failing hard. */
  private barQueueSlotPx(index: number): { x: number; y: number } {
    const head = this.barOrderPx();
    if (index <= 0) return head;
    const dir = this.barQueueDirection();
    return {
      x: head.x + dir.x * index * TILE_SIZE,
      y: head.y + dir.y * index * TILE_SIZE,
    };
  }

  private enqueueAtBar(c: Customer): void {
    if (this.barQueue.includes(c)) return;
    this.barQueue.push(c);
    this.refreshBarQueueTargets();
  }

  private dequeueFromBar(c: Customer): void {
    const i = this.barQueue.indexOf(c);
    if (i < 0) return;
    this.barQueue.splice(i, 1);
    c.atBarHead = false;
    this.refreshBarQueueTargets();
  }

  /** Reassign every queued customer's `walkTarget` based on its new index.
   *  Called whenever someone joins or leaves the queue so customers
   *  behind the gap walk forward. stepWalker repaths automatically when
   *  walkTarget changes (`pathStale`). */
  private refreshBarQueueTargets(): void {
    for (let i = 0; i < this.barQueue.length; i++) {
      this.barQueue[i].walkTarget = this.barQueueSlotPx(i);
    }
  }

  private findWorkstation(tag: string): WorkstationSpawn | null {
    for (const w of this.interior.workstations) {
      if (w.tag === tag) return w;
    }
    return null;
  }

  private claimFreeSeat(): SeatSpawn | null {
    for (const s of this.interior.seats) {
      if (this.claimedSeats.has(s.uid)) continue;
      this.claimedSeats.add(s.uid);
      return s;
    }
    return null;
  }

  // ── Staff schedule (open/close arrival & departure) ──────────────────
  //
  // For businesses with a `schedule`, this owns the spawn/despawn lifecycle
  // of staff NPCs. InteriorScene defers entirely to us for these — its
  // static spawnHiredStaff skips schedule-controlled businesses.
  //
  //   • staffPresent flips false→true (e.g. 09:40, 20 in-game min before
  //     opening): each hire is spawned at the entry tile and walked to its
  //     workstation. While walking, `presence === "arriving"` and role-
  //     agent refreshes skip the hire so a cook/server/bartender FSM can't
  //     drag the NPC away from the door walk.
  //   • staffPresent flips true→false (closing): each present hire flips
  //     to "departing". The role-agent is dropped on the next refresh and
  //     the schedule tick walks the NPC to the exit before despawning.

  private staffInTransit(hireableId: string): boolean {
    const a = this.staffAgents.get(hireableId);
    return !!a && a.presence !== "present";
  }

  private reconcileStaffSchedule(initial: boolean): void {
    if (!this.hasSchedule) return;
    if (!this.spawnStaffNpc || !this.despawnStaffNpc) return;

    const def = businesses.tryGet(this.businessId);
    if (!def) return;
    const kind = businessKinds.tryGet(def.kindId);
    if (!kind) return;
    const state = useBusinessStore.getState().get(this.businessId);
    if (!state || !state.owned) return;

    const time = useTimeStore.getState();
    const status = statusForPhase(def.schedule, time.phase, time.elapsedInPhaseMs);

    // At the close edge, eject any lingering customers — once staff are
    // leaving there's no one to take payment, and the spawn-cutoff buffer
    // is short enough that the night phase can't reliably drain the room
    // in real time. Customers currently leaving/walking out keep their
    // existing trajectory.
    if (
      !initial &&
      this.lastStaffPresent === true &&
      !status.staffPresent
    ) {
      for (const c of this.customers) {
        if (c.state === "leaving" || c.state === "walkout" || c.state === "done") continue;
        this.startWalkout(c);
      }
      // Phase 8: at the close edge, end the shift for every borrowed staffer
      // so their WorkAt activity completes and the day plan advances to
      // GoTo(home). Snapshotted because clockOutImpl mutates borrowedStaff.
      if (npcRegistryStaff.enabled) {
        for (const npcId of [...this.borrowedStaff.keys()]) {
          this.clockOutImpl(npcId);
        }
      }
    }
    this.lastStaffPresent = status.staffPresent;

    // Phase 8: when the registry staff flag is on, the activity layer drives
    // arrivals (`WorkAt(GoTo→clockIn)`) and departures (close-edge clockOut
    // above, or fired-mid-shift below). Skip the legacy synthetic arrival /
    // departure walks for this business — but still run the fired-staff
    // clockOut, since the player can fire a staffer outside reconcile timing.
    if (npcRegistryStaff.enabled) {
      const desiredHires = new Set<string>();
      for (const hire of state.staff) desiredHires.add(hire.hireableId);
      for (const npcId of [...this.borrowedStaff.keys()]) {
        const borrowed = this.borrowedStaff.get(npcId);
        if (!borrowed) continue;
        if (!desiredHires.has(borrowed.hireableId)) {
          this.clockOutImpl(npcId);
        }
      }
      return;
    }

    const rolesById = new Map<string, RoleDef>(
      kind.roles.map((r) => [r.id, r]),
    );
    const wsByTag = this.workstationTilesByTag();
    const fallbackTile = this.entryTile() ?? { tileX: 1, tileY: 1 };

    // Hires currently configured (i.e. employed) for this business.
    const desired = new Set<string>();
    for (const hire of state.staff) desired.add(hire.hireableId);

    // 1) Trigger departures: any present staffAgent whose hire is no longer
    // employed, or whose schedule says staff aren't present.
    for (const agent of this.staffAgents.values()) {
      if (agent.presence === "departing") continue;
      const fired = !desired.has(agent.hireableId);
      if (fired || !status.staffPresent) {
        this.beginStaffDeparture(agent);
      }
    }

    // 2) Trigger arrivals: every employed hire missing a staffAgent. Only
    // when the schedule says staff should be present.
    if (status.staffPresent) {
      for (const hire of state.staff) {
        if (this.staffAgents.has(hire.hireableId)) continue;
        const role = rolesById.get(hire.roleId);
        if (!role) continue;
        const sources = wsByTag.get(role.workstationTag) ?? [];
        const wsTile =
          sources.length > 0
            ? sources[hashIndex(hire.hireableId, sources.length)]
            : fallbackTile;
        const workstationPx = {
          x: (wsTile.tileX + 0.5) * TILE_SIZE,
          y: (wsTile.tileY + 0.5) * TILE_SIZE,
        };

        // On scene boot during open hours, plant staff at their station so
        // the player doesn't see everyone do a redundant arrival walk just
        // because they happened to enter the interior. Mid-session arrivals
        // (transition while player is inside) always walk in from the door.
        const spawnAtStation = initial && status.open;
        const spawnTile = spawnAtStation ? wsTile : (this.entryTile() ?? wsTile);
        const npcId = this.spawnStaffNpc(hire, spawnTile.tileX, spawnTile.tileY);
        if (!npcId) continue;
        const presence: StaffPresenceState = spawnAtStation ? "present" : "arriving";
        this.staffAgents.set(hire.hireableId, {
          hireableId: hire.hireableId,
          roleId: hire.roleId,
          npcId,
          presence,
          workstationPx,
          workstationTile: { tileX: wsTile.tileX, tileY: wsTile.tileY },
          walkTarget: presence === "arriving" ? workstationPx : null,
          walkPath: null,
          carryIcon: null,
        });
        if (presence === "arriving") {
          const model = entityRegistry.get(npcId) as NpcModel | undefined;
          if (model) model.scripted = true;
          dlog(
            this.businessId,
            `staff ${hire.hireableId} arriving — door → ws=` +
              `(${wsTile.tileX},${wsTile.tileY})`,
          );
        }
      }
      // If brand-new arrivals were inserted as 'present' (initial+open),
      // role-agent refresh hasn't seen them yet — fire so they pick up.
      if (initial) {
        bus.emitTyped("business:staffChanged", { businessId: this.businessId });
      }
    }
  }

  private beginStaffDeparture(agent: StaffAgent): void {
    const exitTile = this.entryTile();
    if (!exitTile) {
      // No exit — just despawn immediately so we don't leak.
      this.finishStaffDeparture(agent);
      return;
    }
    agent.presence = "departing";
    agent.walkTarget = {
      x: (exitTile.tileX + 0.5) * TILE_SIZE,
      y: (exitTile.tileY + 0.5) * TILE_SIZE,
    };
    agent.walkPath = null;
    const model = entityRegistry.get(agent.npcId) as NpcModel | undefined;
    if (model) model.scripted = true;
    // Drop any role-agent that's currently driving this NPC; refresh sees
    // staffInTransit=true and won't recreate one.
    bus.emitTyped("business:staffChanged", { businessId: this.businessId });
    dlog(
      this.businessId,
      `staff ${agent.hireableId} departing — ws → exit=` +
        `(${exitTile.tileX},${exitTile.tileY})`,
    );
  }

  private finishStaffDeparture(agent: StaffAgent): void {
    if (this.despawnStaffNpc) this.despawnStaffNpc(agent.npcId);
    this.staffAgents.delete(agent.hireableId);
    bus.emitTyped("business:staffChanged", { businessId: this.businessId });
  }

  private tickStaffAgents(dtMs: number): void {
    if (!this.hasSchedule) return;
    for (const agent of [...this.staffAgents.values()]) {
      const model = entityRegistry.get(agent.npcId) as NpcModel | undefined;
      if (!model) {
        // NPC vanished out from under us (e.g. scene teardown / fired);
        // drop the agent so we don't dangle.
        this.staffAgents.delete(agent.hireableId);
        continue;
      }
      if (agent.presence === "arriving") {
        if (this.stepWalker(agent, model, dtMs)) {
          agent.presence = "present";
          agent.walkTarget = null;
          agent.walkPath = null;
          model.scripted = false;
          model.animState = "idle";
          // Snap home so wander radius is centered on the workstation.
          model.def.spawn.tileX = agent.workstationTile.tileX;
          model.def.spawn.tileY = agent.workstationTile.tileY;
          model.rebindHome();
          bus.emitTyped("business:staffChanged", { businessId: this.businessId });
          dlog(
            this.businessId,
            `staff ${agent.hireableId} arrived at workstation`,
          );
        }
      } else if (agent.presence === "departing") {
        if (this.stepWalker(agent, model, dtMs)) {
          dlog(
            this.businessId,
            `staff ${agent.hireableId} reached exit — despawn`,
          );
          this.finishStaffDeparture(agent);
        }
      }
    }
  }

  private workstationTilesByTag(): Map<string, WorkstationSpawn[]> {
    const map = new Map<string, WorkstationSpawn[]>();
    for (const w of this.interior.workstations) {
      const list = map.get(w.tag) ?? [];
      list.push(w);
      map.set(w.tag, list);
    }
    return map;
  }

  private entryTile(): { tileX: number; tileY: number } | null {
    const e = this.interior.entries[0] ?? this.interior.exits[0];
    if (!e) return null;
    return { tileX: e.tileX, tileY: e.tileY };
  }


}

function tileCenter(t: { tileX: number; tileY: number }): { x: number; y: number } {
  return {
    x: (t.tileX + 0.5) * TILE_SIZE,
    y: (t.tileY + 0.5) * TILE_SIZE,
  };
}

function hashIndex(s: string, mod: number): number {
  if (mod <= 1) return 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % mod;
}
