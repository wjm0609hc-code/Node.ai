// Calendar invites (Phase 1 step 13). "@Nod add Saturday's dinner to the
// calendar" creates an event and attaches its .ics invite to Nod's one reply;
// people tap it to add the event. Changing or cancelling an event sends a new
// version with the same UID and a higher sequence, so calendars update or remove
// the event instead of adding a second one. Every invite carries an alert (see
// booking/ics.ts). A "Today: …" message in the group goes out only when someone
// asked for one (rule 1).

import { attachInvite } from "./invite-card";
import type { ContextSection } from "../agent/context";
import { defineTool, ToolError, type NodTool, type ToolContext } from "../agent/tools";
import { clockTime } from "../booking/shared";
import type { CalendarEvent, EventPatch, Group, Store } from "../db/store";
import { formatRange } from "../dates/availability";
import type { EventJob, Scheduler } from "../jobs/scheduler";
import type { Logger } from "../lib/log";
import { formatLocal, localDateTimeToUtc, toLocalDateTime } from "../lib/time";
import type { MessagingProvider } from "../messaging/types";

export interface CalendarDeps {
  store: Store;
  provider: MessagingProvider;
  scheduler: Scheduler;
  logger: Logger;
  defaultTimezone: string;
  appUrl?: string;
  now?: () => Date;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LENGTH = 2 * HOUR;
/** Timed events: the group reminder goes out this long before the start. All-day events: 9 AM on the first day. */
const REMIND_BEFORE = 3 * HOUR;
const MAX_DAYS = 60;

interface WhenInput {
  starts_at_local?: string;
  ends_at_local?: string;
  date?: string;
  end_date?: string;
}

interface When {
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
}

/** The last day of an all-day event (its stored end is the day after). */
const lastDay = (e: { endsAt: Date }) => new Date(e.endsAt.getTime() - DAY).toISOString().slice(0, 10);

export function createCalendar(deps: CalendarDeps) {
  const { store, provider, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const tzOf = (g: Group | undefined) => g?.timezone ?? deps.defaultTimezone;

  function describeWhen(e: When, tz: string): string {
    if (!e.allDay) return formatLocal(e.startsAt, tz);
    return formatRange(e.startsAt.toISOString().slice(0, 10), lastDay(e));
  }

  /** Reads a local start (and optional end) time, or all-day dates. Null when none were given. */
  function readWhen(input: WhenInput, tz: string): When | null {
    const today = toLocalDateTime(now(), tz).slice(0, 10);
    if (input.date || input.end_date) {
      if (input.starts_at_local || input.ends_at_local) throw new ToolError("Give either a time (starts_at_local) or all-day dates (date), not both.");
      if (!input.date || !DATE.test(input.date) || (input.end_date && !DATE.test(input.end_date))) throw new ToolError("Give dates like 2027-03-14.");
      const last = input.end_date ?? input.date;
      if (last < input.date) throw new ToolError("end_date has to be on or after date.");
      if (input.date < today) throw new ToolError("That date has already passed.");
      const startsAt = new Date(`${input.date}T00:00:00Z`);
      const endsAt = new Date(new Date(`${last}T00:00:00Z`).getTime() + DAY);
      if (endsAt.getTime() - startsAt.getTime() > MAX_DAYS * DAY) throw new ToolError(`All-day events can be at most ${MAX_DAYS} days.`);
      return { startsAt, endsAt, allDay: true };
    }
    if (input.starts_at_local) {
      const startsAt = localDateTimeToUtc(input.starts_at_local, tz);
      if (!startsAt) throw new ToolError("Give the time as starts_at_local, like 2026-10-03T20:00.");
      if (startsAt.getTime() < now().getTime()) throw new ToolError("That time has already passed.");
      let endsAt = new Date(startsAt.getTime() + DEFAULT_LENGTH);
      if (input.ends_at_local) {
        const e = localDateTimeToUtc(input.ends_at_local, tz);
        if (!e || e <= startsAt) throw new ToolError("ends_at_local has to be after the start.");
        if (e.getTime() - startsAt.getTime() > MAX_DAYS * DAY) throw new ToolError(`Events can be at most ${MAX_DAYS} days.`);
        endsAt = e;
      }
      return { startsAt, endsAt, allDay: false };
    }
    if (input.ends_at_local) throw new ToolError("Give the start time too (starts_at_local).");
    return null;
  }

  /** When the group reminder should go out, or null if it would already be past. */
  function reminderTime(e: When, tz: string): Date | null {
    const at = e.allDay ? localDateTimeToUtc(`${e.startsAt.toISOString().slice(0, 10)}T09:00`, tz)! : new Date(e.startsAt.getTime() - REMIND_BEFORE);
    return at.getTime() > now().getTime() + 5 * 60_000 ? at : null;
  }

  async function scheduleReminder(e: CalendarEvent): Promise<void> {
    if (!e.reminderAt) return;
    try {
      await deps.scheduler.scheduleEventReminder({ eventId: e.id, runAt: e.reminderAt });
    } catch (err) {
      logger.error("calendar.reminder_not_scheduled", { eventId: e.id, error: (err as Error).name });
    }
  }

  async function eventIn(ctx: ToolContext, eventId: string): Promise<{ group: Group; event: CalendarEvent }> {
    if (ctx.chat.kind !== "group") throw new ToolError("Calendar invites are for the group chat.");
    const event = await store.getEvent(eventId);
    if (!event || event.groupId !== ctx.chat.groupId) throw new ToolError("That event isn't in this group.");
    if (event.status === "cancelled") throw new ToolError("That event was cancelled.");
    return { group: (await store.getGroup(ctx.chat.groupId))!, event };
  }

  const whenProps = {
    starts_at_local: { type: "string" as const, description: "Local start, like 2026-10-03T20:00 (this chat's timezone)." },
    ends_at_local: { type: "string" as const, description: "Local end; default 2 hours after the start." },
    date: { type: "string" as const, description: "For an all-day event: the first day, like 2027-03-14." },
    end_date: { type: "string" as const, description: "For an all-day event: the last day (inclusive)." },
  };

  const createEvent = defineTool<{ title: string; location?: string; notes?: string; remind_group?: boolean } & WhenInput>({
    name: "create_calendar_event",
    description:
      "Make a calendar invite for the group when someone asks to add something to the calendar (a dinner, the trip dates, a meetup). " +
      "Give starts_at_local (and ends_at_local if known) for a timed event, or date and end_date for an all-day one. The invite is " +
      "attached to your reply; confirm in one short line. Set remind_group only when someone asks you to remind the group; Nod then " +
      "posts a short reminder in the chat (3 hours before, or 9 AM on the day of an all-day event). Bookings already get their own invite.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        ...whenProps,
        location: { type: "string" },
        notes: { type: "string" },
        remind_group: { type: "boolean" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (ctx.chat.kind !== "group") throw new ToolError("Calendar invites are for the group chat.");
      const group = (await store.getGroup(ctx.chat.groupId))!;
      const tz = tzOf(group);
      const when = readWhen(input, tz);
      if (!when) throw new ToolError("When is it? Pass starts_at_local, or date for an all-day event.");
      const title = input.title.trim().slice(0, 100);
      if (!title) throw new ToolError("Give the event a short title.");
      const reminderAt = input.remind_group ? reminderTime(when, tz) : null;
      const event = await store.createEvent({
        groupId: group.id,
        bookingId: null,
        title,
        ...when,
        location: input.location?.trim().slice(0, 200) || null,
        description: input.notes?.trim().slice(0, 1000) || null,
        createdByUserId: ctx.caller.userId,
        reminderAt,
      });
      await scheduleReminder(event);
      await attachInvite(ctx, deps.appUrl, event, tz);
      logger.info("calendar.created", { eventId: event.id, reminder: !!reminderAt });
      return {
        event_id: event.id,
        when: describeWhen(event, tz),
        invite: ctx.attachCard ? "goes out as a card after your reply; tapping it adds the event" : "attached to your reply",
        ...(input.remind_group ? { group_reminder: reminderAt ? formatLocal(reminderAt, tz) : "too soon for a reminder; say so" } : {}),
      };
    },
  });

  const updateEvent = defineTool<{ event_id: string; title?: string; location?: string; notes?: string; remind_group?: boolean } & WhenInput>({
    name: "update_calendar_event",
    description:
      "Change an event (time, dates, title, place, notes, or turn the group reminder on or off) when someone says the plan changed. " +
      "The updated invite is attached to your reply; tapping it updates the event already in people's calendars. For a booking's " +
      "event this doesn't change the booking itself. Confirm in one short line.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        title: { type: "string" },
        ...whenProps,
        location: { type: "string" },
        notes: { type: "string" },
        remind_group: { type: "boolean" },
      },
      required: ["event_id"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const { group, event } = await eventIn(ctx, input.event_id);
      const tz = tzOf(group);
      const when = readWhen(input, tz);
      const patch: EventPatch = {
        ...(when ?? {}),
        ...(input.title?.trim() ? { title: input.title.trim().slice(0, 100) } : {}),
        ...(input.location !== undefined ? { location: input.location.trim().slice(0, 200) || null } : {}),
        ...(input.notes !== undefined ? { description: input.notes.trim().slice(0, 1000) || null } : {}),
      };
      const remind = input.remind_group ?? !!event.reminderAt;
      if (when || input.remind_group !== undefined) patch.reminderAt = remind ? reminderTime(when ?? event, tz) : null;
      if (!Object.keys(patch).length) throw new ToolError("What should change?");
      const updated = (await store.updateEvent(event.id, patch))!;
      if (patch.reminderAt) await scheduleReminder(updated);
      await attachInvite(ctx, deps.appUrl, updated, tz);
      logger.info("calendar.updated", { eventId: updated.id, sequence: updated.sequence });
      return {
        event_id: updated.id,
        when: describeWhen(updated, tz),
        invite: "the updated invite goes with your reply; tapping it updates the event in people's calendars",
        ...(updated.reminderAt ? { group_reminder: formatLocal(updated.reminderAt, tz) } : {}),
      };
    },
  });

  const cancelEvent = defineTool<{ event_id: string }>({
    name: "cancel_calendar_event",
    description:
      "Cancel an event when the plan is off. A cancellation invite is attached to your reply; tapping it removes the event from " +
      "people's calendars. To cancel a booking, use cancel_booking instead (it cancels the invite too). Confirm in a few words.",
    inputSchema: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"], additionalProperties: false },
    async run({ event_id }, ctx) {
      const { group, event } = await eventIn(ctx, event_id);
      if (event.bookingId) {
        const booking = await store.getBooking(event.bookingId);
        if (booking?.status === "booked") throw new ToolError("That event is for a booking; cancel the booking with cancel_booking.");
      }
      const cancelled = (await store.updateEvent(event.id, { status: "cancelled", reminderAt: null }))!;
      await attachInvite(ctx, deps.appUrl, cancelled, tzOf(group));
      logger.info("calendar.cancelled", { eventId: event.id });
      return `Cancelled “${event.title}”. The cancellation goes with your reply; tapping it removes it from the calendar.`;
    },
  });

  /** Cancels a booking's invites; returns the cancelled events, for the reply to carry. */
  async function cancelForBooking(bookingId: string): Promise<CalendarEvent[]> {
    const cancelled: CalendarEvent[] = [];
    for (const e of await store.eventsForBooking(bookingId)) {
      if (e.status === "cancelled") continue;
      cancelled.push((await store.updateEvent(e.id, { status: "cancelled", reminderAt: null }))!);
    }
    return cancelled;
  }

  /** Posts the "Today: …" reminder someone asked for. Safe to repeat: re-checks the event and claims the send. */
  async function runJob(job: EventJob): Promise<void> {
    const e = await store.getEvent(job.eventId);
    if (!e || e.status === "cancelled" || !e.reminderAt || e.reminderAt.toISOString() !== job.runAt) return;
    if (!(await store.claimEventReminder(e.id))) return;
    const group = await store.getGroup(e.groupId);
    if (!group) return;
    const tz = tzOf(group);
    const where = e.location ? ` at ${e.location}` : "";
    const text = e.allDay
      ? e.endsAt.getTime() - e.startsAt.getTime() > DAY
        ? `Starting today: ${e.title} (${describeWhen(e, tz)})${where}.`
        : `Today: ${e.title}${where}.`
      : `Today: ${e.title}, ${clockTime(e.startsAt, tz)}${where}.`;
    await provider.send({ groupId: group.providerGroupId }, { text });
    logger.info("calendar.reminded", { eventId: e.id });
  }

  const section: ContextSection = async (call) => {
    if (!call.groupId) return null;
    const group = await store.getGroup(call.groupId);
    const tz = tzOf(group);
    const upcoming = (await store.listEvents(call.groupId)).filter((e) => e.status !== "cancelled" && e.endsAt.getTime() > now().getTime()).slice(0, 6);
    if (!upcoming.length) return null;
    return {
      title: "calendar",
      body: upcoming
        .map((e) => `[event ${e.id}] ${e.title} · ${describeWhen(e, tz)}${e.location ? ` · ${e.location}` : ""}${e.bookingId ? " · from a booking" : ""}${e.reminderAt ? " · group reminder on" : ""}`)
        .join("\n"),
    };
  };

  const tools: NodTool<any>[] = [createEvent, updateEvent, cancelEvent];
  return { tools, section, runJob, cancelForBooking };
}

export type Calendar = ReturnType<typeof createCalendar>;
