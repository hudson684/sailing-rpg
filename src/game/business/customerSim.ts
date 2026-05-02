import * as Phaser from "phaser";
import { TILE_SIZE } from "../constants";
import { bus } from "../bus";
import { entityRegistry } from "../entities/registry";
import { NpcModel } from "../entities/NpcModel";
import type { MapId } from "../entities/mapId";
import type { NpcDef } from "../entities/npcTypes";
import npcDataRaw from "../data/npcs.json";
import type { NpcData } from "../entities/npcTypes";
import { useTimeStore } from "../time/timeStore";
import { useBusinessStore } from "./businessStore";
import { businesses, businessKinds } from "./registry";
import { getEffectiveStats, spawnRatePerSecond, staffByRole } from "./upgradeEffects";
import type {
  BusinessId,
  CustomerProfileDef,
  RevenueSourceDef,
} from "./businessTypes";
import type { SeatSpawn } from "../world/spawns";
import type { InteriorTilemap } from "../world/interiorTilemap";

// ─── Tunables ────────────────────────────────────────────────────────────

const SPAWN_TICK_MS = 250;
const CUSTOMER_SPEED = 36; // px/s — slightly slower than the player
const ARRIVE_RADIUS = 4; // px — "close enough" to the target tile center
const DESPAWN_GRACE_MS = 250; // small pause before removing model after LEAVE
const TOWNSFOLK_NPC_IDS = [
  "garra_chef",
  "old_salt_fisherman",
  "jory_miner",
  "elin_innkeeper",
  "tomas_farmer",
  "lilan_florist",
];

// ─── State machine ───────────────────────────────────────────────────────

type CustomerState =
  | "enter"
  | "order"
  | "wait"
  | "pay"
  | "leave"
  | "walkout"
  | "done";

interface Customer {
  model: NpcModel;
  state: CustomerState;
  seat: SeatSpawn | null;
  source: RevenueSourceDef | null;
  serviceLeftMs: number;
  busyStaffNpcId: string | null;
  walkTarget: { x: number; y: number } | null;
  graceLeftMs: number;
}

const NPCS_BY_ID: ReadonlyMap<string, NpcDef> = new Map(
  (npcDataRaw as NpcData).npcs.map((n) => [n.id, n]),
);

