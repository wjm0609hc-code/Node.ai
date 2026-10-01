import { describe, expect, it, vi } from "vitest";
import { createResponder, SNAG_MESSAGE, type AgentClient } from "../agent/responder";
import { defineTool } from "../agent/tools";
import { MemoryStore } from "../db/memory-store";
import type { AddressedCall } from "../inbound/pipeline";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import type { Destination, MessagingProvider, OutboundContent } from "../messaging/types";
import { createNod } from "../nod";
import { REPLY_EVENT, replyEvent, reviveCall, runReplyJob, type ReplyEventData } from "./reply";

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });

/** A fake Claude: queued responses or errors. */
function fakeClaude(...responses: Array<ReturnType<typeof reply> | Error>) {
  const create = vi.fn(async (_body: any) => {
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { beta: { messages: { create } } } as unknown as AgentClient, create };
}

/** Counts real runs, so a test can tell whether a retry repeated it. */
function countingTool(name: string) {
  const runs = vi.fn();
  const tool = defineTool<Record<string, never>>({
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_input, ctx) {
      runs();
      await ctx.provider.send({ phone: ctx.caller.phone }, { text: `${name} ran` });
      return `${name} done`;
    },
  });
  return { tool, runs };
}

/** Wraps the simulator provider so the next N sends of matching text fail. */
function flakyProvider(inner: MessagingProvider) {
  let failNext = 0;
  let match = "";
  const provider: MessagingProvider = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
    send: async (to: Destination, content: OutboundContent) => {
      if (failNext > 0 && content.text?.includes(match)) {
        failNext--;
        throw new Error("sendblue timeout");
      }
      return inner.send(to, content);
    },
  });
  return { provider, failSends: (n: number, containing: string) => ((failNext = n), (match = containing)) };
}

async function setup(claude: ReturnType<typeof fakeClaude>, tools: any[] = []) {
  const world = new ChatWorld();
  const store = new MemoryStore();
  const flaky = flakyProvider(world.provider());
  const nod = createNod({
    store,
    provider: flaky.provider,
    classify: async () => false,
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4" },
    makeResponder: (env) => createResponder({ ...env, client: claude.client, tools }),
  });
  const queued: Array<{ name: string; data: ReplyEventData }> = [];
  world.provider().onInbound((e) =>
    nod.handle(e, { enqueue: async (call) => void queued.push(replyEvent(call)) }).then(() => {}),
  );
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id);
  await world.settled();
  const ask = async (message: string) => {
    world.say(s.users.will.id, s.groupId, message, { mentionNod: true });
    await world.settled();
    return queued.at(-1)!;
  };
  /** Runs the queued job like Inngest would: attempt 0, 1, … until it succeeds or runs out. */
  const runJob = async (job: { data: ReplyEventData }, maxAttempts = 4) => {
    const errors: Error[] = [];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await runReplyJob(job.data, { attempt, maxAttempts }, nod.handleAddressed);
        return errors;
      } catch (err) {
        errors.push(err as Error);
      }
    }
    return errors;
  };
  const groupNod = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1).map((l) => l.text);
  const willDms = () => world.dmTranscript(s.users.will.id).filter((l) => l.from === "nod").map((l) => l.text);
  return { world, store, nod, s, ask, runJob, groupNod, willDms, flaky, queued };
}

