import { useGameStore } from "../store/gameStore";
import {
  ALL_ITEM_IDS,
  CURRENCY_ITEM_ID,
  ITEMS,
  type ItemId,
} from "../inventory/items";
import { useTimeStore } from "../time/timeStore";
import {
  calendarContextFor,
  formatCalendarLine,
  type CalendarContext,
} from "../sim/calendar/calendar";
import { npcRegistry } from "../sim/npcRegistry";
import { entityRegistry } from "../entities/registry";
import { NpcModel } from "../entities/NpcModel";
import { NoopActivity } from "../sim/activities/noop";
import { GoToActivity } from "../sim/activities/goTo";
import {
  PatronTavernActivity,
  type PatronTavernConfig,
} from "../sim/activities/patronTavern";
import { portalRegistry } from "../sim/portals";
import type { NpcAgent } from "../sim/npcAgent";
import type { Facing, SceneKey } from "../sim/location";
import { spawnDispatcher } from "../sim/planner/spawnDispatcher";
import { worldAnchors } from "../sim/planner/anchors";
import { browseWaypoints } from "../sim/planner/browseWaypoints";
import { residences } from "../sim/planner/residences";
import {
  WorkAtActivity,
  type WorkAtConfig,
} from "../sim/activities/workAt";
import { npcRegistryStaff } from "../business/staff/staffService";
import {
  listRegisteredStaffAgents,
  reconcileAllStaffAgents,
} from "../business/staff/staffAgentBootstrap";
import { planDayById, makePlanSeed } from "../sim/planner/scheduler";
import { getArchetype, getSpawnGroup, listSpawnGroupIds } from "../sim/planner/archetypes";
import { explainResolver } from "../sim/planner/scheduleResolver";
import { captureScheduleSnapshot } from "./scheduleSnapshot";
import { forceFestival, loadFestivals } from "../sim/festivals/festivalRegistry";
import { bus } from "../bus";

/**
 * Dev-only console commands. Wired up from main.tsx behind
 * `import.meta.env.DEV`, so prod bundles never include this module.
 *
 * Exposes a `dev` global (and shorthands `give` / `gold` / `help`) for use
 * from the browser devtools console.
 */

