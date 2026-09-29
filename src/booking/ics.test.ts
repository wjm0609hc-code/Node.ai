import { describe, expect, it } from "vitest";
import { buildIcs } from "./ics";

describe("buildIcs", () => {
  it("builds a timed event in UTC with CRLF line endings", () => {
    const ics = buildIcs({
      id: "e1",
      title: "Dinner at Hartwood, 6 people",
      startsAt: new Date("2026-10-04T00:00:00Z"),
      endsAt: new Date("2026-10-04T02:00:00Z"),
      allDay: false,
      location: "Carretera Tulum-Boca Paila km 7.6",
      description: "Booked by Will. Confirmation ABC123.",
      createdAt: new Date("2026-09-29T15:00:00Z"),
    });
    const lines = ics.split("\r\n");
    expect(lines.slice(0, 4)).toEqual(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Nod//Group plans//EN", "CALSCALE:GREGORIAN"]);
    expect(lines).toContain("UID:e1@nod");
    expect(lines).toContain("DTSTART:20261004T000000Z");
    expect(lines).toContain("DTEND:20261004T020000Z");
    expect(lines).toContain("DTSTAMP:20260929T150000Z");
    expect(lines).toContain("SUMMARY:Dinner at Hartwood\\, 6 people");
    expect(lines).toContain("LOCATION:Carretera Tulum-Boca Paila km 7.6");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("builds an all-day stay with the check-out date as the exclusive end", () => {
    const ics = buildIcs({
      id: "e2",
      title: "Casa Azul",
      startsAt: new Date("2027-03-14T00:00:00Z"),
      endsAt: new Date("2027-03-18T00:00:00Z"),
      allDay: true,
      location: null,
      description: null,
      createdAt: new Date("2026-09-29T15:00:00Z"),
    });
    expect(ics).toContain("DTSTART;VALUE=DATE:20270314\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20270318\r\n");
    expect(ics).not.toContain("LOCATION");
  });

  it("escapes special characters and folds long lines", () => {
    const ics = buildIcs({
      id: "e3",
      title: "A; B\nC",
      startsAt: new Date("2026-10-04T00:00:00Z"),
      endsAt: new Date("2026-10-04T01:00:00Z"),
      allDay: false,
      location: null,
      description: "x".repeat(200),
      createdAt: new Date("2026-09-29T15:00:00Z"),
    });
    expect(ics).toContain("SUMMARY:A\; B\\nC");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics).toMatch(/\r\n x/);
  });
});
