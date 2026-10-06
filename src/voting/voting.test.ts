import { describe, expect, it, vi } from "vitest";
import { createResponder, type AgentClient } from "../agent/responder";
import { MemoryStore } from "../db/memory-store";
import { MemoryScheduler } from "../jobs/scheduler";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedMixedGroup, seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld, type TranscriptLine } from "../messaging/simulator/world";
import { createNod } from "../nod";

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });
type Scripted = ReturnType<typeof reply> | ((body: any) => ReturnType<typeof reply>);

const A = "https://www.airbnb.com/rooms/111";
const B = "https://www.airbnb.com/rooms/222";
const optionIds = (body: any) => [...String(body.messages[0].content).matchAll(/\[option ([^\]]+)\]/g)].map((m) => m[1]!);
const decisionId = (body: any) => /\[vote ([^\]]+)\]/.exec(String(body.messages[0].content))?.[1];
/** Claude starts a vote on every option it can see, then ends its turn with no text. */
const startVote = (extra: Record<string, unknown> = {}): Scripted[] => [
  (body) => reply([toolUse("v", "start_vote", { option_ids: optionIds(body), question: "Where to stay?", ...extra })], "tool_use"),
  reply([]),
];

function fakeClaude(responses: Scripted[]) {
  const requests: any[] = [];
  const create = vi.fn(async (body: any) => {
    requests.push(structuredClone(body));
    const next = responses.shift();
    if (!next) return reply([text("ok")]);
    return typeof next === "function" ? next(body) : next;
  });
  return { client: { beta: { messages: { create } } } as unknown as AgentClient, requests, create };
}

const CARD_LINK = /^.+: https:\/\/nod\.test\/o\/[A-Za-z0-9]{12} \(tap to open\)$/;

async function setup(responses: Scripted[] = startVote(), opts: { mixed?: boolean } = {}) {
  let clock = new Date("2026-09-29T15:00:00Z"); // 11:00 AM in New York
  const now = () => clock;
  const world = new ChatWorld({ now });
  const store = new MemoryStore({ now });
  const scheduler = new MemoryScheduler();
  const claude = fakeClaude(responses);
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4", timezone: "America/New_York", appUrl: "https://nod.test" },
    scheduler,
    now,
    makeResponder: (env) => createResponder({ ...env, client: claude.client }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const advance = async (hours: number) => {
    clock = new Date(clock.getTime() + hours * 3_600_000);
    await scheduler.runDue(clock, nod.runJob);
    await world.settled();
  };
  return { world, store, scheduler, claude, nod, advance, now };
}

async function tulum(responses?: Scripted[]) {
  const ctx = await setup(responses);
  const s = seedTulumGroup(ctx.world);
  await registerWorldPeople(ctx.world, ctx.store, { access: "active" });
  ctx.world.addNod(s.groupId, s.users.sarah.id);
  await ctx.world.settled();
  const say = async (who: keyof typeof s.users, message: string) => {
    const id = ctx.world.say(s.users[who].id, s.groupId, message, { mentionNod: message.includes("@Nod") });
    await ctx.world.settled();
    return id;
  };
  const linkA = await say("jake", `this one ${A}`);
  const linkB = await say("sarah", `or ${B}`);
  const nodLines = () => ctx.world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1);
  const group = (await ctx.store.groupByProviderId("simulator", s.groupId))!;
  const [optA, optB] = await ctx.store.listOptions(group.id);
  const open = () => ctx.store.openDecision(group.id);
  const voteOf = async (who: keyof typeof s.users) => {
    const d = (await open()) ?? (await ctx.store.getDecision((await lastDecision())!));
    const u = await ctx.store.upsertUser(s.users[who].phone);
    return (await ctx.store.votesFor(d!.id)).find((v) => v.userId === u.id)?.optionId;
  };
  let last: string | undefined;
  const lastDecision = async () => last ?? (last = (await open())?.id);
  return { ...ctx, s, say, linkA, linkB, nodLines, group, optA: optA!, optB: optB!, open, voteOf };
}

