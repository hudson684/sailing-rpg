import calendarData from "./calendar.json";

export interface CalendarMonth {
  readonly name: string;
  readonly days: number;
  readonly season: string;
}

export interface CalendarData {
  readonly week: { readonly days: readonly string[] };
  readonly months: readonly CalendarMonth[];
}

export const CALENDAR: CalendarData = calendarData as CalendarData;

export const WEEK_LENGTH = CALENDAR.week.days.length;
export const YEAR_LENGTH = CALENDAR.months.reduce((s, m) => s + m.days, 0);

export interface CalendarContext {
  readonly dayCount: number;
  readonly dayOfWeek: string;
  readonly dayOfWeekIndex: number;
  readonly monthName: string;
  readonly monthIndex: number;
  readonly dayOfMonth: number;
  readonly season: string;
  readonly year: number;
  readonly yearDay: number;
}

function clampDay(dayCount: number): number {
  return Math.max(1, Math.floor(dayCount));
}

export function dayOfWeekIndex(dayCount: number): number {
  const d = clampDay(dayCount);
  return (d - 1) % WEEK_LENGTH;
}

export function dayOfWeek(dayCount: number): string {
  return CALENDAR.week.days[dayOfWeekIndex(dayCount)];
}

export function monthOfYear(dayCount: number): {
  readonly name: string;
  readonly index: number;
  readonly dayOfMonth: number;
  readonly season: string;
  readonly year: number;
  readonly yearDay: number;
} {
  const d = clampDay(dayCount);
  const yearDay = ((d - 1) % YEAR_LENGTH) + 1;
  const year = Math.floor((d - 1) / YEAR_LENGTH) + 1;
  let acc = 0;
  for (let i = 0; i < CALENDAR.months.length; i++) {
    const m = CALENDAR.months[i];
    if (yearDay <= acc + m.days) {
      return {
        name: m.name,
        index: i,
        dayOfMonth: yearDay - acc,
        season: m.season,
        year,
        yearDay,
      };
    }
    acc += m.days;
  }
  // Unreachable: yearDay is bounded by YEAR_LENGTH.
  const last = CALENDAR.months[CALENDAR.months.length - 1];
  return { name: last.name, index: CALENDAR.months.length - 1, dayOfMonth: last.days, season: last.season, year, yearDay };
}

export function season(dayCount: number): string {
  return monthOfYear(dayCount).season;
}

export function calendarContextFor(dayCount: number): CalendarContext {
  const m = monthOfYear(dayCount);
  return {
    dayCount: clampDay(dayCount),
    dayOfWeek: dayOfWeek(dayCount),
    dayOfWeekIndex: dayOfWeekIndex(dayCount),
    monthName: m.name,
    monthIndex: m.index,
    dayOfMonth: m.dayOfMonth,
    season: m.season,
    year: m.year,
    yearDay: m.yearDay,
  };
}

export function formatCalendarLine(ctx: CalendarContext): string {
  return `Day ${ctx.dayCount} • ${ctx.dayOfWeek} • ${ctx.monthName} ${ctx.dayOfMonth} • ${ctx.season}`;
}
