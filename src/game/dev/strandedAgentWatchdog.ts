// Phase 6: dev-only stranded-agent watchdog. Tracks each agent's body
// position over consecutive sim ticks (10 in-game min); if an agent is
// mid-`GoTo` and hasn't moved over N ticks, log once. Catches silent stalls
// the live pathfinder warnings miss. No-op in production builds (file gated).

import { bus } from "../bus";
import { npcRegistry } from "../sim/npcRegistry";

interface AgentTrackState {
  lastTileX: number;
  lastTileY: number;
  unchangedTicks: number;
  warned: boolean;
}

const STUCK_TICK_THRESHOLD = 4;
const tracked = new Map<string, AgentTrackState>();
let wired = false;

export function wireStrandedAgentWatchdog(): void {
  if (wired) return;
  wired = true;
  bus.onTyped("time:simTick", () => check());
}

function check(): void {
  const seen = new Set<string>();
  for (const agent of npcRegistry.allAgents()) {
    seen.add(agent.id);
    const t = tracked.get(agent.id);
    const tile = { x: agent.location.tileX, y: agent.location.tileY };
    if (!t) {
      tracked.set(agent.id, {
        lastTileX: tile.x,
        lastTileY: tile.y,
        unchangedTicks: 0,
        warned: false,
      });
      continue;
    }
    const moved = t.lastTileX !== tile.x || t.lastTileY !== tile.y;
    if (moved) {
      t.lastTileX = tile.x;
      t.lastTileY = tile.y;
      t.unchangedTicks = 0;
      t.warned = false;
      continue;
    }
    t.unchangedTicks += 1;
    const act = agent.currentActivity;
    if (
      !t.warned &&
      act?.kind === "goTo" &&
      t.unchangedTicks > STUCK_TICK_THRESHOLD
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `[stranded] ${agent.id} stuck mid-goTo at tile (${tile.x},${tile.y}) for ${t.unchangedTicks} sim ticks`,
      );
      t.warned = true;
    }
  }
  // GC trackers for unregistered agents.
  for (const id of tracked.keys()) {
    if (!seen.has(id)) tracked.delete(id);
  }
}

// Auto-wire on module load.
wireStrandedAgentWatchdog();