describe("starting a vote", () => {
  it("posts a header and each option as its own message, and schedules the deadline and a nudge", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod let's vote on these");

    const lines = ctx.nodLines().map((l) => l.text);
    expect(lines[0]).toBe("Vote: Where to stay? Tap 👍 on your pick below (tap another to switch). Closes Wed, Sep 30, 11:00 AM.");
    // Each option is its own card: a link that previews as the card and opens the listing.
    expect(lines.slice(1)).toEqual([expect.stringMatching(CARD_LINK), expect.stringMatching(CARD_LINK)]);
    const cards = await Promise.all(lines.slice(1).map((l) => ctx.store.getCard(l.split("/o/")[1]!.split(" ")[0]!)));
    expect(cards.map((c) => [c?.data.number, c?.data.footer, c?.targetUrl])).toEqual([
      [1, "Tap 👍 to vote", "https://www.airbnb.com/rooms/111"],
      [2, "Tap 👍 to vote", "https://www.airbnb.com/rooms/222"],
    ]);
    const d = (await ctx.open())!;
    expect(d).toMatchObject({ question: "Where to stay?", round: 1, status: "open" });
    expect(d.deadlineAt!.toISOString()).toBe("2026-09-30T15:00:00.000Z");
    expect(await ctx.store.decisionOptions(d.id)).toEqual([
      { position: 1, optionId: ctx.optA.id },
      { position: 2, optionId: ctx.optB.id },
    ]);
    expect(ctx.scheduler.pending()).toEqual([
      { runAt: new Date("2026-09-30T12:00:00.000Z"), job: { type: "nudge", decisionId: d.id } },
      { runAt: new Date("2026-09-30T15:00:00.000Z"), job: { type: "deadline", decisionId: d.id, deadlineAt: "2026-09-30T15:00:00.000Z" } },
    ]);
  });

  it("reads deadlines as local times in the group's timezone", async () => {
    const ctx = await tulum(startVote({ deadline_local: "2026-10-02T18:00" }));
    await ctx.say("will", "@Nod vote on these by Friday 6pm");
    expect((await ctx.open())!.deadlineAt!.toISOString()).toBe("2026-10-02T22:00:00.000Z");
    expect(ctx.nodLines()[0]!.text).toContain("Closes Fri, Oct 2, 6:00 PM.");
  });

  it("shows Claude the local time", async () => {
    const ctx = await tulum([reply([text("ok")])]);
    await ctx.say("will", "@Nod what time is it?");
    expect(ctx.claude.requests[0].messages[0].content).toContain("Local time for this chat: Tue, Sep 29, 11:00 AM (America/New_York).");
  });

  it.each([
    [{ option_ids: ["only-one"] }, "A vote needs 2 to 6 options."],
    [{ option_ids: ["x", "y"] }, "Those options aren't all in this group. Use ids from the options lists."],
    [{ deadline_local: "2026-09-28T10:00" }, "That deadline is in the past or too soon. Pick a time at least 10 minutes from now."],
    [{ hours: 24 * 30 }, "Votes can run for at most 14 days."],
  ])("refuses bad requests: %j", async (input, message) => {
    const ctx = await tulum([
      (body) => reply([toolUse("v", "start_vote", { option_ids: optionIds(body), question: "q", ...input })], "tool_use"),
      reply([text("Hmm.")]),
    ]);
    await ctx.say("will", "@Nod vote");
    expect(ctx.claude.requests[1].messages[2].content[0]).toMatchObject({ is_error: true, content: message });
    expect(await ctx.open()).toBeUndefined();
  });

  it("allows one open vote per group", async () => {
    const ctx = await tulum([...startVote(), ...startVote(), reply([text("There's already a vote open.")])]);
    await ctx.say("will", "@Nod vote on these");
    await ctx.say("mike", "@Nod start another vote");
    expect(ctx.claude.requests[3].messages[2].content[0]).toMatchObject({
      is_error: true,
      content: expect.stringContaining("A vote is already open"),
    });
  });
});

