import { createStore, get, set } from "idb-keyval";

const DB_NAME = "sailing-rpg";
const STORE_NAME = "meta";
const KEY = "playtimeMs";

const store = createStore(DB_NAME, STORE_NAME);

/**
 * Cumulative wall-clock time the player has had the game running since first
 * launch. Persisted across sessions, not per-slot — your next save just
 * stamps whatever this total is.
 *
 * Persists to IDB on a slow interval and on visibility-hidden, not every tick.
 */
export class PlaytimeTracker {
  private accumulatedMs = 0;
  private lastTickMs = 0;
  private flushHandle: number | null = null;
  private readonly flushIntervalMs: number;
  private started = false;

  constructor(flushIntervalMs = 10_000) {
    this.flushIntervalMs = flushIntervalMs;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const prior = (await get<number>(KEY, store)) ?? 0;
    this.accumulatedMs = typeof prior === "number" && prior >= 0 ? prior : 0;
    this.lastTickMs = performance.now();
    this.flushHandle = window.setInterval(() => void this.flush(), this.flushIntervalMs);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  tick(nowMs: number = performance.now()): void {
    if (!this.started) return;
    const dt = nowMs - this.lastTickMs;
    this.lastTickMs = nowMs;
    if (dt > 0 && dt < 5_000) this.accumulatedMs += dt;
    // If dt is huge (tab was backgrounded for 30s+), discard — the player
    // wasn't actually playing.
  }

  get ms(): number {
    return this.accumulatedMs;
  }

  async flush(): Promise<void> {
    await set(KEY, this.accumulatedMs, store);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.flushHandle != null) window.clearInterval(this.flushHandle);
    document.removeEventListener("visibilitychange", this.onVisibility);
    await this.flush();
    this.started = false;
  }

  private readonly onVisibility = (): void => {
    if (document.visibilityState === "hidden") void this.flush();
  };
}
