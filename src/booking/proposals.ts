// Bookings Nod makes itself, through a booking partner (see partners.ts).
// The flow keeps rules 4 and 5:
//   1. Someone asks ("@Nod book Hartwood for 6 at 8pm Saturday"). Nod checks the
//      partner for that exact time and posts one message with the exact terms:
//      venue, time, party size, deposit and cancellation policy.
//   2. The group approves under its spending rules (approvals.ts): a reply to Nod,
//      "@Nod yes", or a 👍/❤️ tapback on the proposal. Plain "yes" from someone
//      Nod didn't ask is never taken as approval.
//   3. Nod re-checks the time and terms, books, and posts the confirmation with
//      the calendar invite. If the terms changed, it asks again instead.
//   4. The person it's booked under gets a private reminder before free
//      cancellation ends.
// Deposits are charged by the partner or venue, never held by Nod.

import { displayName } from "../agent/context";
import { defineTool, ToolError, type NodTool, type ToolContext } from "../agent/tools";
import { FOLLOWUP_MESSAGES, FOLLOWUP_MINUTES } from "../agent/tools/expect-answer";
import type { Booking, ChatMember, Group, Option, ProposalTerms, Store } from "../db/store";
import type { MessageCall } from "../inbound/pipeline";
import type { BookingJob, Scheduler } from "../jobs/scheduler";
import type { Logger } from "../lib/log";
import { formatLocal, localDateTimeToUtc, toLocalDateTime } from "../lib/time";
import type { InboundReaction, MessagingProvider, Tapback } from "../messaging/types";
import { optionLabel } from "../options/cards";
import { parseTapbackText } from "../voting/votes";
import { approvalRequirement, isApproved, readSpendRules, type ApprovalRequirement } from "./approvals";
import { partnerFor, SlotUnavailableError, type BookingPartner, type Slot } from "./partners";
import { clockTime, createBookingEvent, decisionFor, inviteUrl, money } from "./shared";

export interface ProposalDeps {
  store: Store;
  provider: MessagingProvider;
  scheduler: Scheduler;
  partners: BookingPartner[];
  logger: Logger;
  defaultTimezone: string;
  appUrl?: string;
  now?: () => Date;
}

const HOUR = 3_600_000;
/** A proposal nobody approved within a day is stale; Nod re-checks by proposing again. */
const PROPOSAL_TTL = 24 * HOUR;
/** The private reminder goes out this long before free cancellation ends. */
const REMIND_BEFORE = 3 * HOUR;
/** Tapbacks that approve a proposal (not laugh, dislike or question). */
const APPROVING: ReadonlySet<Tapback> = new Set<Tapback>(["love", "like", "emphasize"]);
const MAX_PARTY = 20;

