export type { Facing, SceneKey, WorldLocation } from "./location";
export {
  chunkScene,
  interiorScene,
  isChunkScene,
  isInteriorScene,
  sameScene,
  tileDistance,
  tileManhattan,
} from "./location";
export type { ItemStack, NpcAgent, ReadonlyBody } from "./npcAgent";
export { BodyHandle } from "./bodyHandle";
export type {
  Activity,
  ActivityCtx,
  ActivityCtxRegistry,
  LiveCtxBindings,
  Pathfinder,
  PathWaypoint,
  PathfinderQuery,
  WalkAndThenDoState,
  WalkableProbe,
} from "./activities/activity";
export { BaseActivity, WalkAndThenDo } from "./activities/activity";
export { NoopActivity } from "./activities/noop";
export {
  WanderActivity,
  type WanderConfig,
} from "./activities/wander";
export {
  PatrolActivity,
  type PatrolConfig,
  type PatrolWaypoint,
} from "./activities/patrol";
export {
  GoToActivity,
  type GoToConfig,
} from "./activities/goTo";
export {
  PatronTavernActivity,
  type PatronTavernConfig,
  notifyPatronCompleteFromTavern,
} from "./activities/patronTavern";
export {
  IdleActivity,
  type IdleConfig,
} from "./activities/idle";
export {
  BrowseActivity,
  type BrowseConfig,
} from "./activities/browse";
export {
  StandAroundActivity,
  type StandAroundConfig,
} from "./activities/standAround";
export {
  WorkAtActivity,
  type WorkAtConfig,
  notifyShiftCompleteFromStaff,
} from "./activities/workAt";
export {
  SleepActivity,
  type SleepConfig,
} from "./activities/sleep";
export {
  browseWaypoints,
  BrowseWaypointRegistry,
  browseWaypointKey,
  DEFAULT_BROWSE_GROUP_ID,
} from "./planner/browseWaypoints";
export {
  standingSpots,
  StandingSpotRegistry,
  standingSpotKey,
  DEFAULT_STANDING_GROUP_ID,
  type StandingSpot,
} from "./planner/standingSpots";
export {
  residences,
  ResidenceRegistry,
} from "./planner/residences";
export {
  portalRegistry,
  PortalRegistry,
  type PortalLink,
} from "./portals";
export {
  registerActivityKind,
  deserializeActivity,
} from "./activities/registry";
export {
  npcRegistry,
  NpcRegistry,
  type RegistrySnapshot,
  type SceneEvent,
  type SceneEventHandler,
} from "./npcRegistry";
export {
  worldAnchors,
  WorldAnchorRegistry,
  ANCHOR_BUSINESS_ARRIVAL_PREFIX,
  ANCHOR_NAMED_TILE_PREFIX,
  ANCHOR_SPAWN_POINT_PREFIX,
  businessArrivalAnchorKey,
  namedTileAnchorKey,
  spawnPointAnchorKey,
} from "./planner/anchors";
export {
  getArchetype,
  getScheduleBundle,
  getSpawnGroup,
  listArchetypeIds,
  listScheduleBundleIds,
  listSpawnGroupIds,
  type ArchetypeDef,
  type ScheduleBundle,
  type ScheduleDef,
  type ScheduleTemplate,
  type ScheduleVariantBody,
  type SpawnGroupDef,
  type TemplateKind,
  type TemplateTarget,
} from "./planner/archetypes";
export {
  planDay,
  planDayById,
  makePlanSeed,
  getPlanLog,
  clearPlanLog,
  getPlanAnnotation,
  clearPlanAnnotation,
  type PlannerCtx,
  type PlanResult,
  type ResolvedScheduleDef,
} from "./planner/scheduler";
export {
  resolveScheduleVariant,
  resolveScheduleByArchetype,
  evaluatePredicate,
  explainResolver,
  buildPriorityKeys,
  type Predicate,
  type PredicateInputs,
  type ResolverExplanation,
  type ScheduleResolverInputs,
} from "./planner/scheduleResolver";
export { spawnDispatcher } from "./planner/spawnDispatcher";

// Phase 5: side-effect import wires the festival midnight replanner. The
// module is otherwise lazy.
import "./festivals/festivalReplanner";
export {
  loadFestivals,
  getFestival,
  festivalForDay,
  forceFestival,
  type FestivalDef,
  type FestivalParticipantTemplate,
  type SpecialAgentStep,
} from "./festivals/festivalRegistry";
