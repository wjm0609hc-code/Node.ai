import { describe, expect, it, vi } from "vitest";
import { createResponder, type AgentClient } from "../agent/responder";
import { MemoryStore } from "../db/memory-store";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedMixedGroup, seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import { createNod } from "../nod";

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });

const QUESTION = "Jake, what's the nightly price on Casa Azul?";
/** Claude asks Jake a question and marks it as expecting his answer. */
const askJake = () => [reply([toolUse("q", "expect_answer_from", { member: "Jake" })], "tool_use"), reply([text(QUESTION)])];

function fakeClaude(...responses: Array<ReturnType<typeof reply>>) {
  const requests: any[] = [];
  const create = vi.fn(async (body: any) => {
    requests.push(structuredClone(body));
    return responses.shift() ?? reply([text("ok")]);
  });
  return { client: { beta: { messages: { create } } } as unknown as AgentClient, requests, create };
}

async function setup(opts: { answers?: boolean[]; responses?: Array<ReturnType<typeof reply>>; scenario?: "tulum" | "mixed" } = {}) {
  let clock = new Date("2026-09-29T15:00:00Z");
  const now = () => clock;
  const world = new ChatWorld({ now });
  const store = new MemoryStore({ now });
  const claude = fakeClaude(...(opts.responses ?? [...askJake(), reply([text("Thanks, noted.")])]));
  const answers = [...(opts.answers ?? [true])];
  const classifyAnswer = vi.fn(async () => answers.shift() ?? false);
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    classifyAnswer,
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4" },
    now,
    makeResponder: (env) => createResponder({ ...env, client: claude.client }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const tick = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };
  return { world, store, claude, classifyAnswer, nod, tick, scenario: opts.scenario ?? "tulum" };
}

async function tulum(opts: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup(opts);
  const s = seedTulumGroup(ctx.world);
  await registerWorldPeople(ctx.world, ctx.store, { access: "active" });
  ctx.world.addNod(s.groupId, s.users.sarah.id);
  await ctx.world.settled();
  const say = async (who: keyof typeof s.users, message: string, extra: { replyTo?: string } = {}) => {
    ctx.world.say(s.users[who].id, s.groupId, message, { mentionNod: message.includes("@Nod"), ...extra });
    await ctx.world.settled();
  };
  const nodLines = () => ctx.world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1);
  const group = (await ctx.store.groupByProviderId("simulator", s.groupId))!;
  return { ...ctx, s, say, nodLines, group };
}

