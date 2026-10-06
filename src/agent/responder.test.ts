import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../db/memory-store";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import { createNod } from "../nod";
import { createResponder, keepLinksPlain, SNAG_MESSAGE, type AgentClient } from "./responder";
import { defineTool, type ToolContext } from "./tools";

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });

/** A fake Claude that returns queued responses and records each request as sent. */
function fakeClaude(...responses: Array<ReturnType<typeof reply> | Error>) {
  const requests: any[] = [];
  const options: any[] = [];
  const create = vi.fn(async (body: any, opts?: any) => {
    requests.push(structuredClone(body));
    options.push(opts);
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { beta: { messages: { create } } } as unknown as AgentClient, requests, options, create };
}

const lookup = defineTool<{ city: string }>({
  name: "lookup_weather",
  description: "Weather for a city.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
  async run(input, ctx: ToolContext) {
    return `Sunny in ${input.city} (asked by ${ctx.caller.name})`;
  },
});

async function setup(claude: ReturnType<typeof fakeClaude>, extra: { tools?: any[]; maxTurns?: number } = {}) {
  const world = new ChatWorld();
  const store = new MemoryStore();
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4" },
    makeResponder: (env) =>
      createResponder({ ...env, client: claude.client, tools: [lookup, ...(extra.tools ?? [])], maxTurns: extra.maxTurns }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id);
  await world.settled();
  const ask = async (who: keyof typeof s.users, message: string) => {
    world.say(s.users[who].id, s.groupId, message, { mentionNod: message.includes("@Nod") });
    await world.settled();
  };
  const nodLines = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1); // skip intro
  return { world, store, s, ask, nodLines };
}