describe("reply jobs", () => {
  it("queues the call instead of answering in the webhook, and the job answers it", async () => {
    const claude = fakeClaude(reply([text("Pool one is cheaper.")]));
    const ctx = await setup(claude);
    const job = await ctx.ask("@Nod which is cheaper?");
    expect(job.name).toBe(REPLY_EVENT);
    expect(job.data.chatKey).toMatch(/^g:/);
    expect(ctx.groupNod()).toEqual([]);
    expect(await ctx.runJob(job)).toEqual([]);
    expect(ctx.groupNod()).toEqual(["Pool one is cheaper."]);
  });

  it("retries when Claude fails, with no apology until the last attempt", async () => {
    const claude = fakeClaude(new Error("overloaded"), new Error("overloaded"), reply([text("Got it.")]));
    const ctx = await setup(claude);
    const errors = await ctx.runJob(await ctx.ask("@Nod hello"));
    expect(errors).toHaveLength(2);
    expect(ctx.groupNod()).toEqual(["Got it."]);
  });

  it("apologises once when every attempt fails", async () => {
    const claude = fakeClaude(new Error("down"), new Error("down"), new Error("down"), new Error("down"));
    const ctx = await setup(claude);
    const errors = await ctx.runJob(await ctx.ask("@Nod hello"));
    expect(errors).toHaveLength(3); // the fourth attempt apologises instead of throwing
    expect(ctx.groupNod()).toEqual([SNAG_MESSAGE]);
  });

  it("never re-runs a tool that finished before a retry", async () => {
    const { tool, runs } = countingTool("send_pay_links");
    const claude = fakeClaude(
      reply([toolUse("t1", "send_pay_links", {})], "tool_use"),
      new Error("overloaded"), // fails after the tool ran
      reply([text("Pay links sent.")]),
    );
    const ctx = await setup(claude, [tool]);
    const errors = await ctx.runJob(await ctx.ask("@Nod collect for the boat"));
    expect(errors).toHaveLength(1);
    expect(runs).toHaveBeenCalledTimes(1);
    expect(ctx.willDms().filter((t) => t === "send_pay_links ran")).toHaveLength(1);
    expect(ctx.groupNod()).toEqual(["Pay links sent."]);
  });

  it("when a crash interrupted a round of tools, runs only the ones that hadn't finished", async () => {
    const a = countingTool("tool_a");
    const b = countingTool("tool_b");
    const claude = fakeClaude(reply([text("Both done.")]));
    const ctx = await setup(claude, [a.tool, b.tool]);
    const job = await ctx.ask("@Nod do both");
    // As if the first attempt crashed after tool_a finished: Claude's turn and tool_a's result were saved.
    const call = reviveCall(job.data);
    const key = `${call.event.provider}:${call.event.messageId}`;
    await ctx.store.beginReply(key, call.groupId);
    await ctx.store.saveReply(key, {
      history: [
        { role: "user", content: "context" },
        { role: "assistant", content: [toolUse("ta", "tool_a", {}), toolUse("tb", "tool_b", {})] },
      ],
      results: { ta: { content: "tool_a done", isError: false } },
    });
    expect(await ctx.runJob(job)).toEqual([]);
    expect(a.runs).not.toHaveBeenCalled();
    expect(b.runs).toHaveBeenCalledTimes(1);
    expect(claude.create).toHaveBeenCalledTimes(1);
    const sent = claude.create.mock.calls[0]![0].messages.at(-1).content;
    expect(sent.map((r: any) => [r.tool_use_id, r.content])).toEqual([["ta", "tool_a done"], ["tb", "tool_b done"]]);
  });

  it("when sending the reply fails, retries the send without asking Claude again", async () => {
    const claude = fakeClaude(reply([text("Dinner's at 8.")]));
    const ctx = await setup(claude);
    ctx.flaky.failSends(1, "Dinner's at 8.");
    const errors = await ctx.runJob(await ctx.ask("@Nod when's dinner?"));
    expect(errors.map((e) => e.message)).toEqual(["sendblue timeout"]);
    expect(claude.create).toHaveBeenCalledTimes(1);
    expect(ctx.groupNod()).toEqual(["Dinner's at 8."]);
  });

  it("does nothing when a finished job runs again", async () => {
    const claude = fakeClaude(reply([text("Hi.")]));
    const ctx = await setup(claude);
    const job = await ctx.ask("@Nod hi");
    await ctx.runJob(job);
    await ctx.runJob(job);
    expect(claude.create).toHaveBeenCalledTimes(1);
    expect(ctx.groupNod()).toEqual(["Hi."]);
  });

  it("clears the saved conversation once the reply is done", async () => {
    const claude = fakeClaude(reply([text("Hi.")]));
    const ctx = await setup(claude);
    const job = await ctx.ask("@Nod hi");
    await ctx.runJob(job);
    const call = reviveCall(job.data);
    const row = await ctx.store.beginReply(`${call.event.provider}:${call.event.messageId}`, call.groupId);
    expect(row).toMatchObject({ status: "done", history: [], results: {} });
  });
});

describe("reply events", () => {
  it("round-trip the call through JSON", () => {
    const call: AddressedCall = {
      event: { type: "message", provider: "sendblue", messageId: "m1", groupId: null, from: "+15550200001", text: "hi", mediaUrls: [], service: "imessage", mentions: [], sentAt: new Date("2026-09-29T15:00:00Z") },
      decision: { addressed: true, tier: "certain", reason: "private" },
      groupId: null,
      senderUserId: "u1",
      firstSeenGroup: false,
    };
    const { data } = replyEvent(call);
    expect(data.chatKey).toBe("u:u1");
    expect(reviveCall(JSON.parse(JSON.stringify(data)))).toEqual(call);
  });
});