function logHelp(): void {
  const lines = [
    "Sailing RPG dev console — available commands:",
    "",
    "  dev.help()                 Show this help.",
    "  dev.gold(amount)           Add `amount` coins to inventory (negative removes).",
    "  dev.give(itemId, qty?)     Add `qty` (default 1) of `itemId` to inventory.",
    "  dev.listItems(filter?)     List item ids; optional substring filter.",
    "  dev.calendar()             Print today's calendar context (day/week/month/season).",
    "  dev.sim.spawnNoop(sceneKey, tileX, tileY, minutes)",
    "                             Register a no-op NPC agent that completes after `minutes` sim-minutes.",
    "  dev.sim.listNpcs(sceneKey) List NPCs currently registered in the given scene.",
    "  dev.sim.listTourists()     List every tourist agent: id, scene, tile, px, facing, current activity.",
    "  dev.sim.listPortals(sceneKey) List registered portals leaving the given scene.",
    "  dev.sim.testGoTo(npcId, sceneKey, tileX, tileY, facing?='down')",
    "                             Force a cross-scene GoTo for an existing NPC.",
    "  dev.sim.testPatron(npcId, businessId, arrivalSceneKey, tileX, tileY)",
    "                             Plan a PatronTavern visit for an existing agent.",
    "  dev.sim.listAnchors(filter?)",
    "                             List sim-layer named anchors (spawn points, business arrivals).",
    "  dev.sim.dispatcher()       Snapshot the spawn dispatcher (registered points + today's pending arrivals).",
    "  dev.sim.previewPlan(archetypeId, spawnGroupId?)",
    "                             Plan a day for `archetypeId` (using the spawn group's anchor) without spawning. Lists chosen + skipped templates.",
    "  dev.sim.spawnNow(spawnGroupId)",
    "                             Force-spawn one arrival from `spawnGroupId` immediately (uses today's calendar).",
    "  dev.sim.testWorkAt(npcId, businessId, roleId, arrivalSceneKey, tileX, tileY)",
    "                             Plan a WorkAt shift for an existing agent.",
    "  dev.sim.setStaffFlag(true|false)",
    "                             Toggle npcRegistryStaff (on = legacy synthesizeStaffNpc suppressed for hires with residences).",
    "  dev.sim.listResidences(filter?)",
    "                             List authored npcResidence tiles (hireableId → tile).",
    "  dev.sim.listStaffAgents()  Snapshot the registered staff agents per business.",
    "",
    "Shorthands: give(...), gold(...), help() — same as the dev.* versions.",
    "",
    "Examples:",
    "  gold(1000)",
    "  give('cutlass')",
    "  give('crab_cake', 10)",
    "  listItems('ring')",
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

function giveGold(amount: number): number {
  if (!Number.isFinite(amount) || amount === 0) {
    // eslint-disable-next-line no-console
    console.warn("gold(amount): amount must be a non-zero finite number");
    return 0;
  }
  const store = useGameStore.getState();
  if (amount > 0) {
    const leftover = store.inventoryAdd(CURRENCY_ITEM_ID, Math.floor(amount));
    const added = Math.floor(amount) - leftover;
    // eslint-disable-next-line no-console
    console.log(`+${added} coin${leftover > 0 ? ` (${leftover} dropped — inventory full)` : ""}`);
    return added;
  }
  // Negative: remove coins from any slots holding currency.
  let toRemove = Math.floor(-amount);
  let removed = 0;
  const slots = store.inventory.slots;
  for (let i = 0; i < slots.length && toRemove > 0; i++) {
    const s = slots[i];
    if (!s || s.itemId !== CURRENCY_ITEM_ID) continue;
    const r = store.inventoryRemoveAt(i, Math.min(s.quantity, toRemove));
    removed += r;
    toRemove -= r;
  }
  // eslint-disable-next-line no-console
  console.log(`-${removed} coin`);
  return -removed;
}

function giveItem(itemId: ItemId, qty: number = 1): number {
  if (!ITEMS[itemId]) {
    // eslint-disable-next-line no-console
    console.warn(`give: unknown item '${itemId}'. Try listItems().`);
    return 0;
  }
  const n = Math.floor(qty);
  if (!Number.isFinite(n) || n <= 0) {
    // eslint-disable-next-line no-console
    console.warn("give(itemId, qty): qty must be a positive integer");
    return 0;
  }
  const leftover = useGameStore.getState().inventoryAdd(itemId, n);
  const added = n - leftover;
  // eslint-disable-next-line no-console
  console.log(
    `+${added} ${itemId}${leftover > 0 ? ` (${leftover} dropped — inventory full)` : ""}`,
  );
  return added;
}

function listItems(filter?: string): ItemId[] {
  const f = filter?.toLowerCase();
  const ids = f ? ALL_ITEM_IDS.filter((id) => id.toLowerCase().includes(f)) : ALL_ITEM_IDS;
  // eslint-disable-next-line no-console
  console.log(ids.join("\n"));
  return ids;
}

function calendarNow(): CalendarContext {
  const ctx = calendarContextFor(useTimeStore.getState().dayCount);
  // eslint-disable-next-line no-console
  console.log(formatCalendarLine(ctx));
  return ctx;
}

let noopSeq = 0;

function spawnNoop(
  sceneKey: string,
  tileX: number,
  tileY: number,
  minutes: number,
): string {
  const id = `noop_${Date.now().toString(36)}_${noopSeq++}`;
  const agent: NpcAgent = {
    id,
    archetypeId: "_devNoop",
    body: { px: tileX * 16, py: tileY * 16, facing: "down", anim: "idle", spriteKey: "" },
    location: { sceneKey: sceneKey as SceneKey, tileX, tileY, facing: "down" },
    dayPlan: [NoopActivity.create(minutes)],
    currentActivityIndex: 0,
    currentActivity: null,
    traits: {},
    flags: {},
    inventory: [],
  };
  npcRegistry.register(agent);
  // eslint-disable-next-line no-console
  console.log(
    `[sim] spawned noop '${id}' at ${sceneKey} (${tileX},${tileY}) for ${minutes} sim-min — ` +
      `advance time (1 hour-tick = 60 sim-min) to complete it`,
  );
  return id;
}

function testGoTo(
  npcId: string,
  targetSceneKey: string,
  tileX: number,
  tileY: number,
  facing: Facing = "down",
): boolean {
  const agent = npcRegistry.get(npcId);
  if (!agent) {
    // eslint-disable-next-line no-console
    console.warn(`[sim] testGoTo: no agent '${npcId}'`);
    return false;
  }
  const target = {
    sceneKey: targetSceneKey as SceneKey,
    tileX: Math.floor(tileX),
    tileY: Math.floor(tileY),
    facing,
  };
  const goTo = GoToActivity.plan(agent, target);
  if (!goTo) {
    // eslint-disable-next-line no-console
    console.warn(
      `[sim] testGoTo: no portal from '${agent.location.sceneKey}' to '${targetSceneKey}' — visit the interior live first to register the reverse link, or pick a connected scene`,
    );
    return false;
  }
  // Replace the day plan with this one-shot GoTo. Phase 6's planner will
  // own scheduling — this dev hook is for manual testing of cross-scene
  // movement only.
  if (agent.currentActivity) {
    try { agent.currentActivity.exit(agent, makeDevCtx()); } catch (_err) { /* ignore */ }
  }
  agent.dayPlan = [goTo];
  agent.currentActivityIndex = 0;
  agent.currentActivity = goTo;
  goTo.enter(agent, makeDevCtx());
  const sameScene = agent.location.sceneKey === target.sceneKey;
  // eslint-disable-next-line no-console
  console.log(
    `[sim] '${npcId}': GoTo planned (${sameScene ? "1 leg, same scene" : "2 legs via portal"}) to ${targetSceneKey} (${target.tileX},${target.tileY})`,
  );
  return true;
}

function makeDevCtx() {
  // Minimal abstract-only ctx for forced enter/exit. Real runs receive a
  // full ctx via the registry tick.
  return {
    registry: npcRegistry,
    time: { minuteOfDay: 0, dayCount: 0 },
    calendar: calendarContextFor(0),
    claimBody: (npc: NpcAgent, claimant: object) => npcRegistry.claimBody(npc, claimant),
  };
}

function testPatron(
  npcId: string,
  businessId: string,
  arrivalSceneKey: string,
  arrivalTileX: number,
  arrivalTileY: number,
): boolean {
  const agent = npcRegistry.get(npcId);
  if (!agent) {
    // eslint-disable-next-line no-console
    console.warn(`[sim] testPatron: no agent '${npcId}'`);
    return false;
  }
  const config: PatronTavernConfig = {
    businessId,
    arrivalTile: {
      sceneKey: arrivalSceneKey as SceneKey,
      tileX: Math.floor(arrivalTileX),
      tileY: Math.floor(arrivalTileY),
      facing: "down",
    },
  };
  const act = PatronTavernActivity.plan(agent, config);
  if (!act) {
    // eslint-disable-next-line no-console
    console.warn(
      `[sim] testPatron: cannot plan inner GoTo from '${agent.location.sceneKey}' to '${arrivalSceneKey}'`,
    );
    return false;
  }
  if (agent.currentActivity) {
    try { agent.currentActivity.exit(agent, makeDevCtx()); } catch (_e) { /* ignore */ }
  }
  agent.dayPlan = [act];
  agent.currentActivityIndex = 0;
  agent.currentActivity = act;
  act.enter(agent, makeDevCtx());
  // eslint-disable-next-line no-console
  console.log(
    `[sim] '${npcId}': PatronTavern queued (target ${arrivalSceneKey} @ ${arrivalTileX},${arrivalTileY}, business=${businessId})`,
  );
  return true;
}

function listPortals(sceneKey?: string): void {
  const all = sceneKey
    ? portalRegistry.portalsFrom(sceneKey as SceneKey)
    : null;
  if (sceneKey) {
    if (!all || all.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[sim] no portals from ${sceneKey}`);
      return;
    }
    for (const p of all) {
      // eslint-disable-next-line no-console
      console.log(
        `${p.fromSceneKey} (${p.fromTile.x},${p.fromTile.y}) -> ${p.toSceneKey} (${p.toTile.x},${p.toTile.y})`,
      );
    }
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    "[sim] pass a sceneKey to listPortals(). Try 'chunk:world' or 'interior:tavern_rusty_anchor'.",
  );
}

function listAnchors(filter?: string): void {
  const all = worldAnchors.list();
  const f = filter?.toLowerCase();
  const items = f ? all.filter((a) => a.key.toLowerCase().includes(f)) : all;
  if (items.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[sim] no anchors${f ? ` matching '${f}'` : ""}`);
    return;
  }
  for (const a of items) {
    // eslint-disable-next-line no-console
    console.log(
      `${a.key} -> ${a.loc.sceneKey} (${a.loc.tileX},${a.loc.tileY})`,
    );
  }
}

function listResidences(filter?: string): void {
  const all = residences.list();
  const f = filter?.toLowerCase();
  const items = f ? all.filter((r) => r.hireableId.toLowerCase().includes(f)) : all;
  if (items.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[sim] no residences${f ? ` matching '${f}'` : ""}`);
    return;
  }
  for (const r of items) {
    // eslint-disable-next-line no-console
    console.log(`${r.hireableId} -> ${r.loc.sceneKey} (${r.loc.tileX},${r.loc.tileY})`);
  }
}

function setStaffFlag(enabled: boolean): boolean {
  npcRegistryStaff.enabled = !!enabled;
  // eslint-disable-next-line no-console
  console.log(
    `[sim] npcRegistryStaff flag = ${npcRegistryStaff.enabled} ` +
      `(legacy synthesizeStaffNpc ${npcRegistryStaff.enabled ? "SUPPRESSED" : "active"} for hires with residences)`,
  );
  if (npcRegistryStaff.enabled) reconcileAllStaffAgents();
  return npcRegistryStaff.enabled;
}

function listStaffAgents(): unknown {
  const snap = listRegisteredStaffAgents();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(snap, null, 2));
  return snap;
}

function testWorkAt(
  npcId: string,
  businessId: string,
  roleId: string,
  arrivalSceneKey: string,
  arrivalTileX: number,
  arrivalTileY: number,
): boolean {
  const agent = npcRegistry.get(npcId);
  if (!agent) {
    // eslint-disable-next-line no-console
    console.warn(`[sim] testWorkAt: no agent '${npcId}'`);
    return false;
  }
  const config: WorkAtConfig = {
    businessId,
    roleId,
    arrivalTile: {
      sceneKey: arrivalSceneKey as SceneKey,
      tileX: Math.floor(arrivalTileX),
      tileY: Math.floor(arrivalTileY),
      facing: "down",
    },
  };
  const act = WorkAtActivity.plan(agent, config);
  if (!act) {
    // eslint-disable-next-line no-console
    console.warn(
      `[sim] testWorkAt: cannot plan inner GoTo from '${agent.location.sceneKey}' to '${arrivalSceneKey}'`,
    );
    return false;
  }
  if (agent.currentActivity) {
    try { agent.currentActivity.exit(agent, makeDevCtx()); } catch (_e) { /* ignore */ }
  }
  agent.dayPlan = [act];
  agent.currentActivityIndex = 0;
  agent.currentActivity = act;
  act.enter(agent, makeDevCtx());
  // eslint-disable-next-line no-console
  console.log(
    `[sim] '${npcId}': WorkAt queued (target ${arrivalSceneKey} @ ${arrivalTileX},${arrivalTileY}, business=${businessId}, role=${roleId})`,
  );
  return true;
}

function listBrowseWaypoints(filter?: string): void {
  const all = browseWaypoints.list();
  const f = filter?.toLowerCase();
  const items = f ? all.filter((b) => b.key.toLowerCase().includes(f)) : all;
  if (items.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[sim] no browse waypoints${f ? ` matching '${f}'` : ""}`);
    return;
  }
  for (const b of items) {
    // eslint-disable-next-line no-console
    console.log(`${b.key} (${b.count})`);
  }
}

function dispatcherSnapshot(): unknown {
  const snap = spawnDispatcher.debugSnapshot();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(snap, null, 2));
  return snap;
}