describe("responder", () => {
  it("answers a call with one short message in the same chat", async () => {
    const claude = fakeClaude(reply([text("The pool one is $40 a night cheaper.")]));
    const ctx = await setup(claude);
    await ctx.ask("will", "@Nod which is cheaper?");

    expect(ctx.nodLines().map((l) => l.text)).toEqual(["The pool one is $40 a night cheaper."]);
    expect(claude.create).toHaveBeenCalledTimes(1);
  });

  it("sends the model, system prompt, context and tools in the expected shape", async () => {
    const claude = fakeClaude(reply([text("ok")]));
    const ctx = await setup(claude);
    await ctx.ask("will", "@Nod which is cheaper?");

    const [body] = claude.requests;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.max_tokens).toBe(16000);
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(body.fallbacks).toBe("default");
    expect(body.tool_choice).toBeUndefined();
    expect(body.system).toEqual([{ type: "text", text: expect.stringContaining("You are Nod"), cache_control: { type: "ephemeral" } }]);
    expect(body.tools.map((t: any) => t.name)).toEqual(["lookup_weather"]);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain('<message from="Will">\n@Nod which is cheaper?\n</message>');
    expect(body.messages[0].content).toContain("Group chat “Tulum 🌴”");
    expect(claude.options[0]).toMatchObject({ timeout: 60_000, maxRetries: 2 });
  });

  it("runs tools, sends results back in one user message, and replies with the final text", async () => {
    const first = reply(
      [text("Checking."), toolUse("t1", "lookup_weather", { city: "Tulum" }), toolUse("t2", "lookup_weather", { city: "Cancun" })],
      "tool_use",
    );
    const claude = fakeClaude(first, reply([text("Sunny in both.")]));
    const ctx = await setup(claude);
    await ctx.ask("jake", "@Nod weather?");

    const second = claude.requests[1];
    expect(second.messages).toHaveLength(3);
    // The assistant turn goes back exactly as Claude returned it (append-only history).
    expect(second.messages[1]).toEqual({ role: "assistant", content: first.content });
    expect(second.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "Sunny in Tulum (asked by Jake)", is_error: false },
        { type: "tool_result", tool_use_id: "t2", content: "Sunny in Cancun (asked by Jake)", is_error: false },
      ],
    });
    // Only the final answer is sent; text before a tool call isn't a separate message.
    expect(ctx.nodLines().map((l) => l.text)).toEqual(["Sunny in both."]);
  });

  it("returns tool errors to Claude as error results", async () => {
    const claude = fakeClaude(reply([toolUse("t1", "lookup_weather", {})], "tool_use"), reply([text("Couldn't check.")]));
    const ctx = await setup(claude);
    await ctx.ask("will", "@Nod weather?");
    expect(claude.requests[1].messages[2].content[0]).toMatchObject({ is_error: true, content: expect.stringContaining("city is required") });
    expect(ctx.nodLines().map((l) => l.text)).toEqual(["Couldn't check."]);
  });

  it("stays silent when Claude returns no text", async () => {
    const ctx = await setup(fakeClaude(reply([])));
    await ctx.ask("will", "@Nod nevermind");
    expect(ctx.nodLines()).toEqual([]);
  });

  it("sends a short apology once when Claude fails", async () => {
    const ctx = await setup(fakeClaude(new Error("overloaded")));
    await ctx.ask("will", "@Nod which is cheaper?");
    expect(ctx.nodLines().map((l) => l.text)).toEqual([SNAG_MESSAGE]);
  });

  it("gives up with the apology after too many tool rounds", async () => {
    const loop = () => reply([toolUse(`t${Math.random()}`, "lookup_weather", { city: "X" })], "tool_use");
    const claude = fakeClaude(loop(), loop(), loop());
    const ctx = await setup(claude, { maxTurns: 3 });
    await ctx.ask("will", "@Nod loop");
    expect(claude.create).toHaveBeenCalledTimes(3);
    expect(ctx.nodLines().map((l) => l.text)).toEqual([SNAG_MESSAGE]);
  });

  it("stays silent on a refusal", async () => {
    const ctx = await setup(fakeClaude(reply([], "refusal")));
    await ctx.ask("will", "@Nod something");
    expect(ctx.nodLines()).toEqual([]);
  });

  it("keeps replies short", async () => {
    const long = "This place is great. ".repeat(60);
    const ctx = await setup(fakeClaude(reply([text(long)])));
    await ctx.ask("will", "@Nod tell me everything");
    const sent = ctx.nodLines()[0]!.text;
    expect(sent.length).toBeLessThanOrEqual(700);
    expect(sent.endsWith("…")).toBe(true);
  });

  it("answers private messages privately", async () => {
    const claude = fakeClaude(reply([text("Hi Will.")]), reply([text("Sure.")]));
    const ctx = await setup(claude);
    ctx.world.dm(ctx.s.users.will.id, "hey"); // first contact: setup messages, then the answer
    await ctx.world.settled();
    const dm = ctx.world.dmTranscript(ctx.s.users.will.id).filter((l) => l.from === "nod");
    expect(dm.at(-1)!.text).toBe("Hi Will.");
    expect(claude.requests[0].messages[0].content).toContain("Private chat with Will.");
  });

  it("doesn't reach Claude for calls onboarding handles", async () => {
    const claude = fakeClaude();
    const ctx = await setup(claude);
    await ctx.ask("will", "@Nod your card");
    expect(claude.create).not.toHaveBeenCalled();
  });
});

describe("keepLinksPlain", () => {
  it("adds words after a link that ends the reply, so iMessage shows it as a plain link instead of a 'Tap to load preview' bubble", () => {
    expect(keepLinksPlain("Here are 3 spots. More here: https://nod.test/s/abc")).toBe("Here are 3 spots. More here: https://nod.test/s/abc (tap to open)");
    expect(keepLinksPlain("More here: https://nod.test/s/abc.")).toBe("More here: https://nod.test/s/abc. (tap to open)");
    expect(keepLinksPlain("See https://nod.test/s/abc for the rest.")).toBe("See https://nod.test/s/abc for the rest.");
    expect(keepLinksPlain("No links here.")).toBe("No links here.");
  });
});