export function createProposals(deps: ProposalDeps) {
  const { store, provider, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const tzOf = (g: Group | undefined) => g?.timezone ?? deps.defaultTimezone;
  const partnerById = (id: string | null) => deps.partners.find((p) => p.id === id);

  const post = (group: Group, text: string, mediaUrls?: string[]) =>
    provider.send({ groupId: group.providerGroupId }, { text, ...(mediaUrls ? { mediaUrls } : {}) });

  function nameIn(members: ChatMember[], userId: string | null): string {
    const m = members.find((x) => x.userId === userId);
    return m ? displayName(m) : "someone";
  }

  function depositPhrase(cents: number, currency: string, partySize: number): string {
    if (!cents) return "No deposit";
    const each = Math.round(cents / partySize);
    return `${money(cents, currency)} deposit (${money(each, currency)} each)`;
  }

  function cancelPhrase(t: ProposalTerms, tz: string): string {
    const fee = t.cancelFeeCents ? money(t.cancelFeeCents, t.currency) : "";
    if (t.freeCancelUntil) return `Free cancellation until ${formatLocal(new Date(t.freeCancelUntil), tz)}${fee ? `, then ${fee}` : ""}.`;
    return fee ? `Cancelling costs ${fee}.` : "Free to cancel.";
  }

  function approvalAsk(req: ApprovalRequirement, members: ChatMember[], requesterUserId: string | null): string {
    if (req.kind === "one_of") return `${nameIn(members, req.userIds[0]!)}, reply yes or tap 👍 to book it.`;
    if (req.count === 1) return `${nameIn(members, requesterUserId)}, reply yes (or anyone tap 👍) to book it.`;
    return `That's over the per-person limit, so ${req.count} people need to approve: tap 👍 or reply “@Nod yes”.`;
  }

  function waitingFor(req: ApprovalRequirement, approvals: string[], members: ChatMember[]): string {
    if (req.kind === "one_of") return `${req.userIds.map((id) => nameIn(members, id)).join(" or ")}'s approval`;
    const have = new Set(approvals.filter((id) => members.some((m) => m.userId === id))).size;
    const left = Math.max(0, req.count - have);
    return `${left} more approval${left === 1 ? "" : "s"}`;
  }

  function termsFrom(slot: Slot, approval: ApprovalRequirement): ProposalTerms {
    return {
      slotId: slot.id,
      depositCents: slot.depositCents,
      currency: slot.currency,
      freeCancelUntil: slot.freeCancelUntil?.toISOString() ?? null,
      cancelFeeCents: slot.cancelFeeCents,
      policy: slot.policy,
      approval,
    };
  }

  const sameTerms = (t: ProposalTerms, slot: Slot) =>
    t.depositCents === slot.depositCents &&
    t.currency === slot.currency &&
    t.cancelFeeCents === slot.cancelFeeCents &&
    t.freeCancelUntil === (slot.freeCancelUntil?.toISOString() ?? null);

  async function requirementFor(group: Group, slot: Slot, partySize: number, requesterUserId: string, members: ChatMember[]) {
    return approvalRequirement({
      rules: readSpendRules(group.spendRules),
      depositCents: slot.depositCents,
      partySize,
      organizerUserId: group.organizerUserId,
      addedByUserId: group.addedByUserId,
      requesterUserId,
      memberIds: members.map((m) => m.userId),
    });
  }

  /** Posts the exact terms (one line, so SMS tapback text can quote it) and lets the approvers answer without @Nod. */
  async function postProposal(group: Group, booking: Booking, option: Option, partner: BookingPartner, lead = ""): Promise<void> {
    const t = booking.proposal!;
    const tz = tzOf(group);
    const members = await store.groupMembers(group.id);
    const text =
      `${lead}Book ${optionLabel(option)} for ${booking.partySize}, ${formatLocal(booking.startsAt!, tz)}? ` +
      `${depositPhrase(t.depositCents, t.currency, booking.partySize)}${t.depositCents ? `, paid to ${partner.name} directly` : ""}. ` +
      `${cancelPhrase(t, tz)} Under ${nameIn(members, booking.holderUserId)}'s name. ${approvalAsk(t.approval, members, booking.requestedByUserId)}`;
    const sent = await post(group, text);
    await store.updateBooking(booking.id, { proposalMessageId: sent.messageId });

    const asked = new Set<string>(t.approval.kind === "one_of" ? t.approval.userIds : []);
    if (booking.requestedByUserId) asked.add(booking.requestedByUserId);
    for (const userId of asked) {
      if (members.find((m) => m.userId === userId)?.optedOut) continue;
      await store.createPendingQuestion({
        groupId: group.id,
        askedUserId: userId,
        nodProviderMessageId: sent.messageId,
        question: text,
        remaining: FOLLOWUP_MESSAGES,
        expiresAt: new Date(now().getTime() + FOLLOWUP_MINUTES * 60_000),
      });
    }
    logger.info("booking.proposed", { bookingId: booking.id, approval: t.approval.kind });
  }

  async function groupOption(ctx: ToolContext, optionId: string): Promise<{ group: Group; option: Option }> {
    if (ctx.chat.kind !== "group") throw new ToolError("Bookings are made from the group chat.");
    const option = await store.getOption(optionId);
    if (!option || option.groupId !== ctx.chat.groupId) throw new ToolError("That option isn't in this group.");
    if (option.kind === "rental") throw new ToolError("Nod can't book stays itself. Use booking_link with check_in and check_out.");
    return { group: (await store.getGroup(ctx.chat.groupId))!, option };
  }

  function readStart(local: string, tz: string): { startsAt: Date; date: string; time: string } {
    const startsAt = localDateTimeToUtc(local, tz);
    if (!startsAt) throw new ToolError("Give the date and time as starts_at_local, like 2026-10-03T20:00.");
    if (startsAt.getTime() < now().getTime()) throw new ToolError("That time has already passed.");
    const [date, time] = toLocalDateTime(startsAt, tz).split("T") as [string, string];
    return { startsAt, date, time };
  }

  function openTimes(slots: Slot[], partySize: number, tz: string) {
    return slots.slice(0, 4).map((s) => ({
      starts_at_local: toLocalDateTime(s.startsAt, tz),
      time: clockTime(s.startsAt, tz),
      deposit: depositPhrase(s.depositCents, s.currency, partySize),
    }));
  }

  // ---- booking once approved ----

  async function afterApproval(bookingId: string): Promise<"booked" | "handled" | "waiting"> {
    const b = await store.getBooking(bookingId);
    if (!b?.proposal) return "waiting";
    const members = await store.groupMembers(b.groupId);
    const approvals = await store.bookingApprovals(b.id);
    if (!isApproved(b.proposal.approval, approvals, members.map((m) => m.userId))) return "waiting";
    return finalize(b.id);
  }

  /** Books an approved proposal and posts the outcome. Only one caller gets past the status claim. */
  async function finalize(bookingId: string): Promise<"booked" | "handled"> {
    if (!(await store.transitionBooking(bookingId, ["proposed", "failed"], { status: "confirming" }))) return "handled";
    const booking = (await store.getBooking(bookingId))!;
    const group = (await store.getGroup(booking.groupId))!;
    const option = (await store.getOption(booking.optionId))!;
    const tz = tzOf(group);
    const label = optionLabel(option);
    const partner = partnerById(booking.partner);
    const members = await store.groupMembers(group.id);
    const holder = members.find((m) => m.userId === booking.holderUserId);

    const stop = async (status: Booking["status"], text: string) => {
      await store.updateBooking(booking.id, { status });
      await post(group, text);
      logger.info("booking.not_booked", { bookingId: booking.id, status });
      return "handled" as const;
    };

    const venueId = partner ? await partner.venueFor(option) : null;
    if (!partner || !venueId || !holder) return stop("failed", `I couldn't book ${label}, so nothing was booked. Try the booking link instead.`);

    const [date, time] = toLocalDateTime(booking.startsAt!, tz).split("T") as [string, string];
    let slots: Slot[];
    try {
      slots = await partner.availability({ venueId, partySize: booking.partySize, date, time, timezone: tz });
    } catch {
      return stop("failed", `I couldn't reach ${partner.name} to book ${label}. Nothing was booked. Say “@Nod try again” in a bit.`);
    }
    const slot = slots.find((s) => s.startsAt.getTime() === booking.startsAt!.getTime());
    if (!slot) {
      const alts = slots.slice(0, 3).map((s) => clockTime(s.startsAt, tz));
      return stop(
        "expired",
        `${label} no longer has ${clockTime(booking.startsAt!, tz)} for ${booking.partySize}.` +
          (alts.length ? ` Open nearby: ${alts.join(", ")}. Ask me to book one of those.` : " Nothing nearby is open."),
      );
    }
    if (!sameTerms(booking.proposal!, slot)) {
      // Never book on terms the group didn't see (rule 4): show the new ones and start the approval over.
      const approval = await requirementFor(group, slot, booking.partySize, booking.requestedByUserId ?? holder.userId, members);
      await store.clearBookingApprovals(booking.id);
      await store.updateBooking(booking.id, { status: "proposed", proposal: termsFrom(slot, approval), freeCancelUntil: slot.freeCancelUntil });
      await postProposal(group, (await store.getBooking(booking.id))!, option, partner, "The terms changed since I asked. ");
      return "handled";
    }

    let result;
    try {
      result = await partner.book({
        venueId,
        slot,
        partySize: booking.partySize,
        guest: { name: holder.name ?? "Guest", phone: holder.phone },
        idempotencyKey: booking.id,
      });
    } catch (err) {
      if (err instanceof SlotUnavailableError) {
        return stop("expired", `Someone just took ${clockTime(slot.startsAt, tz)} at ${label}. Nothing was booked. Ask me for another time.`);
      }
      logger.error("booking.partner_failed", { bookingId: booking.id, partner: partner.id, error: (err as Error).name });
      return stop("failed", `I couldn't confirm ${label} with ${partner.name}. Say “@Nod try again” and I'll retry without double-booking.`);
    }

    const confirmation: Record<string, unknown> = {
      code: result.confirmationCode,
      ...(result.manageUrl ? { manageUrl: result.manageUrl } : {}),
      ...(slot.depositCents
        ? { depositCents: slot.depositCents, depositCurrency: slot.currency, depositPaidByUserId: holder.userId }
        : {}),
    };
    await store.updateBooking(booking.id, {
      status: "booked",
      partnerBookingId: result.partnerBookingId,
      bookedByUserId: holder.userId,
      confirmation,
    });
    if (booking.decisionId) await store.updateDecision(booking.decisionId, { status: "booked" });
    const event = await createBookingEvent(store, (await store.getBooking(booking.id))!, option, `Nod, for ${displayName(holder)}`);

    const t = booking.proposal!;
    const who = displayName(holder);
    const depositNote = !slot.depositCents
      ? ""
      : result.depositPayUrl
        ? ` ${who}, I sent you the ${money(slot.depositCents, slot.currency)} deposit link privately.`
        : ` ${money(slot.depositCents, slot.currency)} deposit paid to ${partner.name}.`;
    const cancelNote = t.freeCancelUntil && t.cancelFeeCents ? ` Free cancellation until ${formatLocal(new Date(t.freeCancelUntil), tz)}.` : "";
    await post(
      group,
      `Booked: ${label} for ${booking.partySize}, ${formatLocal(booking.startsAt!, tz)}, under ${who}'s name. ` +
        `Confirmation ${result.confirmationCode}.${depositNote}${cancelNote} Calendar invite attached.`,
      [inviteUrl(deps.appUrl, event.id)],
    );
    if (result.depositPayUrl) {
      await provider.send(
        { phone: holder.phone },
        { text: `To hold ${label} (${formatLocal(booking.startsAt!, tz)}), pay the ${money(slot.depositCents, slot.currency)} deposit to ${partner.name} here: ${result.depositPayUrl}` },
      );
    }
    await scheduleReminder(booking.id, t);
    logger.info("booking.booked", { bookingId: booking.id, partner: partner.id, eventId: event.id });
    return "booked";
  }

  async function scheduleReminder(bookingId: string, t: ProposalTerms): Promise<void> {
    if (!t.freeCancelUntil || !t.cancelFeeCents) return;
    const runAt = new Date(new Date(t.freeCancelUntil).getTime() - REMIND_BEFORE);
    if (runAt.getTime() < now().getTime() + 10 * 60_000) return; // closes too soon to be worth a reminder
    try {
      await deps.scheduler.scheduleBookingReminder({ bookingId, runAt });
    } catch (err) {
      logger.error("booking.reminder_not_scheduled", { bookingId, error: (err as Error).name });
    }
  }

  /** The private "free cancellation ends soon" reminder. Safe to repeat. */
  async function runJob(job: BookingJob): Promise<void> {
    const b = await store.getBooking(job.bookingId);
    const t = b?.proposal;
    if (!b || b.status !== "booked" || !t?.freeCancelUntil || !t.cancelFeeCents || !b.holderUserId) return;
    if (new Date(t.freeCancelUntil).getTime() <= now().getTime()) return;
    const holder = await store.getUser(b.holderUserId);
    if (!holder || !(await store.claimBookingReminder(b.id))) return;
    const group = await store.getGroup(b.groupId);
    const option = await store.getOption(b.optionId);
    const tz = tzOf(group);
    const label = option ? optionLabel(option) : "your booking";
    await provider.send(
      { phone: holder.phone },
      {
        text:
          `Free cancellation for ${label} (${formatLocal(b.startsAt!, tz)}, ${b.partySize} people) ends ${formatLocal(new Date(t.freeCancelUntil), tz)}. ` +
          `After that, cancelling costs ${money(t.cancelFeeCents, t.currency)}. If plans change, say “@Nod cancel ${label}” in ${group?.name ?? "the group"}.`,
      },
    );
    logger.info("booking.reminder_sent", { bookingId: b.id });
  }

  // ---- approvals from tapbacks ----

  async function tapback(groupId: string, userId: string, messageId: string, reaction: Tapback, removed: boolean): Promise<void> {
    const b = await store.bookingByProposalMessage(groupId, messageId);
    if (!b || b.status !== "proposed" || !APPROVING.has(reaction)) return;
    if (!(await store.groupMembers(groupId)).some((m) => m.userId === userId)) return;
    if (removed) {
      await store.removeBookingApproval(b.id, userId);
      return;
    }
    if (b.createdAt.getTime() < now().getTime() - PROPOSAL_TTL) return;
    await store.addBookingApproval(b.id, userId);
    logger.info("booking.approved", { bookingId: b.id, via: "tapback" });
    await afterApproval(b.id);
  }

  /** A tapback on Nod's proposal message counts as that person's approval. */
  async function onReaction(call: { event: InboundReaction; groupId: string; userId: string }): Promise<void> {
    await tapback(call.groupId, call.userId, call.event.targetMessageId, call.event.reaction, call.event.removed);
  }

  /** The same for SMS tapback text (`Liked “Book Hartwood…”`). */
  async function captureTapback(call: MessageCall): Promise<void> {
    if (!call.groupId) return;
    const parsed = parseTapbackText(call.event.text);
    if (!parsed) return;
    const messageId = await store.findMessageIdByText(call.groupId, parsed.quoted);
    if (messageId) await tapback(call.groupId, call.senderUserId, messageId, parsed.reaction, parsed.removed);
  }

  // ---- tools ----

  const timeProps = {
    option_id: { type: "string" as const },
    party_size: { type: "integer" as const, minimum: 1, maximum: MAX_PARTY },
    starts_at_local: { type: "string" as const, description: "Local date-time in this chat's timezone, e.g. 2026-10-03T20:00." },
  };

  const checkAvailability = defineTool<{ option_id: string; party_size: number; starts_at_local: string }>({
    name: "check_availability",
    description:
      "See which times a restaurant or activity has open near a requested time, when someone asks what's available. " +
      "Only works for venues Nod can book itself; otherwise it says to use booking_link.",
    inputSchema: { type: "object", properties: timeProps, required: ["option_id", "party_size", "starts_at_local"], additionalProperties: false },
    async run(input, ctx) {
      const { group, option } = await groupOption(ctx, input.option_id);
      const match = await partnerFor(deps.partners, option);
      if (!match) return { nod_can_book: false, note: "Nod can't book this venue itself yet. Use booking_link instead." };
      const tz = tzOf(group);
      const { startsAt, date, time } = readStart(input.starts_at_local, tz);
      const slots = await match.partner.availability({ venueId: match.venueId, partySize: input.party_size, date, time, timezone: tz });
      return {
        nod_can_book: true,
        via: match.partner.name,
        requested_time_open: slots.some((s) => s.startsAt.getTime() === startsAt.getTime()),
        open_times: openTimes(slots, input.party_size, tz),
      };
    },
  });

  const proposeBooking = defineTool<{ option_id: string; party_size: number; starts_at_local: string }>({
    name: "propose_booking",
    description:
      "Book a restaurant or activity for the group. Use this first whenever someone asks you to book one. If Nod can book the venue " +
      "itself, this checks the exact time and posts the terms (deposit, cancellation policy) for the group to approve; Nod books it " +
      "once approved and posts the confirmation. If that time isn't open, it returns nearby times to offer instead. If Nod can't book " +
      "the venue, it says so; then use booking_link. Needs the party size and a local start time; ask if either is unclear.",
    inputSchema: { type: "object", properties: timeProps, required: ["option_id", "party_size", "starts_at_local"], additionalProperties: false },
    async run(input, ctx) {
      const { group, option } = await groupOption(ctx, input.option_id);
      const match = await partnerFor(deps.partners, option);
      if (!match) return { nod_can_book: false, note: "Nod can't book this venue itself yet. Use booking_link instead." };
      const tz = tzOf(group);
      const { startsAt, date, time } = readStart(input.starts_at_local, tz);
      const slots = await match.partner.availability({ venueId: match.venueId, partySize: input.party_size, date, time, timezone: tz });
      const slot = slots.find((s) => s.startsAt.getTime() === startsAt.getTime());
      if (!slot) {
        return {
          posted: false,
          requested_time_open: false,
          open_times: openTimes(slots, input.party_size, tz),
          note: slots.length
            ? "That time isn't open. Offer these times in one short message and ask which one."
            : "Nothing is open within 90 minutes of that time. Say so and ask about another time or day.",
        };
      }

      const open = await store.openProposal(group.id);
      if (open) await store.transitionBooking(open.id, ["proposed"], { status: "expired" });
      const approval = await requirementFor(group, slot, input.party_size, ctx.caller.userId, ctx.members);
      const booking = await store.createBooking({
        groupId: group.id,
        optionId: option.id,
        decisionId: await decisionFor(store, option),
        requestedByUserId: ctx.caller.userId,
        partySize: input.party_size,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        allDay: false,
        link: null,
        method: "partner",
        status: "proposed",
        partner: match.partner.id,
        holderUserId: ctx.caller.userId,
        proposal: termsFrom(slot, approval),
        freeCancelUntil: slot.freeCancelUntil,
      });
      await postProposal(group, booking, option, match.partner);
      return "The booking terms are posted for the group to approve. Nothing is booked yet. End your turn without writing anything.";
    },
  });

  async function proposalFor(ctx: ToolContext, bookingId: string | undefined, statuses: Booking["status"][]): Promise<Booking> {
    if (ctx.chat.kind !== "group") throw new ToolError("Bookings are approved in the group chat.");
    const b = bookingId ? await store.getBooking(bookingId) : await store.openProposal(ctx.chat.groupId);
    if (!b || b.groupId !== ctx.chat.groupId || !statuses.includes(b.status)) throw new ToolError("There's no booking waiting for approval.");
    return b;
  }

  const approveBooking = defineTool<{ booking_id?: string }>({
    name: "approve_booking",
    description:
      "Record the caller's approval of the booking Nod proposed, when they say yes to it (a reply to the proposal, '@Nod yes', 'book it'). " +
      "Nod books it as soon as the group's spending rules are met and posts the confirmation itself. Also retries a booking that failed " +
      "(pass its booking_id) when someone says to try again. Only for the caller's own approval.",
    inputSchema: { type: "object", properties: { booking_id: { type: "string" } }, required: [], additionalProperties: false },
    async run(input, ctx) {
      const b = await proposalFor(ctx, input.booking_id, ["proposed", "failed"]);
      if (b.status === "proposed" && b.createdAt.getTime() < now().getTime() - PROPOSAL_TTL) {
        await store.transitionBooking(b.id, ["proposed"], { status: "expired" });
        throw new ToolError("That proposal is over a day old. Propose the booking again so Nod re-checks the time.");
      }
      await store.addBookingApproval(b.id, ctx.caller.userId);
      logger.info("booking.approved", { bookingId: b.id, via: "tool" });
      const outcome = await afterApproval(b.id);
      if (outcome !== "waiting") return "Nod posted the result of the booking. End your turn without writing anything.";
      const members = await store.groupMembers(b.groupId);
      return `Recorded ${ctx.caller.name}'s approval. Not booked yet: still waiting on ${waitingFor(b.proposal!.approval, await store.bookingApprovals(b.id), members)}. Say so in a few words.`;
    },
  });

  const declineBooking = defineTool<{ booking_id?: string }>({
    name: "decline_booking",
    description: "Call off the booking Nod proposed when someone in the group says not to book it. Then confirm in a few words.",
    inputSchema: { type: "object", properties: { booking_id: { type: "string" } }, required: [], additionalProperties: false },
    async run(input, ctx) {
      const b = await proposalFor(ctx, input.booking_id, ["proposed", "failed"]);
      await store.transitionBooking(b.id, ["proposed", "failed"], { status: "declined" });
      const option = await store.getOption(b.optionId);
      logger.info("booking.declined", { bookingId: b.id });
      return `Called off the ${option ? optionLabel(option) : ""} booking. Nothing was booked.`;
    },
  });

  /** Cancels a partner booking with the venue. A fee after the free window needs explicit approval (rule 4). */
  async function cancelWithPartner(b: Booking, ctx: ToolContext, confirmFee: boolean): Promise<string | Record<string, unknown>> {
    const partner = partnerById(b.partner);
    const option = (await store.getOption(b.optionId))!;
    const label = optionLabel(option);
    const t = b.proposal;
    if (!partner || !t || !b.partnerBookingId) throw new ToolError(`Nod can't reach the service ${label} was booked through.`);
    const free = t.freeCancelUntil && now().getTime() < new Date(t.freeCancelUntil).getTime();
    const fee = free ? 0 : t.cancelFeeCents;
    if (fee) {
      const members = await store.groupMembers(b.groupId);
      const allowed = new Set([b.holderUserId, ...(t.approval.kind === "one_of" ? t.approval.userIds : [])].filter(Boolean) as string[]);
      const names = [...allowed].map((id) => nameIn(members, id)).join(" or ");
      if (!confirmFee) {
        return {
          cancelled: false,
          fee: money(fee, t.currency),
          note: `Cancelling now costs ${money(fee, t.currency)}, charged by ${partner.name}. Tell the group, and cancel only once ${names} confirms; then call cancel_booking again with confirm_fee true.`,
        };
      }
      if (!allowed.has(ctx.caller.userId)) throw new ToolError(`Only ${names} can approve the ${money(fee, t.currency)} cancellation fee.`);
    }
    const venueId = await partner.venueFor(option);
    let charged: number;
    try {
      ({ feeCents: charged } = await partner.cancel({ venueId: venueId ?? "", partnerBookingId: b.partnerBookingId, idempotencyKey: `${b.id}:cancel` }));
    } catch {
      throw new ToolError(`Couldn't reach ${partner.name} to cancel. ${label} is still booked; try again in a bit.`);
    }
    await store.updateBooking(b.id, { status: "cancelled", confirmation: { ...b.confirmation, ...(charged ? { cancelFeeCents: charged } : {}) } });
    logger.info("booking.cancelled", { bookingId: b.id, partner: partner.id });
    return `Cancelled ${label} with ${partner.name}. ${charged ? `${partner.name} charged a ${money(charged, t.currency)} cancellation fee.` : "No fee."}`;
  }

  /** How a partner booking reads in Claude's context. Null for hand-off bookings. */
  async function statusLine(b: Booking, tz: string): Promise<string | null> {
    if (b.method !== "partner" || !b.proposal) return null;
    const t = b.proposal;
    const partner = partnerById(b.partner)?.name ?? "a booking partner";
    const terms = `${depositPhrase(t.depositCents, t.currency, b.partySize).toLowerCase()}; ${cancelPhrase(t, tz).toLowerCase()}`;
    switch (b.status) {
      case "proposed": {
        const members = await store.groupMembers(b.groupId);
        const approvals = await store.bookingApprovals(b.id);
        const by = approvals.length ? ` Approved so far: ${approvals.map((id) => nameIn(members, id)).join(", ")}.` : "";
        return `proposed by Nod, not booked (${terms}). Waiting on ${waitingFor(t.approval, approvals, members)}.${by}`;
      }
      case "confirming":
        return `approved; Nod is booking it with ${partner} now`;
      case "failed":
        return `Nod's booking attempt failed; approve_booking with this booking_id retries it`;
      case "booked":
        return `booked by Nod through ${partner}${typeof b.confirmation.code === "string" ? ` (confirmation ${b.confirmation.code})` : ""}; ${terms}`;
      default:
        return b.status === "cancelled" ? "cancelled" : `${b.status}, not booked`;
    }
  }

  const tools: NodTool<any>[] = deps.partners.length ? [checkAvailability, proposeBooking, approveBooking, declineBooking] : [];
  return { tools, onReaction, captureTapback, runJob, cancelWithPartner, statusLine, finalize };
}

export type Proposals = ReturnType<typeof createProposals>;