function previewPlan(archetypeId: string, spawnGroupId?: string): unknown {
  const arch = getArchetype(archetypeId);
  if (!arch) {
    // eslint-disable-next-line no-console
    console.warn(`[sim] previewPlan: unknown archetype '${archetypeId}'`);
    return null;
  }
  let spawnPoint: { sceneKey: SceneKey; tileX: number; tileY: number; facing: Facing } = {
    sceneKey: "chunk:world" as SceneKey,
    tileX: 0,
    tileY: 0,
    facing: "down",
  };
  if (spawnGroupId) {
    const group = getSpawnGroup(spawnGroupId);
    if (!group) {
      // eslint-disable-next-line no-console
      console.warn(`[sim] previewPlan: unknown spawnGroupId '${spawnGroupId}'`);
      return null;
    }
    const snap = spawnDispatcher.debugSnapshot();
    const point = snap.spawnPoints.find((p) => p.groupId === spawnGroupId);
    if (point) {
      spawnPoint = {
        sceneKey: point.loc.sceneKey,
        tileX: point.loc.tileX,
        tileY: point.loc.tileY,
        facing: point.loc.facing,
      };
    }
  }
  const day = useTimeStore.getState().dayCount;
  const calendar = calendarContextFor(day);
  const previewId = `__preview:${archetypeId}:${day}`;
  const result = planDayById(archetypeId, calendar, {
    spawnPoint,
    npcId: previewId,
  }, makePlanSeed(previewId, day));
  // eslint-disable-next-line no-console
  console.log(
    `Plan for ${archetypeId} (${result?.activities.length ?? 0} activities). Chosen: [${(result?.chosenTemplateIds ?? []).join(",")}]. Skipped: [${(result?.skippedTemplateIds ?? []).join(",")}]`,
  );
  return result;
}

