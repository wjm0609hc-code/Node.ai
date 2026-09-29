// Booking hand-off (Phase 1 step 8): Nod sends a booking link with the details
// filled in, and records the booking only when someone says it's done. Nod never
// books anything itself in Phase 1 (see CLAUDE.md, "Web search and booking").

import type { ContextSection } from "../agent/context";
import { displayName } from "../agent/context";
import { defineTool, ToolError, type NodTool, type ToolContext } from "../agent/tools";
import { resolveMember } from "../agent/tools/members";
import type { Booking, Group, Option, Store } from "../db/store";
import type { Logger } from "../lib/log";
import { formatLocal, localDateTimeToUtc } from "../lib/time";
import { optionLabel } from "../options/cards";
import { buildBookingLink, type BookingDetails } from "./links";

export interface BookingDeps {
  store: Store;
  logger: Logger;
  defaultTimezone: string;
  /** Public web app URL; calendar invites are served at {appUrl}/e/{eventId}.ics. */
  appUrl?: string;
  now?: () => Date;
}

const HOUR = 3_600_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

interface Times {
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  details: Omit<BookingDetails, "partySize">;
}

interface TimeInput {
  starts_at_local?: string;
  check_in?: string;
  check_out?: string;
}

function money(cents: number, currency: string): string {
  const n = (cents / 100).toLocaleString("en-US", { maximumFractionDigits: cents % 100 ? 2 : 0, minimumFractionDigits: cents % 100 ? 2 : 0 });
  return currency === "USD" ? `$${n}` : `${currency} ${n}`;
}