describe("casting votes (Nod stays silent)", () => {
  it("counts a bare number, lets people change their vote, and says nothing", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod let's vote on these");
    const calls = ctx.claude.create.mock.calls.length;
    await ctx.say("jake", "2");
    await ctx.say("mike", "#1");
    await ctx.say("jake", "I vote 1");
    await ctx.say("sarah", "2 people are bringing towels");

    expect(await ctx.voteOf("jake")).toBe(ctx.optA.id);
    expect(await ctx.voteOf("mike")).toBe(ctx.optA.id);
    expect(await ctx.voteOf("sarah")).toBeUndefined();
    expect(ctx.nodLines()).toHaveLength(3);
    expect(ctx.claude.create.mock.calls.length).toBe(calls);
  });

  it("counts 'I vote <name>' when it matches exactly one option", async () => {
    const ctx = await tulum();
    await ctx.store.updateOptionParsed(ctx.optB.id, { title: "Beach House" });
    await ctx.say("will", "@Nod let's vote on these");
    await ctx.say("mike", "I vote the beach house");
    await ctx.say("jake", "I vote we go home");
    expect(await ctx.voteOf("mike")).toBe(ctx.optB.id);
    expect(await ctx.voteOf("jake")).toBeUndefined();
  });

  it("counts a tapback on an option's original link message, and removing it removes the vote", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod let's vote on these");
    ctx.world.react(ctx.s.users.mike.id, ctx.linkB, "love");
    ctx.world.react(ctx.s.users.will.id, ctx.linkA, "like");
    ctx.world.react(ctx.s.users.jake.id, ctx.linkA, "dislike");
    await ctx.world.settled();
    expect(await ctx.voteOf("mike")).toBe(ctx.optB.id);
    expect(await ctx.voteOf("will")).toBe(ctx.optA.id);
    expect(await ctx.voteOf("jake")).toBeUndefined();

    ctx.world.react(ctx.s.users.mike.id, ctx.linkB, "love", { removed: true });
    await ctx.world.settled();
    expect(await ctx.voteOf("mike")).toBeUndefined();
  });

  it("counts Android tapback text in SMS groups", async () => {
    const ctx = await setup(startVote());
    const s = seedMixedGroup(ctx.world);
    await registerWorldPeople(ctx.world, ctx.store, { access: "active" });
    const { groupId } = await ctx.nod.provider.createGroup({ members: Object.values(s.users).map((u) => u.phone), name: "Brunch", firstMessage: { text: "hi" } });
    const link = ctx.world.say(s.users.dan.id, groupId, `brunch spot ${A}`);
    ctx.world.say(s.users.priya.id, groupId, `or ${B}`);
    ctx.world.say(s.users.will.id, groupId, "@Nod vote on these");
    await ctx.world.settled();
    ctx.world.react(s.users.priya.id, link, "like"); // arrives as the text: Liked “brunch spot https://…”
    await ctx.world.settled();
    const group = (await ctx.store.groupByProviderId("simulator", groupId))!;
    const d = (await ctx.store.openDecision(group.id))!;
    const priya = await ctx.store.upsertUser(s.users.priya.phone);
    const [optA] = await ctx.store.listOptions(group.id);
    expect((await ctx.store.votesFor(d.id)).find((v) => v.userId === priya.id)?.optionId).toBe(optA!.id);
  });

  it("records '@Nod put me down for …' through cast_vote", async () => {
    const ctx = await tulum([...startVote(), reply([toolUse("c", "cast_vote", { choice: 2 })], "tool_use"), reply([text("Got it.")])]);
    await ctx.say("will", "@Nod let's vote on these");
    await ctx.say("mike", "@Nod put me down for the second one");
    expect(await ctx.voteOf("mike")).toBe(ctx.optB.id);
  });
});

