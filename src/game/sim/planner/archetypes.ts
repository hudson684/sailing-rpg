import npcArchetypesJson from "../data/npcArchetypes.json";
import touristSchedule from "../data/schedules/tourist.json";
import townsfolkDefaultSchedule from "../data/schedules/townsfolk_default.json";
import spawnGroupsJson from "../data/spawnGroups.json";

export interface ArchetypeDef {
  readonly id: string;
  readonly name: string;
  readonly spriteSet: string;
  readonly scheduleId: string;
  readonly defaultTraits: Record<string, unknown>;
}

export type TemplateTarget =
  | { readonly kind: "spawnPoint" }
  | { readonly kind: "businessArrival"; readonly businessId: string }
  | { readonly kind: "namedTile"; readonly name: string };

export type TemplateKind =
  | "browse"
  | "patronTavern"
  | "wander"
  | "idle"
  | "goTo";

export interface ScheduleTemplate {
  readonly id: string;
  readonly kind: TemplateKind;
  readonly target: TemplateTarget;
  readonly weight: number;
  /** Inclusive sim-minute window during which this activity is valid. When
   *  omitted the activity is always valid. */
  readonly windowMinute?: readonly [number, number];
  /** Sim-minute duration range for activities that have a wall-clock dwell
   *  (browse, wander, idle). Picked uniformly per arrival. */
  readonly duration?: readonly [number, number];
  readonly wanderRadiusTiles?: number;
}

export interface ScheduleConstraints {
  readonly mustStartAt?: string;
  readonly mustEndAt?: string;
  readonly totalActivitiesRange?: readonly [number, number];
}

export interface ScheduleDef {
  readonly id: string;
  readonly constraints: ScheduleConstraints;
  readonly templates: readonly ScheduleTemplate[];
}

export interface SpawnGroupDef {
  readonly id: string;
  readonly archetype: string;
  readonly arrivalsPerDay: number;
  readonly arrivalWindow: { readonly earliestMinute: number; readonly latestMinute: number };
  /** Per-day-of-week multiplier on `arrivalsPerDay`. 1.0 by default. */
  readonly dayWeights: Readonly<Record<string, number>>;
}

const ARCHETYPES: ReadonlyMap<string, ArchetypeDef> = new Map(
  Object.entries(npcArchetypesJson as Record<string, Omit<ArchetypeDef, "id">>).map(
    ([id, def]) => [id, { id, ...def }],
  ),
);

const SCHEDULES: ReadonlyMap<string, ScheduleDef> = new Map(
  ([touristSchedule, townsfolkDefaultSchedule] as unknown as ScheduleDef[]).map(
    (s) => [s.id, s],
  ),
);

const SPAWN_GROUPS: ReadonlyMap<string, SpawnGroupDef> = new Map(
  Object.entries(spawnGroupsJson as Record<string, Omit<SpawnGroupDef, "id">>).map(
    ([id, def]) => [id, { id, ...def }],
  ),
);

export function getArchetype(id: string): ArchetypeDef | null {
  return ARCHETYPES.get(id) ?? null;
}

export function getSchedule(id: string): ScheduleDef | null {
  return SCHEDULES.get(id) ?? null;
}

export function getSpawnGroup(id: string): SpawnGroupDef | null {
  return SPAWN_GROUPS.get(id) ?? null;
}

export function listSpawnGroupIds(): readonly string[] {
  return [...SPAWN_GROUPS.keys()];
}

export function listArchetypeIds(): readonly string[] {
  return [...ARCHETYPES.keys()];
}