export function createBookings(deps: BookingDeps) {
  const { store, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const tzOf = (g: Group | undefined) => g?.timezone ?? deps.defaultTimezone;
  const inviteUrl = (eventId: string) => `${deps.appUrl ?? ""}/e/${eventId}.ics`;

  function describeWhen(b: { startsAt: Date | null; endsAt: Date | null; allDay: boolean }, tz: string): string {
    if (!b.startsAt) return "no time set";
    if (b.allDay && b.endsAt) return `${DAY.format(b.startsAt)} to ${DAY.format(b.endsAt)}`;
    return formatLocal(b.startsAt, tz);
  }

  /** Reads stay dates or a local start time. Null when neither was given. */
  function readTimes(input: TimeInput, tz: string): Times | null {
    if (input.check_in || input.check_out) {
      if (!input.check_in || !input.check_out || !DATE.test(input.check_in) || !DATE.test(input.check_out)) {
        throw new ToolError("Give both stay dates as check_in and check_out, like 2027-03-14.");
      }
      const startsAt = new Date(`${input.check_in}T00:00:00Z`);
      const endsAt = new Date(`${input.check_out}T00:00:00Z`);
      if (!(endsAt > startsAt)) throw new ToolError("check_out has to be after check_in.");
      return { startsAt, endsAt, allDay: true, details: { checkIn: input.check_in, checkOut: input.check_out } };
    }
    if (input.starts_at_local) {
      const startsAt = localDateTimeToUtc(input.starts_at_local, tz);
      if (!startsAt) throw new ToolError("Give the date and time as starts_at_local, like 2026-10-03T20:00.");
      if (startsAt.getTime() < now().getTime()) throw new ToolError("That time has already passed.");
      const [date, time] = input.starts_at_local.split("T") as [string, string];
      return { startsAt, endsAt: new Date(startsAt.getTime() + 2 * HOUR), allDay: false, details: { date, time: time.slice(0, 5) } };
    }
    return null;
  }

  async function groupOption(ctx: ToolContext, optionId: string | undefined): Promise<{ group: Group; option: Option }> {
    if (ctx.chat.kind !== "group") throw new ToolError("Bookings are made from the group chat.");
    const option = optionId ? await store.getOption(optionId) : undefined;
    if (!option || option.groupId !== ctx.chat.groupId) throw new ToolError("That option isn't in this group.");
    return { group: (await store.getGroup(ctx.chat.groupId))!, option };
  }

  /** The decision this option won, if any (so booking it can mark the decision booked). */
  async function decisionFor(option: Option): Promise<string | null> {
    const won = (await store.listDecisions(option.groupId)).find(
      (d) => d.winningOptionId === option.id && (d.status === "decided" || d.status === "booked"),
    );
    return won?.id ?? null;
  }

  const bookingLink = defineTool<{ option_id: string; party_size: number } & TimeInput>({
    name: "booking_link",
    description:
      "Get a booking or reservation link for an option the group picked, with the party size and time (or stay dates) filled in where " +
      "the site allows, or the venue's phone number. Restaurants and activities: starts_at_local like 2026-10-03T20:00 (this chat's " +
      "timezone). Rentals: check_in and check_out dates. Post the link and ask whoever books it to reply '@Nod we booked it'. " +
      "Nod doesn't book anything itself, so never say it's booked.",
    inputSchema: {
      type: "object",
      properties: {
        option_id: { type: "string" },
        party_size: { type: "integer", minimum: 1, maximum: 50 },
        starts_at_local: { type: "string" },
        check_in: { type: "string" },
        check_out: { type: "string" },
      },
      required: ["option_id", "party_size"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const { group, option } = await groupOption(ctx, input.option_id);
      const tz = tzOf(group);
      const times = readTimes(input, tz);
      if (option.kind === "rental" && !times?.allDay) throw new ToolError("Rentals need check_in and check_out dates, like 2027-03-14.");
      if (!times) throw new ToolError("Give the date and time as starts_at_local, like 2026-10-03T20:00.");

      const base = typeof option.parsed.bookingUrl === "string" ? option.parsed.bookingUrl : option.url;
      const link = buildBookingLink(base, { partySize: input.party_size, ...times.details });
      const booking = await store.createBooking({
        groupId: group.id,
        optionId: option.id,
        decisionId: await decisionFor(option),
        requestedByUserId: ctx.caller.userId,
        partySize: input.party_size,
        startsAt: times.startsAt,
        endsAt: times.endsAt,
        allDay: times.allDay,
        link: link.url,
        method: "link",
      });
      logger.info("booking.link_sent", { bookingId: booking.id, prefilled: link.prefilled });

      const phone = typeof option.parsed.phone === "string" ? option.parsed.phone : undefined;
      const pickText = times.allDay
        ? describeWhen(times, tz)
        : new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(times.startsAt).replace(/ /g, " ");
      return {
        booking_id: booking.id,
        option: optionLabel(option),
        link: link.url,
        prefilled: link.prefilled,
        when: describeWhen(times, tz),
        party_size: input.party_size,
        ...(phone ? { phone } : {}),
        ...(link.prefilled
          ? {}
          : { note: `The link couldn't be filled in. Tell them to pick ${pickText} for ${input.party_size} on the page${phone ? ", or call" : ""}.` }),
      };
    },
  });

  const markBooked = defineTool<
    {
      booking_id?: string;
      option_id?: string;
      party_size?: number;
      confirmation_code?: string;
      deposit_cents?: number;
      deposit_currency?: string;
      paid_by?: string;
      notes?: string;
    } & TimeInput
  >({
    name: "mark_booked",
    description:
      "Record a booking someone in the chat says they completed ('we booked it', a forwarded confirmation). Only call this after a person " +
      "confirms the booking is done. Use the booking_id from bookings (or option_id plus the time and party_size if they booked on their own). " +
      "Include the confirmation code and any deposit (in cents, and who paid) if they mention them. A calendar invite is attached to your " +
      "reply automatically; confirm in one short message.",
    inputSchema: {
      type: "object",
      properties: {
        booking_id: { type: "string" },
        option_id: { type: "string" },
        party_size: { type: "integer", minimum: 1, maximum: 50 },
        starts_at_local: { type: "string" },
        check_in: { type: "string" },
        check_out: { type: "string" },
        confirmation_code: { type: "string" },
        deposit_cents: { type: "integer", minimum: 0 },
        deposit_currency: { type: "string" },
        paid_by: { type: "string", description: "Who paid the deposit, by name. Defaults to the person telling you." },
        notes: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (ctx.chat.kind !== "group") throw new ToolError("Bookings are made from the group chat.");
      const group = (await store.getGroup(ctx.chat.groupId))!;
      const tz = tzOf(group);

      let booking: Booking | undefined;
      if (input.booking_id) {
        booking = await store.getBooking(input.booking_id);
        if (!booking || booking.groupId !== group.id) throw new ToolError("That booking isn't in this group.");
      } else if (input.option_id) {
        await groupOption(ctx, input.option_id);
        booking = (await store.listBookings(group.id)).find((b) => b.optionId === input.option_id && b.status === "link_sent");
      } else {
        throw new ToolError("Which booking? Pass booking_id, or option_id for something booked without a link.");
      }

      const times = readTimes(input, tz);
      if (!booking) {
        if (!times || !input.party_size) {
          throw new ToolError("When is it? Pass starts_at_local (or check_in and check_out for a stay), and party_size.");
        }
        const option = (await store.getOption(input.option_id!))!;
        booking = await store.createBooking({
          groupId: group.id,
          optionId: option.id,
          decisionId: await decisionFor(option),
          requestedByUserId: ctx.caller.userId,
          partySize: input.party_size,
          startsAt: times.startsAt,
          endsAt: times.endsAt,
          allDay: times.allDay,
          link: null,
          method: "link",
        });
      } else if (times || input.party_size) {
        await store.updateBooking(booking.id, {
          ...(times ? { startsAt: times.startsAt, endsAt: times.endsAt, allDay: times.allDay } : {}),
          ...(input.party_size ? { partySize: input.party_size } : {}),
        });
        booking = (await store.getBooking(booking.id))!;
      }
      if (!booking.startsAt || !booking.endsAt) {
        throw new ToolError("When is it? Pass starts_at_local (or check_in and check_out for a stay), and party_size.");
      }

      const confirmation: Record<string, unknown> = { ...booking.confirmation };
      if (input.confirmation_code) confirmation.code = input.confirmation_code;
      if (input.notes) confirmation.notes = input.notes;
      let note: string | undefined;
      if (input.deposit_cents) {
        const payer = input.paid_by ? resolveMember(ctx, input.paid_by) : undefined;
        const currency = (input.deposit_currency ?? "USD").toUpperCase();
        confirmation.depositCents = input.deposit_cents;
        confirmation.depositCurrency = currency;
        confirmation.depositPaidByUserId = payer?.userId ?? ctx.caller.userId;
        note = `${payer ? displayName(payer) : ctx.caller.name}'s ${money(input.deposit_cents, currency)} deposit is saved on the booking.`;
      }
      await store.updateBooking(booking.id, { status: "booked", bookedByUserId: ctx.caller.userId, confirmation });
      if (booking.decisionId) await store.updateDecision(booking.decisionId, { status: "booked" });

      const option = (await store.getOption(booking.optionId))!;
      const label = optionLabel(option);
      const code = typeof confirmation.code === "string" ? confirmation.code : undefined;
      const event = await store.createEvent({
        groupId: group.id,
        bookingId: booking.id,
        title: booking.allDay ? label : `${label}, ${booking.partySize} people`,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        allDay: booking.allDay,
        location: typeof option.parsed.address === "string" ? option.parsed.address : null,
        description: `Booked by ${ctx.caller.name}.${code ? ` Confirmation ${code}.` : ""}`,
      });
      ctx.attach?.(inviteUrl(event.id));
      logger.info("booking.booked", { bookingId: booking.id, eventId: event.id });
      return {
        booking_id: booking.id,
        event_id: event.id,
        calendar_invite: inviteUrl(event.id),
        when: describeWhen(booking, tz),
        ...(note ? { note } : {}),
      };
    },
  });

  const cancelBooking = defineTool<{ booking_id: string }>({
    name: "cancel_booking",
    description: "Mark a booking cancelled when someone says it was cancelled (Nod can't cancel it with the venue). Then confirm briefly.",
    inputSchema: { type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"], additionalProperties: false },
    async run({ booking_id }, ctx) {
      if (ctx.chat.kind !== "group") throw new ToolError("Bookings are made from the group chat.");
      const booking = await store.getBooking(booking_id);
      if (!booking || booking.groupId !== ctx.chat.groupId) throw new ToolError("That booking isn't in this group.");
      await store.updateBooking(booking.id, { status: "cancelled" });
      if (booking.decisionId) {
        const d = await store.getDecision(booking.decisionId);
        if (d?.status === "booked") await store.updateDecision(d.id, { status: "decided" });
      }
      const option = await store.getOption(booking.optionId);
      return `Marked the ${option ? optionLabel(option) : ""} booking cancelled.`;
    },
  });

  const section: ContextSection = async (call) => {
    if (!call.groupId) return null;
    const list = (await store.listBookings(call.groupId)).slice(0, 5);
    if (!list.length) return null;
    const group = await store.getGroup(call.groupId);
    const lines = await Promise.all(
      list.map(async (b) => {
        const option = await store.getOption(b.optionId);
        const code = typeof b.confirmation.code === "string" ? ` (confirmation ${b.confirmation.code})` : "";
        const status = b.status === "link_sent" ? "link sent, not booked yet" : b.status === "booked" ? `booked${code}` : "cancelled";
        return `[booking ${b.id}] ${option ? optionLabel(option) : "?"} · ${describeWhen(b, tzOf(group))} · ${b.partySize} people · ${status}`;
      }),
    );
    return { title: "bookings", body: lines.join("\n") };
  };

  const tools: NodTool<any>[] = [bookingLink, markBooked, cancelBooking];
  return { tools, section };
}
