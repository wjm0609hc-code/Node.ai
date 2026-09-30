// iCalendar (.ics) files for calendar invites (RFC 5545): UTC times for timed
// events, dates for all-day ones, escaped text, lines folded at 75 octets. Every
// version of an event keeps its UID and carries a higher SEQUENCE, so opening
// an updated (or cancelled) invite changes the event already in the calendar.

export interface IcsEvent {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  location: string | null;
  description: string | null;
  createdAt: Date;
  updatedAt?: Date | null;
  sequence?: number;
  status?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const utcStamp = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const dateStamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Folds a content line into chunks of at most 75 octets, continuation lines starting with a space. */
const encoder = new TextEncoder();

function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines carry a leading space
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

export function buildIcs(e: IcsEvent): string {
  const cancelled = e.status === "cancelled";
  const changed = e.updatedAt ?? e.createdAt;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nod//Group plans//EN",
    "CALSCALE:GREGORIAN",
    cancelled ? "METHOD:CANCEL" : "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.id}@nod`,
    `DTSTAMP:${utcStamp(changed)}`,
    `LAST-MODIFIED:${utcStamp(changed)}`,
    `SEQUENCE:${e.sequence ?? 0}`,
    cancelled ? "STATUS:CANCELLED" : "STATUS:CONFIRMED",
    e.allDay ? `DTSTART;VALUE=DATE:${dateStamp(e.startsAt)}` : `DTSTART:${utcStamp(e.startsAt)}`,
    e.allDay ? `DTEND;VALUE=DATE:${dateStamp(e.endsAt)}` : `DTEND:${utcStamp(e.endsAt)}`,
    `SUMMARY:${escape(e.title)}`,
    ...(e.location ? [`LOCATION:${escape(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${escape(e.description)}`] : []),
    // An alert: 2 hours before a timed event, noon the day before an all-day one.
    ...(cancelled ? [] : ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escape(e.title)}`, e.allDay ? "TRIGGER:-PT12H" : "TRIGGER:-PT2H", "END:VALARM"]),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
