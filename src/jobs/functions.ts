// Inngest functions, served at /api/inngest.
import { getContainer } from "../server/container";
import { inngest } from "./client";
import { runBookingReminder, runCollectionTimeline, runEventReminder, runVoteTimeline } from "./scheduler";
import { REPLY_ATTEMPTS, REPLY_EVENT, runReplyJob, type ReplyEventData } from "./reply";

/** Answers a call with retries; one chat at a time so replies stay in order. */
export const reply = inngest.createFunction(
  {
    id: "reply",
    name: "Reply to a call",
    triggers: [{ event: REPLY_EVENT }],
    retries: 3, // REPLY_ATTEMPTS - 1
    concurrency: [{ key: "event.data.chatKey", limit: 1 }],
  },
  async ({ event, attempt, maxAttempts }) => {
    const { nod } = await getContainer();
    await runReplyJob(event.data as ReplyEventData, { attempt, maxAttempts }, nod.handleAddressed);
  },
);

export const voteTimeline = inngest.createFunction(
  { id: "vote-timeline", name: "Vote nudge and deadline", triggers: [{ event: "nod/vote.scheduled" }], retries: 3 },
  async ({ event, step }) => {
    const { nod } = await getContainer();
    await runVoteTimeline(event.data as { decisionId: string; deadlineAt: string; nudgeAt?: string }, step as never, nod.runJob);
  },
);

export const bookingReminder = inngest.createFunction(
  { id: "booking-reminder", name: "Free cancellation reminder", triggers: [{ event: "nod/booking.reminder" }], retries: 3 },
  async ({ event, step }) => {
    const { nod } = await getContainer();
    await runBookingReminder(event.data as { bookingId: string; runAt: string }, step as never, nod.runJob);
  },
);

export const collectionTimeline = inngest.createFunction(
  { id: "collection-timeline", name: "Payment reminder and deadline", triggers: [{ event: "nod/collection.scheduled" }], retries: 3 },
  async ({ event, step }) => {
    const { nod } = await getContainer();
    await runCollectionTimeline(event.data as { collectionId: string; deadlineAt: string; reminderAt?: string }, step as never, nod.runJob);
  },
);

export const eventReminder = inngest.createFunction(
  { id: "event-reminder", name: "Day-of event reminder", triggers: [{ event: "nod/event.reminder" }], retries: 3 },
  async ({ event, step }) => {
    const { nod } = await getContainer();
    await runEventReminder(event.data as { eventId: string; runAt: string }, step as never, nod.runJob);
  },
);

/** Daily, late morning in New York: post-trip invite codes for trips that ended. Each member is marked as sent, so a retry only texts whoever was missed. */
export const tripWrap = inngest.createFunction(
  { id: "trip-wrap", name: "Post-trip invite codes", triggers: [{ cron: "TZ=America/New_York 47 10 * * *" }], retries: 2, concurrency: [{ limit: 1 }] },
  async () => {
    const { nod } = await getContainer();
    return { sent: await nod.invites.sweepTrips() };
  },
);

export const functions = [reply, voteTimeline, bookingReminder, collectionTimeline, eventReminder, tripWrap];