function spawnNow(spawnGroupId: string): NpcAgent | null {
  const group = getSpawnGroup(spawnGroupId);
  if (!group) {
    // eslint-disable-next-line no-console
    console.warn(`[sim] spawnNow: unknown spawnGroupId '${spawnGroupId}'. Known: ${listSpawnGroupIds().join(", ")}`);
    return null;
  }
  const snap = spawnDispatcher.debugSnapshot();
  const point = snap.spawnPoints.find((p) => p.groupId === spawnGroupId);
  if (!point) {
    // eslint-disable-next-line no-console
    console.warn(`[sim] spawnNow: no registered spawn point for '${spawnGroupId}' — load the chunk first`);
    return null;
  }
  const calendar = calendarContextFor(useTimeStore.getState().dayCount);
  // Force-spawn picks an arrival index past the dispatcher's current
  // schedule so it can't collide with a scheduled arrival's id.
  const dispatched = spawnDispatcher.debugSnapshot().daySchedules
    .find((s) => s.groupId === spawnGroupId);
  const arrivalIndex = (dispatched?.spawned ?? 0) + Date.now();
  const agent = spawnDispatcher.spawnArrival(group, point.loc, calendar, arrivalIndex);
  if (agent) {
    // eslint-disable-next-line no-console
    console.log(`[sim] spawned '${agent.id}' at ${point.loc.sceneKey} (${point.loc.tileX},${point.loc.tileY}) — ${agent.dayPlan.length} activities`);
  }
  return agent;
}