describe("closing", () => {
  it("posts the winner at the deadline", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod let's vote on these");
    await ctx.say("jake", "1");
    await ctx.say("mike", "1");
    await ctx.say("sarah", "2");
    await ctx.advance(24);

    expect(ctx.nodLines().at(-1)!.text).toBe("The vote's in: airbnb.com/rooms/111 wins with 2 of 3 votes (airbnb.com/rooms/222: 1).");
    const d = (await ctx.store.getDecision((await ctx.store.listDecisions(ctx.group.id))[0]!.id))!;
    expect(d).toMatchObject({ status: "decided", winningOptionId: ctx.optA.id });
  });

  it("nudges people who haven't voted, privately, once", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod let's vote on these");
    await ctx.say("jake", "1");
    await ctx.advance(21);
    await ctx.advance(0.5);

    const nudged = (who: keyof typeof ctx.s.users) => ctx.world.dmTranscript(ctx.s.users[who].id).filter((l: TranscriptLine) => l.from === "nod" && /vote/.test(l.text));
    expect(nudged("jake")).toEqual([]);
    expect(nudged("mike").map((l) => l.text)).toEqual([
      "Quick one: the Tulum 🌴 vote on “Where to stay?” closes Wed, Sep 30, 11:00 AM. Reply here with 1 (airbnb.com/rooms/111), 2 (airbnb.com/rooms/222), or tap 👍 in the group.",
    ]);
    expect(nudged("will")).toHaveLength(1);
  });

  it("lets people vote privately after a nudge", async () => {
    const ctx = await tulum([
      ...startVote(),
      reply([text("Hi.")]), // Mike's first private message triggers setup, then this reply
      (body) => reply([toolUse("c", "cast_vote", { decision_id: decisionId(body), choice: 2 })], "tool_use"),
      reply([text("Recorded: 2.")]),
    ]);
    await ctx.say("will", "@Nod let's vote on these");
    ctx.world.dm(ctx.s.users.mike.id, "hey");
    await ctx.world.settled();
    ctx.world.dm(ctx.s.users.mike.id, "2");
    await ctx.world.settled();
    expect(ctx.claude.requests[3].messages[0].content).toContain("<open_votes>");
    expect(await ctx.voteOf("mike")).toBe(ctx.optB.id);
  });

  it("runs one runoff on a tie, then asks the vote's starter to break a second tie", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod let's vote on these");
    await ctx.say("jake", "1");
    await ctx.say("sarah", "2");
    await ctx.advance(24);
    expect(ctx.nodLines().slice(-3).map((l) => l.text)).toEqual([
      "It's a tie between airbnb.com/rooms/111 and airbnb.com/rooms/222 (1 each), so here's a quick runoff. Tap 👍 on your pick by Wed, Sep 30, 11:00 PM.",
      expect.stringMatching(CARD_LINK),
      expect.stringMatching(CARD_LINK),
    ]);
    const runoff = (await ctx.open())!;
    expect(runoff).toMatchObject({ round: 2, status: "open" });

    await ctx.say("jake", "1");
    await ctx.say("sarah", "2");
    await ctx.advance(12);
    expect(ctx.nodLines().at(-1)!.text).toBe("Still tied! Will, you started this vote, so you get the deciding tap: 👍 your pick above.");

    await ctx.say("mike", "1"); // not the starter: ignored
    await ctx.say("will", "2");
    expect(ctx.nodLines().at(-1)!.text).toBe("Will broke the tie: airbnb.com/rooms/222 wins.");
    expect(await ctx.store.getDecision(runoff.id)).toMatchObject({ status: "decided", winningOptionId: ctx.optB.id });
  });

  it("counts a 👍 on an option's own message, switching and removing like any tapback", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod let's vote on these");
    const [, a, b] = ctx.nodLines();
    const tap = async (who: "jake" | "mike", id: string, removed = false) => {
      ctx.world.react(ctx.s.users[who].id, id, "like", { removed });
      await ctx.world.settled();
    };
    await tap("jake", a!.messageId);
    expect(await ctx.voteOf("jake")).toBe(ctx.optA.id);
    await tap("jake", b!.messageId);
    expect(await ctx.voteOf("jake")).toBe(ctx.optB.id);
    await tap("mike", a!.messageId);
    await tap("mike", a!.messageId, true);
    expect(await ctx.voteOf("mike")).toBeUndefined();
    // SMS tapback text on an option message counts too.
    await ctx.say("mike", `Liked “${b!.text}”`);
    expect(await ctx.voteOf("mike")).toBe(ctx.optB.id);
  });

  it("lets the tie-breaker break a tie by tapping 👍", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod let's vote on these");
    await ctx.say("jake", "1");
    await ctx.say("sarah", "2");
    await ctx.advance(24);
    await ctx.say("jake", "1");
    await ctx.say("sarah", "2");
    await ctx.advance(12);
    const lines = ctx.nodLines();
    const runoffB = lines[lines.findIndex((x) => x.text.startsWith("It's a tie")) + 2]!; // the runoff's second card
    ctx.world.react(ctx.s.users.mike.id, runoffB.messageId, "like"); // not the starter
    await ctx.world.settled();
    expect(ctx.nodLines().at(-1)!.text).toMatch(/^Still tied/);
    ctx.world.react(ctx.s.users.will.id, runoffB.messageId, "like");
    await ctx.world.settled();
    expect(ctx.nodLines().at(-1)!.text).toBe("Will broke the tie: airbnb.com/rooms/222 wins.");
  });

  it("closes early on request, and the later deadline job does nothing", async () => {
    const ctx = await tulum([...startVote(), reply([toolUse("c", "close_vote", {})], "tool_use"), reply([])]);
    await ctx.say("will", "@Nod let's vote on these");
    await ctx.say("jake", "2");
    await ctx.say("mike", "@Nod close the vote");
    expect(ctx.nodLines().at(-1)!.text).toBe("The vote's in: airbnb.com/rooms/222 wins with 1 of 1 vote.");
    await ctx.advance(25);
    expect(ctx.nodLines().filter((l) => l.text.startsWith("The vote's in"))).toHaveLength(1);
  });

  it("closes with no winner when nobody voted", async () => {
    const ctx = await tulum();
    await ctx.say("will", "@Nod let's vote on these");
    await ctx.advance(24);
    expect(ctx.nodLines().at(-1)!.text).toBe("Nobody voted on “Where to stay?”, so it's closed. Start a new one anytime.");
  });

  it("can be cancelled", async () => {
    const ctx = await tulum([...startVote(), reply([toolUse("c", "cancel_vote", {})], "tool_use"), reply([text("Cancelled the vote.")])]);
    await ctx.say("will", "@Nod let's vote on these");
    await ctx.say("jake", "@Nod cancel the vote");
    expect(await ctx.open()).toBeUndefined();
    await ctx.advance(25);
    expect(ctx.nodLines().map((l) => l.text).at(-1)).toBe("Cancelled the vote.");
  });

  it("shows Claude the open vote's standings and who hasn't voted", async () => {
    const ctx = await tulum([...startVote(), reply([text("Two votes so far.")])]);
    await ctx.say("will", "@Nod let's vote on these");
    await ctx.say("jake", "1");
    await ctx.say("mike", "@Nod how's the vote going?");
    const userText: string = ctx.claude.requests[2].messages[0].content;
    const d = (await ctx.open())!;
    expect(userText).toContain(`<open_vote>\n[vote ${d.id}] “Where to stay?”, closes Wed, Sep 30, 11:00 AM`);
    expect(userText).toContain("1. airbnb.com/rooms/111 (1 vote)");
    expect(userText).toContain("2. airbnb.com/rooms/222 (0 votes)");
    expect(userText).toMatch(/Not voted yet: .*Mike/);
  });
});
