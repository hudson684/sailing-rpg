import { TILE_SIZE } from "../constants";
import {
  npcRegistry,
  registerReplanner,
  setRegisterPreEmitHook,
} from "../sim/npcRegistry";
import type { NpcAgent } from "../sim/npcAgent";
import type { SceneKey, WorldLocation } from "../sim/location";
import { WanderActivity } from "../sim/activities/wander";
import { PatrolActivity } from "../sim/activities/patrol";
import { SleepActivity } from "../sim/activities/sleep";
import type { Activity } from "../sim/activities/activity";
import { residences } from "../sim/planner/residences";
import { planDayById, makePlanSeed } from "../sim/planner/scheduler";
import { calendarContextFor } from "../sim/calendar/calendar";
import { useTimeStore } from "../time/timeStore";
import type { MapId } from "./mapId";
import { entityRegistry } from "./registry";
import { NpcModel } from "./NpcModel";
import npcDataRaw from "../data/npcs.json";
import type { NpcData, NpcDef } from "./npcTypes";

const TOWNSFOLK_ARCHETYPE_ID = "townsfolk_default";

/** Map a legacy `MapId` to the sim layer's `SceneKey`. The world map is
 *  currently a single scene — Phase 4's portal/cross-scene work will split
 *  it per-chunk, at which point this becomes per-chunk too. */
export function sceneKeyForMapId(map: MapId): SceneKey {
  switch (map.kind) {
    case "world":   return "chunk:world";
    case "interior": return `interior:${map.key}`;
    case "chunk":    return `chunk:${map.cx},${map.cy}`;
  }
}

/** Inverse of `sceneKeyForMapId`. Used by the SceneNpcBinder when an agent's
 *  cross-scene move (e.g. through a portal) needs to be reflected on its
 *  paired `NpcModel` so the destination scene's reconciler picks it up. */
export function mapIdForSceneKey(sceneKey: SceneKey): MapId {
  if (sceneKey === "chunk:world") return { kind: "world" };
  if (sceneKey.startsWith("interior:")) {
    return { kind: "interior", key: sceneKey.slice("interior:".length) };
  }
  if (sceneKey.startsWith("chunk:")) {
    const parts = sceneKey.slice("chunk:".length).split(",");
    return { kind: "chunk", cx: Number(parts[0]), cy: Number(parts[1]) };
  }
  throw new Error(`mapIdForSceneKey: unknown sceneKey '${sceneKey}'`);
}

// Keep the entity registry's `mapId` for each NPC model in sync with its
// agent's scene. Without this, an agent crossing a portal mid-`GoTo` would
// teleport in the sim layer but the model would stay attached to the source
// map — its sprite would persist in the source scene's reconciler and never
// appear in the destination scene's. Subscribing once at module load is the
// minimal hook that doesn't require the binder to know about every cross-
// scene move.
// Synchronous pre-emit hook: when the registry is about to fire
// `npcEnteredScene` for a freshly-registered agent, mint the NpcModel
// FIRST so the SceneNpcBinder's listener sees it on first emit.
setRegisterPreEmitHook((agent) => {
  ensureModelForAgent(agent, agent.location.sceneKey);
});

// Catch-up: at module load, walk every agent already in the registry and
// mint models for any synthetic-archetype agents (e.g. tourists hydrated
// from a save before this module had a chance to wire its hook). Cheap;
// `ensureModelForAgent` is idempotent.
for (const agent of npcRegistry.allAgents()) {
  ensureModelForAgent(agent, agent.location.sceneKey);
}

npcRegistry.on("npcEnteredScene", (sceneKey, npc) => {
  // For cross-scene moves (not initial register), mint a model if one
  // doesn't exist yet — handles the case where a tourist's first scene
  // change happens after a portal traversal.
  ensureModelForAgent(npc, sceneKey);
  const model = entityRegistry.get(npc.id);
  if (!model || model.kind !== "npc") return;
  entityRegistry.setMap(model.id, mapIdForSceneKey(sceneKey));
});

// When an agent fully unregisters (plan exhaustion → tourist leaves town),
// the registry fires `npcLeftScene` and then removes the agent. If we
// created a synthetic model for it, garbage-collect it here so the entity
// registry doesn't leak. Legitimate cross-scene moves keep the agent
// registered, so we only tear down when the registry no longer has it.
npcRegistry.on("npcLeftScene", (_sceneKey, npc) => {
  if (npcRegistry.get(npc.id)) return;
  if (!syntheticModelIds.has(npc.id)) return;
  syntheticModelIds.delete(npc.id);
  if (entityRegistry.get(npc.id)) entityRegistry.remove(npc.id);
});