/** Snapshot of every tourist-archetype agent currently in the registry,
 *  with their scene, tile, pixel coords, current activity, AND the
 *  entity-registry model state (the entitymapId tells us which scene's
 *  SpriteReconciler is rendering them — a mismatch with the agent's
 *  sceneKey is a smoking gun for "tourist appears in the wrong scene"). */
function listTourists(): ReadonlyArray<{
  id: string;
  agentScene: string;
  modelMap: string;
  tile: { x: number; y: number };
  modelPx: { x: number; y: number } | null;
  bodyPx: { x: number; y: number };
  facing: string;
  activity: string;
  activityIndex: string;
  hasModel: boolean;
  scriptedModel: boolean;
}> {
  const all = npcRegistry.allAgents().filter((a) =>
    a.archetypeId.startsWith("tourist"),
  );
  const rows = all.map((a) => {
    const model = entityRegistry.get(a.id);
    const isNpc = model && model.kind === "npc";
    const m = isNpc ? (model as NpcModel) : null;
    return {
      id: a.id,
      agentScene: a.location.sceneKey,
      modelMap: m
        ? m.mapId.kind === "world"
          ? "world"
          : m.mapId.kind === "interior"
            ? `interior:${m.mapId.key}`
            : `chunk:${m.mapId.cx},${m.mapId.cy}`
        : "(no model)",
      tile: { x: a.location.tileX, y: a.location.tileY },
      modelPx: m ? { x: Math.round(m.x), y: Math.round(m.y) } : null,
      bodyPx: { x: Math.round(a.body.px), y: Math.round(a.body.py) },
      facing: a.body.facing,
      activity: a.currentActivity?.kind ?? "(none)",
      activityIndex: `${a.currentActivityIndex}/${a.dayPlan.length}`,
      hasModel: !!m,
      scriptedModel: m?.scripted ?? false,
    };
  });
  // eslint-disable-next-line no-console
  console.log(
    rows.length === 0
      ? "[sim] no active tourists"
      : `[sim] ${rows.length} tourist(s) active:\n` +
          rows
            .map(
              (r) => {
                const mismatch = r.modelMap !== "(no model)" && r.agentScene !== r.modelMap
                  ? "  ⚠ MISMATCH"
                  : "";
                const modelPxStr = r.modelPx
                  ? `(${r.modelPx.x},${r.modelPx.y})`
                  : "(none)";
                return (
                  `  ${r.id}\n` +
                  `    agent: ${r.agentScene} tile=(${r.tile.x},${r.tile.y}) bodyPx=(${r.bodyPx.x},${r.bodyPx.y}) facing=${r.facing}\n` +
                  `    model: map=${r.modelMap} px=${modelPxStr} hasModel=${r.hasModel} scripted=${r.scriptedModel}${mismatch}\n` +
                  `    activity: ${r.activity} ${r.activityIndex}`
                );
              },
            )
            .join("\n"),
  );
  return rows;
}

