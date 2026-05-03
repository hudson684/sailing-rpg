import { TILE_SIZE } from "../../constants";
import { BaseActivity } from "./activity";
import type { Activity, ActivityCtx } from "./activity";
import type { BodyHandle } from "../bodyHandle";
import type { WorldLocation } from "../location";
import type { NpcAgent } from "../npcAgent";

export interface SleepConfig {
  /** Tile the agent rests at (typically the home tile of their residence). */
  readonly home: WorldLocation;
  /** How long the rest lasts before completing, in sim-minutes. */
  readonly durationMinutes: number;
}

interface SleepRuntime {
  remainingMinutes: number;
}

interface SleepSerialized {
  config: SleepConfig;
  runtime: SleepRuntime;
}

const CLAIMANT = { name: "Sleep" };

/** Stand at the home tile until the rest duration elapses. Phase 8 ships the
 *  minimum: live mode parks the agent at their home tile with the idle anim;
 *  abstract mode is just a duration countdown. Bedroll/lying anim and "rests
 *  at table when home tile is in a tavern" come later. */
export class SleepActivity extends BaseActivity {
  readonly kind = "sleep";

  private handle: BodyHandle | null = null;

  constructor(public readonly config: SleepConfig, private runtime: SleepRuntime) {
    super();
  }

  static create(config: SleepConfig): SleepActivity {
    return new SleepActivity(
      { ...config, home: { ...config.home } },
      { remainingMinutes: Math.max(0, config.durationMinutes) },
    );
  }

  isComplete(): boolean { return this.runtime.remainingMinutes <= 0; }

  override enter(npc: NpcAgent, ctx: ActivityCtx): void {
    if (ctx.live && !this.handle) {
      this.handle = ctx.claimBody(npc, CLAIMANT);
      this.parkAtHome(npc);
    }
  }

  override exit(_npc: NpcAgent, _ctx: ActivityCtx): void {
    if (this.handle) { this.handle.release(); this.handle = null; }
  }

  override tickAbstract(_npc: NpcAgent, _ctx: ActivityCtx, simMinutes: number): void {
    if (simMinutes <= 0) return;
    this.runtime.remainingMinutes = Math.max(0, this.runtime.remainingMinutes - simMinutes);
  }

  override tickLive(npc: NpcAgent, ctx: ActivityCtx, _dtMs: number): void {
    if (!this.handle) {
      this.handle = ctx.claimBody(npc, CLAIMANT);
      this.parkAtHome(npc);
    }
    // Duration drains in the abstract sim tick (every 10 in-game min); live
    // tick just pins the agent at home with the idle anim.
    this.handle.setAnim("idle");
  }

  materialize(npc: NpcAgent, ctx: ActivityCtx): void {
    if (!this.handle) this.handle = ctx.claimBody(npc, CLAIMANT);
    this.parkAtHome(npc);
  }

  dematerialize(npc: NpcAgent, _ctx: ActivityCtx): void {
    npc.location = {
      sceneKey: this.config.home.sceneKey,
      tileX: this.config.home.tileX,
      tileY: this.config.home.tileY,
      facing: this.config.home.facing,
    };
    if (this.handle) { this.handle.release(); this.handle = null; }
  }

  serialize(): SleepSerialized {
    return {
      config: { ...this.config, home: { ...this.config.home } },
      runtime: { ...this.runtime },
    };
  }

  private parkAtHome(npc: NpcAgent): void {
    if (!this.handle) return;
    const px = (this.config.home.tileX + 0.5) * TILE_SIZE;
    const py = (this.config.home.tileY + 0.5) * TILE_SIZE;
    this.handle.setPosition(px, py);
    this.handle.setFacing(this.config.home.facing);
    this.handle.setAnim("idle");
    npc.location = {
      sceneKey: this.config.home.sceneKey,
      tileX: this.config.home.tileX,
      tileY: this.config.home.tileY,
      facing: this.config.home.facing,
    };
  }
}

export function deserializeSleep(data: unknown): Activity {
  const s = data as Partial<SleepSerialized>;
  if (!s.config) throw new Error("deserializeSleep: missing config");
  const remaining = Math.max(
    0,
    Math.floor(s.runtime?.remainingMinutes ?? s.config.durationMinutes ?? 0),
  );
  return new SleepActivity(
    { ...s.config, home: { ...s.config.home } },
    { remainingMinutes: remaining },
  );
}
