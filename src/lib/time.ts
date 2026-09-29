// Local times for a chat's timezone, without a date library: "Friday 6pm" is a
// local time, deadlines are stored in UTC, and people see local times again.

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Offset of `tz` from UTC at instant `utcMs`, in ms (positive east of UTC). */
function offsetAt(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** "2026-10-02T18:00" in `tz` → the UTC instant. Null if malformed. */
export function localDateTimeToUtc(local: string, tz: string): Date | null {
  const m = LOCAL.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes settle the offset across DST changes.
  let utc = wall - offsetAt(wall, tz);
  utc = wall - offsetAt(utc, tz);
  return new Date(utc);
}

/** "Fri, Oct 2, 6:00 PM" in `tz`. */
export function formatLocal(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(date)
    .replace(/ /g, " ");
}

/** A line for Claude's context so it can turn "Friday 6pm" into a local date-time. */
export function localNowLine(now: Date, tz: string): string {
  return `Local time for this chat: ${formatLocal(now, tz)} (${tz}). Write times people give you as local times.`;
}
