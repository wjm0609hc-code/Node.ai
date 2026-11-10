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

    expect(ctx.classifyAnswer).toHaveBeenCalledWith({ question: QUESTION, answer: "$310 a night", mode: "person" });
    expect(ctx.nodLines().map((l) => l.text)).toEqual([QUESTION, "Thanks, noted."]);
    const userText: string = ctx.claude.requests[2].messages[0].content;
    expect(userText).toContain(`This message answers your question to Jake: “${QUESTION}”`);
  });

  it("closes the question once answered (Jake's next message is only checked as a follow-up to Nod's reply to him)", async () => {
    const ctx = await tulum({ answers: [true, false] });
    await ctx.say("will", "@Nod how much is Casa Azul a night?");
    await ctx.say("jake", "$310 a night");
    await ctx.say("jake", "also it has a pool");
    expect(ctx.classifyAnswer).toHaveBeenCalledTimes(2);
    expect(ctx.classifyAnswer).toHaveBeenLastCalledWith({ question: "Thanks, noted.", answer: "also it has a pool", mode: "caller" });
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
    ctx.classifyAnswer.mockResolvedValueOnce(false);
    await ctx.say("jake", "and cleaning is $80");
    // The question is closed; only the new follow-up window from Nod's reply to Jake checks it.
    expect(ctx.classifyAnswer).toHaveBeenCalledTimes(1);
    expect(ctx.classifyAnswer).toHaveBeenCalledWith({ question: "Got it.", answer: "and cleaning is $80", mode: "caller" });
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

  it("opens a window for the caller when Nod's reply asks them something, without the tool", async () => {
    const ctx = await tulum({
      responses: [reply([text("Casa Azul is $40 cheaper a night. Want me to look for dinner spots near it too?")]), reply([text("On it.")])],
    });
    await ctx.say("will", "@Nod which place is cheaper?");
    await ctx.say("will", "Yes please");
    expect(ctx.classifyAnswer).toHaveBeenCalledWith({
      question: "Casa Azul is $40 cheaper a night. Want me to look for dinner spots near it too?",
      answer: "Yes please",
      mode: "caller",
    });
    expect(ctx.nodLines().map((l) => l.text)).toEqual([
      "Casa Azul is $40 cheaper a night. Want me to look for dinner spots near it too?",
      "On it.",
    ]);
  });

  it("gives the caller 10 minutes when the reply asks them something, and 3 when it doesn't (a ? inside a link doesn't count)", async () => {
    const asks = await tulum({ responses: [reply([text("Want me to look for dinner spots too?")])], answers: [false] });
    await asks.say("will", "@Nod which place is cheaper?");
    asks.tick(8);
    await asks.say("will", "Yes please");
    expect(asks.classifyAnswer).toHaveBeenCalledTimes(1);

    const tells = await tulum({ responses: [reply([text("Casa Azul is cheaper: https://example.com/list?sort=price")])], answers: [false] });
    await tells.say("will", "@Nod which place is cheaper?");
    tells.tick(4);
    await tells.say("will", "Yes please");
    expect(tells.classifyAnswer).not.toHaveBeenCalled();
  });

  it("lets the caller follow up on their request without tagging Nod, briefly", async () => {
    const ctx = await tulum({ responses: [reply([text("Lupa has a table for 5 at 7.")]), reply([text("Moved it to 8.")])], answers: [false, true] });
    await ctx.say("will", "@Nod dinner for 5 Saturday at 7?");
    await ctx.say("will", "lol sarah you're late again");
    await ctx.say("will", "actually make it 8pm");
    expect(ctx.classifyAnswer).toHaveBeenLastCalledWith({ question: "Lupa has a table for 5 at 7.", answer: "actually make it 8pm", mode: "caller" });
    expect(ctx.nodLines().map((l) => l.text)).toEqual(["Lupa has a table for 5 at 7.", "Moved it to 8."]);
    expect(ctx.claude.requests[1].messages[0].content).toContain("Will didn't tag you: this message follows up on your last reply to them: “Lupa has a table for 5 at 7.”");
    // Others still need to tag Nod.
    await ctx.say("sarah", "make it 9 instead");
    expect(ctx.classifyAnswer).toHaveBeenCalledTimes(2);
  });

  it("asks the named member when Claude uses the tool; the caller can only follow up on their own request", async () => {
    const ctx = await tulum({ answers: [false] });
    await ctx.say("will", "@Nod how much is Casa Azul a night?");
    await ctx.say("will", "any idea?");
    expect(ctx.classifyAnswer).toHaveBeenCalledWith({ question: QUESTION, answer: "any idea?", mode: "caller" });
    expect(ctx.nodLines()).toHaveLength(1);
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

describe("questions to the whole group", () => {
  const HOW_MANY = "How many people for dinner?";
  const askGroup = () => [reply([toolUse("g", "expect_answer_from_group", {})], "tool_use"), reply([text(HOW_MANY)])];

  it("lets anyone answer once, without tagging Nod, and tells Claude it's the group's answer", async () => {
    const ctx = await tulum({ responses: [...askGroup(), reply([text("Got it, 6.")])], answers: [false, true] });
    await ctx.say("will", "@Nod find us dinner Saturday");
    await ctx.say("sarah", "lol omw");
    await ctx.say("mike", "6 of us");
    expect(ctx.classifyAnswer).toHaveBeenNthCalledWith(1, { question: HOW_MANY, answer: "lol omw", mode: "group" });
    expect(ctx.classifyAnswer).toHaveBeenNthCalledWith(2, { question: HOW_MANY, answer: "6 of us", mode: "group" });
    expect(ctx.nodLines().map((l) => l.text)).toEqual([HOW_MANY, "Got it, 6."]);
    expect(ctx.claude.requests[2].messages[0].content).toContain("Mike didn't tag you: this message answers your question to the group: “How many people for dinner?”");
    // After the first answer, others' messages are only checked for a clear change to it.
    await ctx.say("jake", "nice, see you there");
    expect(ctx.classifyAnswer).toHaveBeenLastCalledWith({ question: HOW_MANY, answer: "nice, see you there", mode: "update", answered: "6 of us" });
    expect(ctx.nodLines()).toHaveLength(2);
  });

  it("picks up a change to the group's answer, at most twice", async () => {
    const ctx = await tulum({
      responses: [...askGroup(), reply([text("Got it, 6.")]), reply([text("Updated to 7.")]), reply([text("Updated to 6.")]), reply([text("Updated to 8.")])],
      answers: [true, false, true, true, true],
    });
    await ctx.say("will", "@Nod find us dinner Saturday");
    await ctx.say("mike", "6 of us");
    await ctx.say("sarah", "yay jake's coming!");
    await ctx.say("jake", "actually I'm coming too so make it 7");
    expect(ctx.classifyAnswer).toHaveBeenLastCalledWith({ question: HOW_MANY, answer: "actually I'm coming too so make it 7", mode: "update", answered: "6 of us" });
    expect(ctx.claude.requests.at(-1).messages[0].content).toContain("Jake didn't tag you: this message changes the group's answer (“6 of us”) to your question “How many people for dinner?”");
    await ctx.say("sarah", "priya's out, 6");
    expect(ctx.classifyAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "update", answered: "actually I'm coming too so make it 7" }));
    // Two changes used up: the question is closed now (and the short follow-up windows from Nod's replies have run out).
    ctx.tick(4);
    const calls = ctx.classifyAnswer.mock.calls.length;
    await ctx.say("mike", "make it 8");
    expect(ctx.classifyAnswer).toHaveBeenCalledTimes(calls);
    expect(ctx.nodLines().map((l) => l.text)).toEqual([HOW_MANY, "Got it, 6.", "Updated to 7.", "Updated to 6."]);
  });

  it("stops listening for changes when the 10 minutes are up", async () => {
    const ctx = await tulum({ responses: [...askGroup(), reply([text("Got it, 6.")])], answers: [true, true] });
    await ctx.say("will", "@Nod find us dinner Saturday");
    await ctx.say("mike", "6 of us");
    ctx.tick(11);
    await ctx.say("jake", "make it 7");
    expect(ctx.classifyAnswer).toHaveBeenCalledTimes(1);
  });

  it("closes the group question when the caller answers it through their own window", async () => {
    const ctx = await tulum({ responses: [...askGroup(), reply([text("Got it, 6.")])], answers: [true] });
    await ctx.say("will", "@Nod find us dinner Saturday");
    await ctx.say("will", "6");
    expect(ctx.classifyAnswer).toHaveBeenCalledWith({ question: HOW_MANY, answer: "6", mode: "caller" });
    await ctx.say("mike", "6");
    // The question is answered: Mike's message is only checked as a possible change to Will's "6".
    expect(ctx.classifyAnswer).toHaveBeenLastCalledWith({ question: HOW_MANY, answer: "6", mode: "update", answered: "6" });
    expect(ctx.nodLines()).toHaveLength(2);
  });

  it("expires after 10 minutes, and gives up after 8 messages that aren't answers", async () => {
    const late = await tulum({ responses: askGroup() });
    await late.say("will", "@Nod find us dinner Saturday");
    late.tick(11);
    await late.say("mike", "6 of us");
    expect(late.classifyAnswer).not.toHaveBeenCalled();

    const chatty = await tulum({ responses: askGroup(), answers: Array(8).fill(false) });
    await chatty.say("will", "@Nod find us dinner Saturday");
    for (let i = 0; i < 8; i++) await chatty.say(i % 2 ? "sarah" : "mike", `chat ${i}`);
    await chatty.say("jake", "6 of us");
    expect(chatty.classifyAnswer).toHaveBeenCalledTimes(8);
    expect(chatty.nodLines()).toHaveLength(1);
  });

  it("is only for group chats", async () => {
    const priv = await tulum({ responses: [reply([text("hi")]), reply([toolUse("g", "expect_answer_from_group", {})], "tool_use"), reply([text("ok")])] });
    priv.world.dm(priv.s.users.will.id, "hey");
    await priv.world.settled();
    priv.world.dm(priv.s.users.will.id, "how many?");
    await priv.world.settled();
    const errored = priv.claude.requests.flatMap((r) => r.messages).flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).find((b: any) => b.type === "tool_result");
    expect(errored).toMatchObject({ is_error: true });
  });
});
