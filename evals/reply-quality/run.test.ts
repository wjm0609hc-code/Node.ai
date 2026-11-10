// Free wiring test for the runner: scripted Claude replies instead of real ones, so this checks
// the harness (recording, what Nod sent, checks, grading) without spending anything.
import { describe, expect, it, vi } from "vitest";
import { CASES } from "./cases";
import { runCase } from "./run";

type Block = Record<string, unknown>;
const reply = (content: Block[], stop_reason = "end_turn") => ({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason, content, usage: { input_tokens: 100, output_tokens: 20 } });
function scripted(...responses: Array<ReturnType<typeof reply>>) {
  const create = vi.fn(async () => responses.shift() ?? reply([{ type: "text", text: "ok" }]));
  return { beta: { messages: { create } } } as any;
}
const byId = (id: string) => CASES.find((c) => c.id === id)!;
const judge = vi.fn(async () => ({ scores: { did_the_job: true, no_needless_question: true, brief_and_natural: true, honest: true }, explanation: "", model: "claude-sonnet-5-5", usage: { input_tokens: 50, output_tokens: 10 } as any }));

describe("the reply-quality runner", () => {
  it("plays a case through the real app and grades what Nod did", async () => {
    const anthropic = scripted(
      reply([{ type: "tool_use", id: "t1", name: "search_web", input: { query: "dinner", location: "West Village", party_size: 5, date: "2026-11-14", time: "19:00" } }], "tool_use"),
      reply([{ type: "tool_use", id: "t2", name: "show_options", input: { option_ids: [] } }], "tool_use"),
      reply([{ type: "text", text: "Dinner Saturday, West Village:" }]),
    );
    const { row, trace } = await runCase(byId("search-dinner"), 0, judge as any, { anthropic, classify: async () => false, classifyAnswer: async () => false });
    expect(row.grade.rules).toBe(1);
    expect(row).toMatchObject({ prompt_id: "search-dinner", status: "ok", model: "claude-opus-5-5", tool_calls: 2 });
    expect(row.usage.input_tokens).toBe(300);
    expect(trace.map((t: any) => t.role)).toEqual(["system", "user", "tool_call", "tool_call", "tool_result", "tool_result", "assistant"]);
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ message: "Sarah: @Nod dinner for 5 Saturday at 7pm in the West Village?", good: expect.stringContaining("party size 5") }));
  });

  it("fails a case where Nod talks when it should stay quiet, or skips an action", async () => {
    const quiet = await runCase(byId("silent-could-help"), 0, judge as any, { anthropic: scripted(), classify: async () => false, classifyAnswer: async () => false });
    expect(quiet.row.grade).toMatchObject({ pass: true, rules: 1 });

    const lazy = await runCase(byId("receipt-split"), 0, undefined, { anthropic: scripted(reply([{ type: "text", text: "Who paid, and should I split it evenly?" }])), classify: async () => false, classifyAnswer: async () => false });
    expect(lazy.row.grade.pass).toBe(false);
    expect(lazy.row.explanation.pass).toContain("calls_split_receipt");
  });

  it("starts the past-dinner case with the booking in the group's history", async () => {
    let seen = "";
    const anthropic = { beta: { messages: { create: vi.fn(async (body: any) => { seen = body.messages[0].content; return reply([{ type: "text", text: "Lupa." }]); }) } } } as any;
    await runCase(byId("memory-last-time"), 0, undefined, { anthropic, classify: async () => false, classifyAnswer: async () => false });
    expect(seen).toContain("Booked Lupa (West Village) for 5");
  });
});