function pickRandomTownsfolkSource(): NpcDef | null {
  for (let i = 0; i < TOWNSFOLK_NPC_IDS.length; i++) {
    const id =
      TOWNSFOLK_NPC_IDS[Math.floor(Math.random() * TOWNSFOLK_NPC_IDS.length)];
    const def = NPCS_BY_ID.get(id);
    if (def && def.sprite) return def;
  }
  return null;
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

/** Live customer simulation for one owned business interior. Owns a Phaser
 *  timer that adds customers at a calculated rate, and advances each
 *  customer's state machine on `tick(dtMs)` (called from `InteriorScene`). */
export class CustomerSim {
  private readonly scene: Phaser.Scene;
  private readonly businessId: BusinessId;
  private readonly interiorKey: string;
  private readonly interior: InteriorTilemap;
  private readonly mapId: MapId;
  private readonly isWalkablePx: (px: number, py: number) => boolean;
  private readonly customers: Customer[] = [];
  private readonly claimedSeats = new Set<string>();
  private readonly busyStaffNpcIds = new Set<string>();
  private spawnAcc = 0;
  private spawnTimer: Phaser.Time.TimerEvent | null = null;
  private spawnSerial = 0;

  constructor(opts: {
    scene: Phaser.Scene;
    businessId: BusinessId;
    interiorKey: string;
    interior: InteriorTilemap;
    isWalkablePx: (px: number, py: number) => boolean;
  }) {
    this.scene = opts.scene;
    this.businessId = opts.businessId;
    this.interiorKey = opts.interiorKey;
    this.interior = opts.interior;
    this.mapId = { kind: "interior", key: opts.interiorKey };
    this.isWalkablePx = opts.isWalkablePx;
  }

  start(): void {
    this.spawnTimer = this.scene.time.addEvent({
      delay: SPAWN_TICK_MS,
      loop: true,
      callback: () => this.maybeSpawn(),
    });
  }

  stop(): void {
    this.spawnTimer?.destroy();
    this.spawnTimer = null;
    for (const c of this.customers) {
      if (entityRegistry.get(c.model.id)) entityRegistry.remove(c.model.id);
    }
    this.customers.length = 0;
    this.claimedSeats.clear();
    this.busyStaffNpcIds.clear();
  }

  /** Frame tick — drives every customer's state machine. */
  tick(dtMs: number): void {
    for (const c of this.customers) this.tickCustomer(c, dtMs);
    // Compact the list in-place: drop "done" customers.
    let w = 0;
    for (let r = 0; r < this.customers.length; r++) {
      const c = this.customers[r];
      if (c.state === "done") continue;
      this.customers[w++] = c;
    }
    this.customers.length = w;
  }

  // ── Spawn loop ────────────────────────────────────────────────────────

  private maybeSpawn(): void {
    const def = businesses.tryGet(this.businessId);
    if (!def) return;
    const kind = businessKinds.tryGet(def.kindId);
    if (!kind) return;
    const state = useBusinessStore.getState().get(this.businessId);
    if (!state || !state.owned) return;

    const stats = getEffectiveStats(state, kind);
    const baseRate = spawnRatePerSecond(state, kind);
    if (baseRate <= 0) return;
    this.spawnAcc += baseRate * (SPAWN_TICK_MS / 1000);

    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      if (this.customers.length >= stats.capacity) break;
      this.spawnCustomer(kind.customerProfiles);
    }
  }

  private spawnCustomer(profiles: ReadonlyArray<CustomerProfileDef>): void {
    const phase = useTimeStore.getState().phase;
    const profile = pickProfileWeighted(profiles, phase);
    if (!profile) return;
    const source = pickRandomTownsfolkSource();
    if (!source || !source.sprite) return;
    const entry = this.interior.entries[0] ?? this.interior.exits[0];
    if (!entry) return;

    const synth: NpcDef = {
      id: `customer:${this.businessId}:${++this.spawnSerial}`,
      name: profile.displayName,
      sprite: source.sprite,
      spritePackId: source.id,
      display: source.display,
      map: { interior: this.interiorKey },
      spawn: { tileX: entry.tileX, tileY: entry.tileY },
      facing: "up",
      movement: { type: "static" },
      dialogue: "",
    };

    if (entityRegistry.get(`npc:${synth.id}`)) {
      entityRegistry.remove(`npc:${synth.id}`);
    }
    const model = new NpcModel(synth, this.mapId);
    model.scripted = true; // sim drives position/anim directly
    entityRegistry.add(model);

    this.customers.push({
      model,
      state: "enter",
      seat: null,
      source: null,
      serviceLeftMs: 0,
      busyStaffNpcId: null,
      walkTarget: null,
      graceLeftMs: 0,
    });
  }

  // ── Per-customer state machine ────────────────────────────────────────

  private tickCustomer(c: Customer, dtMs: number): void {
    switch (c.state) {
      case "enter":
        if (!c.seat) {
          const seat = this.claimFreeSeat();
          if (!seat) {
            // No seat — bail. Reputation hit lives in step 9; for now we
            // just walk back out.
            this.startWalkout(c);
            return;
          }
          c.seat = seat;
          c.walkTarget = tileCenter(seat);
        }
        if (this.stepToward(c, dtMs)) {
          c.state = "order";
        }
        return;

      case "order": {
        const picked = this.pickRevenueSource(c);
        if (!picked) {
          this.startWalkout(c);
          return;
        }
        c.source = picked.source;
        c.busyStaffNpcId = picked.staffNpcId;
        this.busyStaffNpcIds.add(picked.staffNpcId);
        c.serviceLeftMs = picked.source.serviceTimeMs;
        c.state = "wait";
        return;
      }

      case "wait":
        c.serviceLeftMs -= dtMs;
        if (c.serviceLeftMs <= 0) c.state = "pay";
        return;

      case "pay": {
        if (c.source) {
          const dayCount = useTimeStore.getState().dayCount;
          useBusinessStore
            .getState()
            .recordSale(this.businessId, c.source.pricePerSale, dayCount);
        }
        if (c.busyStaffNpcId) {
          this.busyStaffNpcIds.delete(c.busyStaffNpcId);
          c.busyStaffNpcId = null;
        }
        bus.emitTyped("business:saleRecorded", {
          businessId: this.businessId,
          sourceId: c.source?.id ?? "",
          amount: c.source?.pricePerSale ?? 0,
        });
        this.startLeave(c);
        return;
      }

      case "leave":
      case "walkout":
        if (this.stepToward(c, dtMs)) {
          c.graceLeftMs = DESPAWN_GRACE_MS;
          c.state = "done";
          this.releaseCustomer(c);
        }
        return;

      case "done":
        // Already released; the compact step in tick() drops it next frame.
        return;
    }
  }

  private startWalkout(c: Customer): void {
    if (c.busyStaffNpcId) {
      this.busyStaffNpcIds.delete(c.busyStaffNpcId);
      c.busyStaffNpcId = null;
    }
    if (c.seat) {
      this.claimedSeats.delete(c.seat.uid);
      c.seat = null;
    }
    const dayCount = useTimeStore.getState().dayCount;
    useBusinessStore.getState().recordWalkout(this.businessId, dayCount);
    c.walkTarget = this.exitWalkTarget();
    c.state = "walkout";
  }

  private startLeave(c: Customer): void {
    if (c.seat) {
      this.claimedSeats.delete(c.seat.uid);
      c.seat = null;
    }
    c.walkTarget = this.exitWalkTarget();
    c.state = "leave";
  }

  private releaseCustomer(c: Customer): void {
    if (entityRegistry.get(c.model.id)) entityRegistry.remove(c.model.id);
  }

  private exitWalkTarget(): { x: number; y: number } {
    const exit = this.interior.exits[0] ?? this.interior.entries[0];
    if (!exit) return { x: 0, y: 0 };
    return tileCenter(exit);
  }

  private claimFreeSeat(): SeatSpawn | null {
    for (const s of this.interior.seats) {
      if (this.claimedSeats.has(s.uid)) continue;
      this.claimedSeats.add(s.uid);
      return s;
    }
    return null;
  }

  private pickRevenueSource(
    _c: Customer,
  ): { source: RevenueSourceDef; staffNpcId: string } | null {
    const def = businesses.tryGet(this.businessId);
    if (!def) return null;
    const kind = businessKinds.tryGet(def.kindId);
    if (!kind) return null;
    const state = useBusinessStore.getState().get(this.businessId);
    if (!state) return null;
    const stats = getEffectiveStats(state, kind);
    const byRole = staffByRole(state);

    for (const source of kind.revenueSources) {
      if (!stats.unlockedMenus.has(source.id)) continue;
      const staffPool = byRole[source.requiresRole] ?? [];
      for (const staff of staffPool) {
        const npcId = `npc:staff:${this.businessId}:${staff.hireableId}`;
        if (this.busyStaffNpcIds.has(npcId)) continue;
        if (!entityRegistry.get(npcId)) continue;
        return { source, staffNpcId: npcId };
      }
    }
    return null;
  }

  private stepToward(c: Customer, dtMs: number): boolean {
    if (!c.walkTarget) return true;
    const dx = c.walkTarget.x - c.model.x;
    const dy = c.walkTarget.y - c.model.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= ARRIVE_RADIUS) {
      c.model.animState = "idle";
      return true;
    }
    const step = Math.min(dist, CUSTOMER_SPEED * (dtMs / 1000));
    const nx = c.model.x + (dx / dist) * step;
    const ny = c.model.y + (dy / dist) * step;
    let moved = false;
    if (this.isWalkablePx(nx, c.model.y)) {
      c.model.x = nx;
      moved = true;
    }
    if (this.isWalkablePx(c.model.x, ny)) {
      c.model.y = ny;
      moved = true;
    }
    if (!moved) {
      // Stuck — give up on the current target so the state machine can
      // advance instead of pinning the model in place forever.
      c.model.animState = "idle";
      return true;
    }
    if (Math.abs(dy) > Math.abs(dx)) {
      c.model.facing = dy < 0 ? "up" : "down";
    } else {
      c.model.facing = dx < 0 ? "left" : "right";
    }
    c.model.animState = "walk";
    return false;
  }
}

function tileCenter(t: { tileX: number; tileY: number }): { x: number; y: number } {
  return {
    x: (t.tileX + 0.5) * TILE_SIZE,
    y: (t.tileY + 0.5) * TILE_SIZE,
  };
}
