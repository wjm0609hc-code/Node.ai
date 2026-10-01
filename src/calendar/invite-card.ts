// Calendar invites as Nod's product cards: the event's photo (a booking's listing or venue)
// or a calendar-style date tile, its time and place, and a tap that opens the .ics invite,
// which an iPhone offers to add (or update, or remove) in the calendar.

import type { ToolContext } from "../agent/tools";
import { inviteUrl } from "../booking/shared";
import type { CardLink, Cards } from "../cards/cards";
import type { CardSpec } from "../cards/spec";
import { formatRange } from "../dates/availability";
import type { CalendarEvent, Store } from "../db/store";
import { formatLocal } from "../lib/time";

const DAY = 86_400_000;

/** "Sat, Oct 3, 8:00 PM", or "Oct 9–12" for all-day events. */
export function eventWhen(e: Pick<CalendarEvent, "startsAt" | "endsAt" | "allDay">, tz: string): string {
  if (!e.allDay) return formatLocal(e.startsAt, tz);
  return formatRange(e.startsAt.toISOString().slice(0, 10), new Date(e.endsAt.getTime() - DAY).toISOString().slice(0, 10));
}

function localParts(e: CalendarEvent, tz: string): { month: string; day: string } {
  const at = e.allDay ? new Date(`${e.startsAt.toISOString().slice(0, 10)}T12:00:00Z`) : e.startsAt;
  const zone = e.allDay ? "UTC" : tz;
  return {
    month: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: zone }).format(at),
    day: new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: zone }).format(at),
  };
}

export async function inviteCardSpec(store: Store, appUrl: string | undefined, e: CalendarEvent, tz: string): Promise<CardSpec> {
  let photoUrl: string | undefined;
  if (e.bookingId) {
    const booking = await store.getBooking(e.bookingId);
    const option = booking ? await store.getOption(booking.optionId) : undefined;
    if (typeof option?.parsed.photoUrl === "string") photoUrl = option.parsed.photoUrl;
  }
  const cancelled = e.status === "cancelled";
  return {
    data: {
      source: cancelled ? "Calendar · cancelled" : "Calendar",
      title: e.title,
      details: [eventWhen(e, tz), e.location].filter(Boolean).join(" · "),
      footer: cancelled ? "Tap to remove it from your calendar" : e.sequence > 0 ? "Tap to update your calendar" : "Tap to add to your calendar",
      ...(photoUrl ? {} : { dateTile: localParts(e, tz) }),
    },
    ...(photoUrl ? { photoUrl } : {}),
    targetUrl: inviteUrl(appUrl, e.id),
  };
}

export async function inviteCard(cards: Cards, store: Store, appUrl: string | undefined, e: CalendarEvent, tz: string): Promise<CardLink> {
  return cards.make(e.groupId, await inviteCardSpec(store, appUrl, e, tz));
}

/** Puts the invite on Nod's reply: as a card when cards are on, else as the .ics attachment. */
export async function attachInvite(ctx: ToolContext, appUrl: string | undefined, e: CalendarEvent, tz: string): Promise<void> {
  if (ctx.cards && ctx.attachCard) ctx.attachCard(await inviteCard(ctx.cards, ctx.store, appUrl, e, tz), `event:${e.id}`);
  else ctx.attach?.(inviteUrl(appUrl, e.id));
}