/** Source NPCs the dispatcher copies a sprite from when minting a tourist
 *  body. Picked from the townsfolk pool already preloaded by the world
 *  scene — using one of these guarantees the texture/anim keys exist. */
const TOURIST_SPRITE_SOURCE_IDS = [
  "garra_chef",
  "old_salt_fisherman",
  "jory_miner",
  "elin_innkeeper",
  "tomas_farmer",
  "lilan_florist",
];

const NPCS_BY_ID: ReadonlyMap<string, NpcDef> = new Map(
  (npcDataRaw as NpcData).npcs.map((n) => [n.id, n]),
);

function pickTouristSpriteSource(seedId: string): NpcDef | null {
  // Stable per-agent pick so a given tourist always renders the same way
  // across reloads (the agent.id is itself stable per (day, arrivalIndex)).
  let h = 2166136261;
  for (let i = 0; i < seedId.length; i++) {
    h ^= seedId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = (h >>> 0) % TOURIST_SPRITE_SOURCE_IDS.length;
  for (let i = 0; i < TOURIST_SPRITE_SOURCE_IDS.length; i++) {
    const sourceId = TOURIST_SPRITE_SOURCE_IDS[(idx + i) % TOURIST_SPRITE_SOURCE_IDS.length];
    const def = NPCS_BY_ID.get(sourceId);
    if (def && def.sprite) return def;
  }
  return null;
}

/** Set of agent ids we minted synthetic models for. Used by the
 *  unregister cleanup so we don't try to remove models we don't own. */
const syntheticModelIds = new Set<string>();

/** If the agent is dispatcher-spawned (id starts with `npc:tourist:` and
 *  no model exists yet), create an NpcModel from a random townsfolk
 *  source so the SceneNpcBinder can pair it with a proxy. Idempotent. */
function ensureModelForAgent(npc: NpcAgent, sceneKey: SceneKey): void {
  if (entityRegistry.get(npc.id)) return;
  // Only mint for agents whose archetype is tourist — staff get their
  // models from `synthesizeStaffNpc` (the legacy reconcile path) and
  // authored townsfolk already have models from `bootstrapNpcs`.
  if (!npc.archetypeId.startsWith("tourist")) return;
  const source = pickTouristSpriteSource(npc.id);
  if (!source) return;
  // Strip the binder-required `"npc:"` prefix from the agent id so
  // NpcModel's constructor re-applies it without doubling.
  const defId = npc.id.startsWith("npc:") ? npc.id.slice(4) : npc.id;
  const synth: NpcDef = {
    id: defId,
    name: source.name,
    ...(source.sprite ? { sprite: source.sprite } : {}),
    ...(source.layered ? { layered: source.layered } : {}),
    spritePackId: source.spritePackId ?? source.id,
    display: source.display,
    map: sceneKey === "chunk:world" ? "world" : { interior: sceneKey.slice("interior:".length) },
    spawn: { tileX: npc.location.tileX, tileY: npc.location.tileY },
    facing: npc.location.facing,
    movement: { type: "static" },
    dialogue: "",
  };
  const mapId = mapIdForSceneKey(sceneKey);
  const model = new NpcModel(synth, mapId);
  // Sync to the body's pixel position so the first frame doesn't snap.
  model.x = npc.body.px;
  model.y = npc.body.py;
  entityRegistry.add(model);
  syntheticModelIds.add(npc.id);
}

/** Build a scheduled day plan for a townsfolk who has an authored residence.
 *  Falls back to a single Wander activity (the legacy behavior) if planning
 *  fails — the residence is a strong signal that this NPC should run a
 *  schedule, but we don't want a plan-failure to leave them frozen. */
function buildTownsfolkDayPlan(
  def: NpcDef,
  home: WorldLocation,
): Activity[] | null {
  const npcId = `npc:${def.id}`;
  const dayCount = useTimeStore.getState().dayCount;
  const calendar = calendarContextFor(dayCount);
  const result = planDayById(
    TOWNSFOLK_ARCHETYPE_ID,
    calendar,
    { spawnPoint: home, npcId },
    makePlanSeed(npcId, dayCount),
  );
  if (!result || result.activities.length === 0) return null;
  // Bookend the day with a sleep at the residence so non-aligned hours
  // don't leave the NPC standing in the street pre-dawn.
  const plan: Activity[] = [];
  plan.push(SleepActivity.create({ home, durationMinutes: 360 }));
  for (const a of result.activities) plan.push(a);
  plan.push(SleepActivity.create({ home, durationMinutes: 360 }));
  return plan;
}

function buildActivity(def: NpcDef, sceneKey: SceneKey): Activity | null {
  const m = def.movement;
  if (m.type === "wander") {
    return WanderActivity.create({
      home: { sceneKey, tileX: def.spawn.tileX, tileY: def.spawn.tileY, facing: def.facing },
      radiusTiles: m.radiusTiles,
      moveSpeed: m.moveSpeed,
      pauseMs: m.pauseMs,
      stepMs: m.stepMs,
    });
  }
  if (m.type === "patrol") {
    return PatrolActivity.create({
      sceneKey,
      waypoints: m.waypoints.map((wp) => ({ tileX: wp.tileX, tileY: wp.tileY })),
      moveSpeed: m.moveSpeed,
      pauseMs: m.pauseMs,
    });
  }
  return null;
}

/** Register a sim-layer `NpcAgent` for an authored NpcDef whose movement is
 *  `wander` or `patrol`. The agent shares its id with the corresponding
 *  `NpcModel` (`npc:<defId>`) so the SceneNpcBinder can pair them. Static
 *  NPCs return `null` — they don't need an agent because they have no
 *  behavior to drive. Safe to call repeatedly: re-registers if already
 *  present. */
export function registerAgentForNpcDef(def: NpcDef, mapId: MapId): NpcAgent | null {
  const sceneKey = sceneKeyForMapId(mapId);
  const id = `npc:${def.id}`;

  // Phase 9: if a residence has been authored for this townsfolk, register
  // them under the `townsfolk_default` archetype with a real day plan and
  // mark them for midnight re-planning. Without a residence, fall back to
  // the legacy single-activity wander/patrol behavior so authored NPCs
  // still come to life until residences are added.
  const home = residences.get(def.id);
  let archetypeId = def.id;
  let dayPlan: Activity[] | null = null;
  if (home && home.sceneKey === sceneKey) {
    dayPlan = buildTownsfolkDayPlan(def, home);
    if (dayPlan) archetypeId = TOWNSFOLK_ARCHETYPE_ID;
  }
  if (!dayPlan) {
    const activity = buildActivity(def, sceneKey);
    if (!activity) return null;
    dayPlan = [activity];
  }

  if (npcRegistry.get(id)) npcRegistry.unregister(id);

  const px = (def.spawn.tileX + 0.5) * TILE_SIZE;
  const py = (def.spawn.tileY + 0.5) * TILE_SIZE;

  const agent: NpcAgent = {
    id,
    archetypeId,
    body: { px, py, facing: def.facing, anim: "idle", spriteKey: def.spritePackId ?? def.id },
    location: { sceneKey, tileX: def.spawn.tileX, tileY: def.spawn.tileY, facing: def.facing },
    dayPlan,
    currentActivityIndex: 0,
    currentActivity: null,
    traits: {},
    flags: {},
    inventory: [],
  };
  npcRegistry.register(agent);
  return agent;
}

export function unregisterAgentForNpcDefId(defId: string): void {
  const id = `npc:${defId}`;
  if (npcRegistry.get(id)) npcRegistry.unregister(id);
}

// ── Townsfolk midnight replanner ────────────────────────────────────────
// Persistent townsfolk (those with an authored residence) re-roll their day
// plan at every midnight. The registry's midnight loop calls this; we use
// the residence as the spawn point so the plan starts and ends at home.
registerReplanner(TOWNSFOLK_ARCHETYPE_ID, (agent, dayCount) => {
  // Recover def from the entity registry to source up-to-date metadata.
  const model = entityRegistry.get(agent.id);
  const def = model instanceof NpcModel ? model.def : null;
  if (!def) return null;
  const defId = agent.id.startsWith("npc:") ? agent.id.slice(4) : agent.id;
  const home = residences.get(defId);
  if (!home) return null;
  void dayCount;
  return buildTownsfolkDayPlan(def, home);
});
