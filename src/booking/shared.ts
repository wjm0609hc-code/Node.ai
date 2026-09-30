// Helpers shared by the booking hand-off (booking.ts) and partner bookings (proposals.ts).

import type { Booking, CalendarEvent, Option, Store } from "../db/store";
import { formatLocal } from "../lib/time";
import { optionLabel } from "../options/cards";

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** 12000 → "$120", 1250 → "$12.50"; other currencies as "EUR 120". */
export function money(cents: number, currency = "USD"): string {
  const n = (cents / 100).toLocaleString("en-US", { maximumFractionDigits: cents % 100 ? 2 : 0, minimumFractionDigits: cents % 100 ? 2 : 0 });
  return currency === "USD" ? `$${n}` : `${currency} ${n}`;
}

export function describeWhen(b: { startsAt: Date | null; endsAt: Date | null; allDay: boolean }, tz: string): string {
  if (!b.startsAt) return "no time set";
  if (b.allDay && b.endsAt) return `${DAY.format(b.startsAt)} to ${DAY.format(b.endsAt)}`;
  return formatLocal(b.startsAt, tz);
}

/** "8:15 PM" in `tz`. */
export function clockTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d).replace(/ /g, " ");
}

/** The decision this option won, if any (so booking it can mark the decision booked). */
export async function decisionFor(store: Store, option: Option): Promise<string | null> {
  const won = (await store.listDecisions(option.groupId)).find(
    (d) => d.winningOptionId === option.id && (d.status === "decided" || d.status === "booked"),
  );
  return won?.id ?? null;
}

export function inviteUrl(appUrl: string | undefined, eventId: string): string {
  return `${appUrl ?? ""}/e/${eventId}.ics`;
}

/** The calendar event for a confirmed booking (served as an .ics invite). */
export async function createBookingEvent(store: Store, booking: Booking, option: Option, bookedBy: string): Promise<CalendarEvent> {
  const label = optionLabel(option);
  const code = typeof booking.confirmation.code === "string" ? booking.confirmation.code : undefined;
  return store.createEvent({
    groupId: booking.groupId,
    bookingId: booking.id,
    title: booking.allDay ? label : `${label}, ${booking.partySize} people`,
    startsAt: booking.startsAt!,
    endsAt: booking.endsAt!,
    allDay: booking.allDay,
    location: typeof option.parsed.address === "string" ? option.parsed.address : null,
    description: `Booked by ${bookedBy}.${code ? ` Confirmation ${code}.` : ""}`,
  });
}
