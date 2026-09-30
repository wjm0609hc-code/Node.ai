import { describe, expect, it, vi } from "vitest";
import { InngestScheduler, MemoryScheduler, runBookingReminder, runCollectionTimeline, runVoteTimeline } from "./scheduler";

describe("MemoryScheduler", () => {
  it("runs due jobs in time order, once", async () => {
    const s = new MemoryScheduler();
    await s.scheduleVote({ decisionId: "d1", deadlineAt: new Date("2026-01-02T00:00:00Z"), nudgeAt: new Date("2026-01-01T21:00:00Z") });
    const ran: string[] = [];
    const run = async (job: any) => {
      ran.push(job.type);
    };
    await s.runDue(new Date("2026-01-01T22:00:00Z"), run);
    expect(ran).toEqual(["nudge"]);
    await s.runDue(new Date("2026-01-03T00:00:00Z"), run);
    expect(ran).toEqual(["nudge", "deadline"]);
    expect(s.pending()).toEqual([]);
  });

  it("keeps booking reminders in the same queue", async () => {
    const s = new MemoryScheduler();
    await s.scheduleVote({ decisionId: "d1", deadlineAt: new Date("2026-01-02T00:00:00Z") });
    await s.scheduleBookingReminder({ bookingId: "b1", runAt: new Date("2026-01-01T12:00:00Z") });
    expect(s.pending().map((j) => j.job)).toEqual([
      { type: "cancel_reminder", bookingId: "b1" },
      { type: "deadline", decisionId: "d1", deadlineAt: "2026-01-02T00:00:00.000Z" },
    ]);
  });
});

describe("InngestScheduler", () => {
  it("sends one event per vote timeline", async () => {
    const send = vi.fn(async () => ({ ids: ["e1"] }));
    await new InngestScheduler({ send } as never).scheduleVote({ decisionId: "d1", deadlineAt: new Date("2026-01-02T00:00:00Z") });
    expect(send).toHaveBeenCalledWith({
      name: "nod/vote.scheduled",
      data: { decisionId: "d1", deadlineAt: "2026-01-02T00:00:00.000Z" },
    });
  });

  it("sends a booking reminder event, and its function sleeps then runs the job", async () => {
    const send = vi.fn(async () => ({}));
    await new InngestScheduler({ send } as never).scheduleBookingReminder({ bookingId: "b1", runAt: new Date("2026-01-01T12:00:00Z") });
    expect(send).toHaveBeenCalledWith({ name: "nod/booking.reminder", data: { bookingId: "b1", runAt: "2026-01-01T12:00:00.000Z" } });

    const calls: string[] = [];
    const step = {
      sleepUntil: vi.fn(async (id: string, t: string) => void calls.push(`sleep:${id}:${t}`)),
      run: vi.fn(async (id: string, fn: () => Promise<unknown>) => (calls.push(`run:${id}`), fn())),
    };
    const runJob = vi.fn(async () => {});
    await runBookingReminder({ bookingId: "b1", runAt: "2026-01-01T12:00:00.000Z" }, step as never, runJob);
    expect(calls).toEqual(["sleep:wait-for-reminder:2026-01-01T12:00:00.000Z", "run:remind"]);
    expect(runJob).toHaveBeenCalledWith({ type: "cancel_reminder", bookingId: "b1" });
  });

  it("the Inngest function sleeps to each time and runs the jobs as steps", async () => {
    const calls: string[] = [];
    const step = {
      sleepUntil: vi.fn(async (id: string, t: string) => {
        calls.push(`sleep:${id}:${t}`);
      }),
      run: vi.fn(async (id: string, fn: () => Promise<unknown>) => {
        calls.push(`run:${id}`);
        return fn();
      }),
    };
    const runJob = vi.fn(async () => {});
    await runVoteTimeline(
      { decisionId: "d1", deadlineAt: "2026-01-02T00:00:00.000Z", nudgeAt: "2026-01-01T21:00:00.000Z" },
      step as never,
      runJob,
    );
    expect(calls).toEqual([
      "sleep:wait-for-nudge:2026-01-01T21:00:00.000Z",
      "run:nudge",
      "sleep:wait-for-deadline:2026-01-02T00:00:00.000Z",
      "run:close",
    ]);
    expect(runJob).toHaveBeenNthCalledWith(1, { type: "nudge", decisionId: "d1" });
    expect(runJob).toHaveBeenNthCalledWith(2, { type: "deadline", decisionId: "d1", deadlineAt: "2026-01-02T00:00:00.000Z" });
  });

  it("sends a collection timeline and runs the reminder, then the deadline", async () => {
    const send = vi.fn(async () => ({}));
    await new InngestScheduler({ send } as never).scheduleCollection({
      collectionId: "c1", deadlineAt: new Date("2026-01-03T00:00:00Z"), reminderAt: new Date("2026-01-02T00:00:00Z"),
    });
    expect(send).toHaveBeenCalledWith({
      name: "nod/collection.scheduled",
      data: { collectionId: "c1", deadlineAt: "2026-01-03T00:00:00.000Z", reminderAt: "2026-01-02T00:00:00.000Z" },
    });
    const calls: string[] = [];
    const step = {
      sleepUntil: vi.fn(async (id: string) => void calls.push(`sleep:${id}`)),
      run: vi.fn(async (id: string, fn: () => Promise<unknown>) => (calls.push(`run:${id}`), fn())),
    };
    const runJob = vi.fn(async () => {});
    await runCollectionTimeline({ collectionId: "c1", deadlineAt: "2026-01-03T00:00:00.000Z", reminderAt: "2026-01-02T00:00:00.000Z" }, step as never, runJob);
    expect(calls).toEqual(["sleep:wait-for-reminder", "run:remind", "sleep:wait-for-deadline", "run:deadline"]);
    expect(runJob).toHaveBeenLastCalledWith({ type: "collection_deadline", collectionId: "c1", deadlineAt: "2026-01-03T00:00:00.000Z" });
  });
});
