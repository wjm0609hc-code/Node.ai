// Inngest functions, served at /api/inngest.
import { getContainer } from "../server/container";
import { inngest } from "./client";
import { runVoteTimeline } from "./scheduler";

export const voteTimeline = inngest.createFunction(
  { id: "vote-timeline", name: "Vote nudge and deadline", triggers: [{ event: "nod/vote.scheduled" }], retries: 3 },
  async ({ event, step }) => {
    const { nod } = await getContainer();
    await runVoteTimeline(event.data as { decisionId: string; deadlineAt: string; nudgeAt?: string }, step as never, nod.voting.runJob);
  },
);

export const functions = [voteTimeline];
