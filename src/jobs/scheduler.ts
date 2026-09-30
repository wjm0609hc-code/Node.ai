// Delayed jobs: a vote's nudge and deadline, and the private reminder before a
// booking's free cancellation ends. Production uses Inngest (durable functions
// that sleep until each time); tests and the simulators use MemoryScheduler.
// Every job re-checks its vote or booking when it runs, so nothing acts twice.

export type VotingJob = { type: "nudge"; decisionId: string } | { type: "deadline"; decisionId: string; deadlineAt: string };
export type BookingJob = { type: "cancel_reminder"; bookingId: string };
export type NodJob = VotingJob | BookingJob;

export interface VoteTimeline {
  decisionId: string;
  deadlineAt: Date;
  nudgeAt?: Date;
}

export interface Scheduler {
  scheduleVote(timeline: VoteTimeline): Promise<void>;
  scheduleBookingReminder(r: { bookingId: string; runAt: Date }): Promise<void>;
}

export type RunJob = (job: NodJob) => Promise<void>;

function jobsFor(t: VoteTimeline): Array<{ runAt: Date; job: NodJob }> {
  return [
    ...(t.nudgeAt ? [{ runAt: t.nudgeAt, job: { type: "nudge" as const, decisionId: t.decisionId } }] : []),
    { runAt: t.deadlineAt, job: { type: "deadline" as const, decisionId: t.decisionId, deadlineAt: t.deadlineAt.toISOString() } },
  ];
}

/** Keeps jobs in memory; `runDue` runs everything due by a given time (tests, simulators). */
export class MemoryScheduler implements Scheduler {
  private jobs: Array<{ runAt: Date; job: NodJob }> = [];

  async scheduleVote(timeline: VoteTimeline): Promise<void> {
    this.add(jobsFor(timeline));
  }

  async scheduleBookingReminder(r: { bookingId: string; runAt: Date }): Promise<void> {
    this.add([{ runAt: r.runAt, job: { type: "cancel_reminder", bookingId: r.bookingId } }]);
  }

  private add(jobs: Array<{ runAt: Date; job: NodJob }>): void {
    this.jobs.push(...jobs);
    this.jobs.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
  }

  pending(): Array<{ runAt: Date; job: NodJob }> {
    return this.jobs.map((j) => ({ ...j }));
  }

  /** The next time something is due, if anything is scheduled. */
  nextRunAt(): Date | undefined {
    return this.jobs[0]?.runAt;
  }

  async runDue(now: Date, run: RunJob): Promise<void> {
    // Jobs scheduled while running (a runoff) are picked up too, if already due.
    for (;;) {
      const i = this.jobs.findIndex((j) => j.runAt.getTime() <= now.getTime());
      if (i < 0) return;
      const [due] = this.jobs.splice(i, 1);
      await run(due!.job);
    }
  }
}

/** Sends one Inngest event per vote; the `vote-timeline` function does the waiting. */
export class InngestScheduler implements Scheduler {
  constructor(private readonly client: { send(payload: { name: string; data: Record<string, unknown> }): Promise<unknown> }) {}

  async scheduleVote(t: VoteTimeline): Promise<void> {
    await this.client.send({
      name: "nod/vote.scheduled",
      data: { decisionId: t.decisionId, deadlineAt: t.deadlineAt.toISOString(), ...(t.nudgeAt ? { nudgeAt: t.nudgeAt.toISOString() } : {}) },
    });
  }

  async scheduleBookingReminder(r: { bookingId: string; runAt: Date }): Promise<void> {
    await this.client.send({ name: "nod/booking.reminder", data: { bookingId: r.bookingId, runAt: r.runAt.toISOString() } });
  }
}

interface StepTools {
  sleepUntil(id: string, time: string): Promise<void>;
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/** The body of the Inngest function, kept here so it can be tested without Inngest. */
export async function runVoteTimeline(
  data: { decisionId: string; deadlineAt: string; nudgeAt?: string },
  step: StepTools,
  runJob: RunJob,
): Promise<void> {
  if (data.nudgeAt) {
    await step.sleepUntil("wait-for-nudge", data.nudgeAt);
    await step.run("nudge", () => runJob({ type: "nudge", decisionId: data.decisionId }));
  }
  await step.sleepUntil("wait-for-deadline", data.deadlineAt);
  await step.run("close", () => runJob({ type: "deadline", decisionId: data.decisionId, deadlineAt: data.deadlineAt }));
}

/** The body of the booking reminder function: sleep, then send (the job re-checks the booking). */
export async function runBookingReminder(data: { bookingId: string; runAt: string }, step: StepTools, runJob: RunJob): Promise<void> {
  await step.sleepUntil("wait-for-reminder", data.runAt);
  await step.run("remind", () => runJob({ type: "cancel_reminder", bookingId: data.bookingId }));
}

/** For setups that never schedule (e.g. tests that don't vote). */
export const noScheduler: Scheduler = {
  async scheduleVote() {
    throw new Error("scheduling isn't set up here");
  },
  async scheduleBookingReminder() {
    throw new Error("scheduling isn't set up here");
  },
};
