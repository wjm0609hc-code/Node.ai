import { describe, expect, it, vi } from "vitest";
import { InngestScheduler, MemoryScheduler, runVoteTimeline } from "./scheduler";

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
});
