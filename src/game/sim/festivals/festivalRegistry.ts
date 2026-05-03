import type { CalendarContext } from "../calendar/calendar";
import harvestFestival from "../data/festivals/harvest_festival.json";

/** Phase 5: festival data shape. Authored as JSON; loaded into memory at
 *  module init. Two tiers of authoring: per-archetype templates (most
 *  NPCs) and per-agent overrides (the mayor's speech, etc.). */
export interface FestivalParticipantTemplate {
  /** "wander_anchor": pick a random tile within `radius` of `anchor` and
   *  wander there for the duration of the festival. */
  readonly kind: "wander_anchor" | "stand_at" | "browse_anchors";
  /** A `namedTile` anchor name. The plan builder resolves it via
   *  `worldAnchors.get(namedTileAnchorKey(...))`. */
  readonly anchor?: string;
  /** For `wander_anchor`: tile radius around the anchor. */
  readonly radius?: number;
  /** For `stand_at`: the facing direction the agent assumes after arrival. */
  readonly facing?: "up" | "down" | "left" | "right";
  /** For `browse_anchors`: an ordered list of anchors to visit. */
  readonly anchors?: readonly string[];
}

export type SpecialAgentStep =
  | { readonly kind: "goTo"; readonly anchor: string }
  | { readonly kind: "standAround"; readonly anchor: string; readonly until?: number; readonly duration?: number; readonly facing?: "up" | "down" | "left" | "right" };

export interface FestivalDef {
  readonly id: string;
  /** Which calendar day this festival fires on. */
  readonly calendarDay: { readonly season: string; readonly dayOfMonth: number };
  /** Sim scene the festival runs in (`chunk:world` for outdoor festivals). */
  readonly scene: string;
  readonly openHour: number;
  readonly closeHour: number;
  /** A `namedTile` anchor agents arrive at first. */
  readonly arrivalAnchor: string;
  /** Per-archetype templates. Key = archetype id (or `staff:<role>` prefix). */
  readonly participants: Readonly<Record<string, FestivalParticipantTemplate>>;
  /** Per-agent fully hand-built plans. Key = npc id. */
  readonly specialAgents: Readonly<Record<string, readonly SpecialAgentStep[]>>;
  /** Alias key resolved on the *next* day's bundle for everyone after the
   *  festival ends. Default: bundle's "default" variant. */
  readonly afterClose?: string;
  /** Optional: override the tourist spawn group on this day. */
  readonly touristSpawnGroupOverride?: string;
}

const FESTIVALS: ReadonlyMap<string, FestivalDef> = new Map(
  ([harvestFestival] as unknown as FestivalDef[]).map((f) => [f.id, f]),
);

export function loadFestivals(): readonly FestivalDef[] {
  return [...FESTIVALS.values()];
}

export function getFestival(id: string): FestivalDef | null {
  return FESTIVALS.get(id) ?? null;
}

/** Phase 5: returns the festival (if any) authored for the given calendar
 *  day. Pure: same calendar → same festival. Multiple festivals on the same
 *  day is unsupported (and a content authoring error). */
export function festivalForDay(calendar: CalendarContext): FestivalDef | null {
  for (const f of FESTIVALS.values()) {
    if (
      f.calendarDay.season === calendar.season &&
      f.calendarDay.dayOfMonth === calendar.dayOfMonth
    ) {
      return f;
    }
  }
  return null;
}

/** Phase 5: dev-only force. Used by `__npc.forceFestival(id)` to trigger
 *  a festival mid-game without waiting for the calendar to roll. The
 *  override is checked by `festivalForDayWithOverride` and replaces the
 *  calendar-driven lookup. */
let forcedFestivalId: string | null = null;

export function forceFestival(id: string | null): void {
  if (id !== null && !FESTIVALS.has(id)) {
    throw new Error(`forceFestival: unknown festival '${id}'`);
  }
  forcedFestivalId = id;
}

export function getForcedFestival(): FestivalDef | null {
  return forcedFestivalId ? (FESTIVALS.get(forcedFestivalId) ?? null) : null;
}