describe("follow-up answers", () => {
  it("records an open question for the person Nod asked, tied to Nod's message", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod how much is Casa Azul a night?");
    const [asked] = ctx.nodLines();
    expect(asked!.text).toBe(QUESTION);

    const jake = await ctx.store.upsertUser(ctx.s.users.jake.phone);
    const open = await ctx.store.activePendingQuestion(ctx.group.id, jake.id, new Date("2026-09-29T15:05:00Z"));
    expect(open).toMatchObject({ question: QUESTION, nodProviderMessageId: asked!.messageId, remaining: 2 });
    expect(open!.expiresAt.toISOString()).toBe("2026-09-29T15:10:00.000Z");
  });

  it("lets that person answer without tagging Nod, and tells Claude what the answer is for", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod how much is Casa Azul a night?");
    await ctx.say("jake", "$310 a night");

    expect(ctx.classifyAnswer).toHaveBeenCalledWith({ question: QUESTION, answer: "$310 a night" });
    expect(ctx.nodLines().map((l) => l.text)).toEqual([QUESTION, "Thanks, noted."]);
    const userText: string = ctx.claude.requests[2].messages[0].content;
    expect(userText).toContain(`This message answers your question to Jake: “${QUESTION}”`);
  });

  it("closes the question once answered", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod how much is Casa Azul a night?");
    await ctx.say("jake", "$310 a night");
    await ctx.say("jake", "also it has a pool");
    expect(ctx.classifyAnswer).toHaveBeenCalledTimes(1);
    expect(ctx.nodLines()).toHaveLength(2);
  });

  it("ignores everyone else", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod how much is Casa Azul a night?");
    await ctx.say("mike", "$300 I think");
    expect(ctx.classifyAnswer).not.toHaveBeenCalled();
    expect(ctx.nodLines()).toHaveLength(1);
  });

  it("stays silent when the message isn't an answer, and gives up after two messages", async () => {
    const ctx = await tulum({ answers: [false, false, true] });
    await ctx.say("will", "@Nod how much is Casa Azul a night?");
    await ctx.say("jake", "lol one sec");
    await ctx.say("jake", "grabbing dinner");
    await ctx.say("jake", "$310");
    expect(ctx.classifyAnswer).toHaveBeenCalledTimes(2);
    expect(ctx.nodLines()).toHaveLength(1);
  });

  it("expires after 10 minutes", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod how much is Casa Azul a night?");
    ctx.tick(11);
    await ctx.say("jake", "$310");
    expect(ctx.classifyAnswer).not.toHaveBeenCalled();
    expect(ctx.nodLines()).toHaveLength(1);
  });

  it("closes the question when the person calls Nod directly or replies inline", async () => {
    const ctx = await tulum({ responses: [...askJake(), reply([text("Got it.")])] });
    await ctx.say("will", "@Nod how much is Casa Azul a night?");
    const [asked] = ctx.nodLines();
    await ctx.say("jake", "310", { replyTo: asked!.messageId });
    await ctx.say("jake", "and cleaning is $80");
    expect(ctx.classifyAnswer).not.toHaveBeenCalled();
    expect(ctx.nodLines().map((l) => l.text)).toEqual([QUESTION, "Got it."]);
  });

  it("works in an SMS group, where there are no inline replies", async () => {
    const ctx = await setup({
      responses: [
        reply([toolUse("q", "expect_answer_from", { member: "Priya" })], "tool_use"),
        reply([text("Priya, what time works for you?")]),
        reply([text("11 it is.")]),
      ],
    });
    const s = seedMixedGroup(ctx.world);
    await registerWorldPeople(ctx.world, ctx.store, { access: "active" });
    const created = await ctx.nod.provider.createGroup({
      members: Object.values(s.users).map((u) => u.phone),
      name: "Brunch",
      firstMessage: { text: "hi" },
    });
    ctx.world.say(s.users.will.id, created.groupId, "@Nod when should we book?");
    await ctx.world.settled();
    ctx.world.say(s.users.priya.id, created.groupId, "11am works");
    await ctx.world.settled();
    const nod = ctx.world.transcript(created.groupId, s.users.will.id).filter((l) => l.from === "nod").map((l) => l.text);
    expect(nod).toEqual(["hi", "Priya, what time works for you?", "11 it is."]);
  });

  it("only applies to questions for one member of a group", async () => {
    const ctx = await tulum({
      responses: [reply([toolUse("q", "expect_answer_from", { member: "Priyanka" })], "tool_use"), reply([text("Who?")])],
    });
    await ctx.say("will", "@Nod ask Priyanka");
    expect(ctx.claude.requests[1].messages[2].content[0]).toMatchObject({ is_error: true, content: "No one named “Priyanka” is in this group." });

    const priv = await tulum({ responses: [reply([text("hi")]), reply([toolUse("q", "expect_answer_from", { member: "Will" })], "tool_use"), reply([text("ok")])] });
    priv.world.dm(priv.s.users.will.id, "hey");
    await priv.world.settled();
    priv.world.dm(priv.s.users.will.id, "ask me something");
    await priv.world.settled();
    expect(priv.claude.requests[2].messages[2].content[0]).toMatchObject({
      is_error: true,
      content: "Private chats don't need this. Anything they send here reaches you.",
    });
  });

  it("opens nothing when Nod ends up not replying", async () => {
    const ctx = await tulum({ responses: [reply([toolUse("q", "expect_answer_from", { member: "Jake" })], "tool_use"), reply([])] });
    await ctx.say("will", "@Nod hmm");
    const jake = await ctx.store.upsertUser(ctx.s.users.jake.phone);
    expect(await ctx.store.activePendingQuestion(ctx.group.id, jake.id, new Date("2026-09-29T15:01:00Z"))).toBeUndefined();
  });
});