function listNpcs(sceneKey: string): readonly NpcAgent[] {
  const list = npcRegistry.npcsAt(sceneKey);
  // eslint-disable-next-line no-console
  console.log(
    list.length === 0
      ? `[sim] no npcs at ${sceneKey}`
      : list.map((a) => `${a.id} @ (${a.location.tileX},${a.location.tileY})`).join("\n"),
  );
  return list;
}

export function installDevConsole(): void {
  const w = window as unknown as Record<string, unknown>;
  const api = {
    help: logHelp,
    gold: giveGold,
    give: giveItem,
    listItems,
    calendar: calendarNow,
    sim: {
      spawnNoop,
      listNpcs,
      listTourists,
      testGoTo,
      testPatron,
      testWorkAt,
      setStaffFlag,
      listPortals,
      listAnchors,
      listBrowseWaypoints,
      listResidences,
      listStaffAgents,
      dispatcher: dispatcherSnapshot,
      previewPlan,
      spawnNow,
      registry: npcRegistry,
      portals: portalRegistry,
      staffFlag: npcRegistryStaff,
      anchors: worldAnchors,
      residences,
    },
  };
  w.dev = api;
  w.help = logHelp;
  w.gold = giveGold;
  w.give = giveItem;
  w.listItems = listItems;
  // Phase 4: dedicated NPC dev API. Stardew-style introspection helpers
  // (schedule explain, plan dump, snapshot list) live behind `__npc`.
  w.__npc = {
    explain(archetypeId: string, dayCount?: number, weather?: string | null) {
      const dc = dayCount ?? useTimeStore.getState().dayCount;
      const cal = calendarContextFor(dc);
      const archetype = getArchetype(archetypeId);
      if (!archetype) {
        return { error: `unknown archetype '${archetypeId}'` };
      }
      return explainResolver(archetype.scheduleId, cal, weather ?? null);
    },
    snapshot(activeSceneKey: string | null = null) {
      return captureScheduleSnapshot(activeSceneKey);
    },
    list() {
      return npcRegistry.allAgents().map((a) => ({
        id: a.id,
        archetype: a.archetypeId,
        scene: a.location.sceneKey,
        activity: a.currentActivity?.kind ?? "(none)",
      }));
    },
    festivals() {
      return loadFestivals().map((f) => ({
        id: f.id,
        season: f.calendarDay.season,
        dayOfMonth: f.calendarDay.dayOfMonth,
      }));
    },
    /** Phase 5: trigger a festival mid-game. Re-emits a midnight event so
     *  the festival replanner runs against the forced festival id. Pass
     *  `null` to clear the override. */
    forceFestival(festivalId: string | null) {
      forceFestival(festivalId);
      const dc = useTimeStore.getState().dayCount;
      bus.emitTyped("time:midnight", {
        dayCount: dc,
        calendar: calendarContextFor(dc),
      });
      // eslint-disable-next-line no-console
      console.log(`[__npc] forceFestival(${festivalId ?? "null"}) — re-emitted midnight at dayCount ${dc}`);
    },
  };
  // eslint-disable-next-line no-console
  console.log("[dev] console commands ready — type help() for a list. NPC api: __npc.explain/list/snapshot");
}
