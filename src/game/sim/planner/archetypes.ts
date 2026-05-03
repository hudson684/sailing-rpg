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
  | "standAround"
  | "patronTavern"
  | "wander"
  | "idle"
  | "goTo";

// Phase 2: a `when` predicate is a discriminated union over typed predicates.
// Defined in scheduleResolver.ts to keep the schema in one place; archetypes
// just types it as `unknown` at the JSON boundary and the resolver's parser
// validates it.
export type SchedulePredicate = unknown;

export interface ScheduleTemplate {
  readonly id: string;
  readonly kind: TemplateKind;
  readonly target: TemplateTarget;
  readonly weight: number;
  /** Inclusive sim-minute window during which this activity is valid. When
   *  omitted the activity is always valid. Mutually exclusive with
   *  `mustStartAt` (Phase 3). */
  readonly windowMinute?: readonly [number, number];
  /** Phase 3: hard arrival time, in sim-minutes-of-day. The planner anchors
   *  this template to start at exactly this minute, padding earlier
   *  flexible activities or trimming as needed. Mutually exclusive with
   *  `windowMinute`. */
  readonly mustStartAt?: number;
  /** Sim-minute duration range for activities that have a wall-clock dwell
   *  (browse, wander, idle). Picked uniformly per arrival. */
  readonly duration?: readonly [number, number];
  readonly wanderRadiusTiles?: number;
  /** Optional sub-zone id for `browse` / `standAround` templates. Defaults to
   *  `"all"` at the activity layer. */
  readonly standingGroupId?: string;
  readonly browseGroupId?: string;
}

export interface ScheduleConstraints {
  readonly mustStartAt?: string;
  readonly mustEndAt?: string;
  readonly totalActivitiesRange?: readonly [number, number];
}

/** A resolved schedule definition. Variants in a `ScheduleBundle` are full
 *  `ScheduleDef` bodies (or alias redirects); the resolver returns one of
 *  these per (archetype, calendar, weather, ...) lookup. */
export interface ScheduleDef {
  readonly id: string;
  readonly constraints: ScheduleConstraints;
  readonly templates: readonly ScheduleTemplate[];
}

/** Phase 1: a variant body. Either a full `ScheduleDef` body (constraints +
 *  templates) or an alias redirecting to another variant key. May carry a
 *  Phase 2 `when` predicate that gates the variant beyond key matching. */
export interface ScheduleVariantBody {
  readonly constraints?: ScheduleConstraints;
  readonly templates?: readonly ScheduleTemplate[];
  readonly alias?: string;
  readonly when?: SchedulePredicate;
}

/** Phase 1: a bundle of named variants keyed by resolution priority. The
 *  resolver picks one variant per day per agent. `default` is required. */
export interface ScheduleBundle {
  readonly id: string;
  readonly variants: Readonly<Record<string, ScheduleVariantBody>>;
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

const SCHEDULE_BUNDLES: ReadonlyMap<string, ScheduleBundle> = new Map(
  ([touristSchedule, townsfolkDefaultSchedule] as unknown as ScheduleBundle[]).map(
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

/** Phase 1: schedule lookup returns the full bundle. Use the resolver to
 *  pick a variant for a given day. */
export function getScheduleBundle(id: string): ScheduleBundle | null {
  return SCHEDULE_BUNDLES.get(id) ?? null;
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

export function listScheduleBundleIds(): readonly string[] {
  return [...SCHEDULE_BUNDLES.keys()];
}
