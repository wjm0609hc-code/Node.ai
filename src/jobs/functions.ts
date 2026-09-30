// Inngest functions, served at /api/inngest.
import { getContainer } from "../server/container";
import { inngest } from "./client";
import { runBookingReminder, runVoteTimeline } from "./scheduler";

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

export const functions = [voteTimeline, bookingReminder];
