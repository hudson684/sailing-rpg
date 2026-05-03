import { BaseActivity } from "./activity";
import type { Activity, ActivityCtx } from "./activity";
import type { NpcAgent } from "../npcAgent";

export interface NoopActivityState {
  totalMinutes: number;
  remainingMinutes: number;
}

/** Trivial activity for testing the registry plumbing — completes after the
 *  configured number of sim-minutes have ticked through `tickAbstract`. */
export class NoopActivity extends BaseActivity {
  readonly kind = "noop";

  constructor(public state: NoopActivityState) {
    super();
  }

  static create(totalMinutes: number): NoopActivity {
    const t = Math.max(0, Math.floor(totalMinutes));
    return new NoopActivity({ totalMinutes: t, remainingMinutes: t });
  }

  override tickAbstract(_npc: NpcAgent, _ctx: ActivityCtx, simMinutes: number): void {
    this.state.remainingMinutes = Math.max(0, this.state.remainingMinutes - simMinutes);
  }

  isComplete(): boolean { return this.state.remainingMinutes <= 0; }

  serialize(): NoopActivityState { return { ...this.state }; }
}

export function deserializeNoop(data: unknown): Activity {
  const s = data as Partial<NoopActivityState>;
  const total = Math.max(0, Math.floor(s.totalMinutes ?? 0));
  const rem = Math.max(0, Math.min(total, Math.floor(s.remainingMinutes ?? total)));
  return new NoopActivity({ totalMinutes: total, remainingMinutes: rem });
}
