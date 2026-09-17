/**
 * Period utility functions for MRP monthly + weekly projections.
 *
 * All calendar boundaries are anchored to **Asia/Taipei (UTC+8, no DST)** —
 * Demo factory's operating timezone. A "Monday" is a Taipei Monday, a
 * "month" is a Taipei month, regardless of whether this code runs on a
 * Taipei production server, a UTC container, or a developer's macOS box.
 *
 * Boundary representation: each period.start / period.end is a JS Date whose
 * UTC year/month/day equals the intended Taipei calendar date (with hours
 * pinned to 00:00 / 23:59:59.999 UTC). Postgres DATE columns come back from
 * Prisma as midnight UTC on the stored calendar date — i.e. with the same
 * UTC y/m/d encoding — so `date >= period.start && date <= period.end`
 * compares like-for-like without any TZ math at the call site.
 */

/** Taipei is UTC+8 year-round (no daylight saving). */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Read the Taipei calendar components of an instant.
 * Implementation: shift by +8h then read UTC fields, so day-of-week and
 * day-of-month match what a clock in Taipei would show at that instant.
 */
function taipeiCalendar(d: Date): { y: number; m: number; date: number; day: number } {
  const t = new Date(d.getTime() + TAIPEI_OFFSET_MS);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth(),
    date: t.getUTCDate(),
    day: t.getUTCDay(),
  };
}

export interface MrpPeriod {
  index: number;       // 0 = current month, 1 = next month, ...
  label: string;       // e.g. "2025/01"
  start: Date;         // First day of the month at UTC-midnight on the Taipei calendar date
  end: Date;           // Last day of the month at UTC-23:59:59 on the Taipei calendar date
}

/**
 * Generate monthly periods starting from baseDate's Taipei month.
 */
export function generateMonthlyPeriods(baseDate: Date, count: number): MrpPeriod[] {
  const { y, m } = taipeiCalendar(baseDate);
  const periods: MrpPeriod[] = [];
  for (let i = 0; i < count; i++) {
    const monthOffset = m + i;
    const actualYear = y + Math.floor(monthOffset / 12);
    const actualMonth = ((monthOffset % 12) + 12) % 12;

    const start = new Date(Date.UTC(actualYear, actualMonth, 1));
    // Day 0 of the next month = last day of this month
    const end = new Date(Date.UTC(actualYear, actualMonth + 1, 0, 23, 59, 59, 999));

    periods.push({
      index: i,
      label: `${actualYear}/${String(actualMonth + 1).padStart(2, '0')}`,
      start,
      end,
    });
  }
  return periods;
}

/**
 * Find which period index a date falls into.
 * Returns -1 for "before first period" (the prior bucket); returns
 * `periods.length` for "after last period" (the future bucket).
 *
 * Both `date` and `period.start` carry the Taipei calendar y/m/d in their
 * UTC fields, so a single UTC-y/m comparison is correct.
 */
export function dateToPeriodIndex(date: Date, periods: MrpPeriod[]): number {
  const dateY = date.getUTCFullYear();
  const dateM = date.getUTCMonth();

  for (const p of periods) {
    const pY = p.start.getUTCFullYear();
    const pM = p.start.getUTCMonth();
    if (dateY === pY && dateM === pM) return p.index;
  }

  if (periods.length > 0) {
    const fY = periods[0].start.getUTCFullYear();
    const fM = periods[0].start.getUTCMonth();
    if (dateY < fY || (dateY === fY && dateM < fM)) return -1;
  }
  return periods.length;
}

export interface MrpWeek {
  index: number;
  label: string;       // e.g. "W01 01/06"
  start: Date;
  end: Date;
}

/**
 * Generate weekly periods starting from the Monday of baseDate's Taipei week.
 *
 * Mirrors Source synthetic planning reference `getWeekStart` (line 1116) which builds Monday-anchored
 * weeks at midnight. We additionally pin the timezone explicitly to Taipei so
 * the engine produces identical week buckets whether the host is in
 * Asia/Taipei, UTC, or any other zone.
 */
export function generateWeeklyPeriods(baseDate: Date, count: number): MrpWeek[] {
  const { y, m, date, day } = taipeiCalendar(baseDate);
  // Monday-of-this-week in the Taipei calendar
  const mondayDate = date - (day === 0 ? 6 : day - 1);

  const weeks: MrpWeek[] = [];
  for (let i = 0; i < count; i++) {
    const start = new Date(Date.UTC(y, m, mondayDate + i * 7));
    const end = new Date(Date.UTC(y, m, mondayDate + i * 7 + 6, 23, 59, 59, 999));

    weeks.push({
      index: i,
      label: `W${String(i + 1).padStart(2, '0')} ${String(start.getUTCMonth() + 1).padStart(2, '0')}/${String(start.getUTCDate()).padStart(2, '0')}`,
      start,
      end,
    });
  }
  return weeks;
}

export function dateToWeekBucket(date: Date | null | undefined, weeks: MrpWeek[]): string {
  if (!date) return 'PRIOR';
  for (const week of weeks) {
    if (date >= week.start && date <= week.end) return week.label;
  }
  if (weeks.length > 0 && date < weeks[0]!.start) return 'PRIOR';
  return 'FUTURE';
}

export function dateToWeekIndex(date: Date | null | undefined, weeks: MrpWeek[]): number | null {
  const bucket = dateToWeekBucket(date, weeks);
  if (bucket === 'PRIOR') return 0;
  if (bucket === 'FUTURE') return null;
  const week = weeks.find((candidate) => candidate.label === bucket);
  return week ? week.index + 1 : null;
}

/**
 * Calculate the target completion date for a plan: the first day of the
 * target Taipei month, minus 7 days. Returned as UTC midnight on the Taipei
 * calendar date so it round-trips cleanly through Postgres DATE.
 */
export function completionDateForPeriod(baseDate: Date, periodOffset: number): Date {
  const { y, m } = taipeiCalendar(baseDate);
  const monthOffset = m + periodOffset;
  const actualYear = y + Math.floor(monthOffset / 12);
  const actualMonth = ((monthOffset % 12) + 12) % 12;
  // -7 days expressed via Date.UTC's day overflow
  return new Date(Date.UTC(actualYear, actualMonth, 1 - 7));
}
