import { describe, expect, it, vi } from "vitest";
import { createResponder, type AgentClient } from "../agent/responder";
import { MemoryStore } from "../db/memory-store";
import { MemoryScheduler } from "../jobs/scheduler";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import { createNod } from "../nod";

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });
type Scripted = ReturnType<typeof reply> | ((body: any) => ReturnType<typeof reply>);
const call = (name: string, input: Record<string, unknown> | ((body: any) => Record<string, unknown>), after = ""): Scripted[] => [
  (body) => reply([toolUse("t", name, typeof input === "function" ? input(body) : input)], "tool_use"),
  reply(after ? [text(after)] : []),
];
type Who = "will" | "jake" | "sarah" | "mike";

const MARCH = [
  { starts_on: "2027-03-07", ends_on: "2027-03-11" },
  { starts_on: "2027-03-14", ends_on: "2027-03-18" },
  { starts_on: "2027-03-21", ends_on: "2027-03-25" },
];
const poll = (extra: Record<string, unknown> = {}) => call("run_date_poll", { question: "When works for Tulum?", choices: MARCH, ...extra });

async function setup(responses: Scripted[]) {
  let clock = new Date("2026-09-29T15:00:00Z"); // Tue 11:00 AM in New York
  const now = () => clock;
  const world = new ChatWorld({ now });
  const store = new MemoryStore({ now });
  const scheduler = new MemoryScheduler();
  const requests: any[] = [];
  const create = vi.fn(async (body: any) => {
    requests.push(structuredClone(body));
    const next = responses.shift();
    if (!next) return reply([text("ok")]);
    return typeof next === "function" ? next(body) : next;
  });
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4", timezone: "America/New_York" },
    scheduler,
    now,
    makeResponder: (env) => createResponder({ ...env, client: { beta: { messages: { create } } } as unknown as AgentClient }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id);
  await world.settled();
  const group = (await store.groupByProviderId("simulator", s.groupId))!;
  const say = async (who: Who, message: string) => {
    world.say(s.users[who].id, s.groupId, message, { mentionNod: message.includes("@Nod") });
    await world.settled();
  };
  const nodInGroup = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1).map((l) => l.text);
  const dms = (who: Who) => world.dmTranscript(s.users[who].id).filter((l) => l.from === "nod").map((l) => l.text);
  const decision = async () => (await store.listDecisions(group.id))[0]!;
  const answers = async () => {
    const d = await decision();
    const out: Record<string, number[]> = {};
    for (const r of await store.datePollResponses(d.id)) {
      const u = await store.getUser(r.userId);
      out[u!.name!.toLowerCase()] = r.positions;
    }
    return out;
  };
  const advanceTo = async (iso: string) => {
    clock = new Date(iso);
    await scheduler.runDue(clock, nod.runJob);
    await world.settled();
  };
  const lastToolResult = () => {
    const msgs = requests.at(-1).messages;
    return msgs[msgs.length - 1].content[0].content as string;
  };
  return { world, store, scheduler, s, group, say, nodInGroup, dms, decision, answers, advanceTo, lastToolResult, requests, create };
}

describe("run_date_poll", () => {
  it("posts the numbered dates and schedules the nudge and deadline", async () => {
    const ctx = await setup(poll());
    await ctx.say("will", "@Nod when can everyone do Tulum? March 7-11, 14-18 or 21-25");
    expect(ctx.nodInGroup()).toEqual([
      "Date poll: When works for Tulum?\n1. Mar 7–11\n2. Mar 14–18\n3. Mar 21–25\nReply with every number that works for you (like “1 3”), “all” or “none”. Closes Thu, Oct 1, 11:00 AM.",
    ]);
    expect(await ctx.decision()).toMatchObject({ kind: "date_poll", status: "open", question: "When works for Tulum?" });
    expect(ctx.scheduler.pending().map((j) => [j.runAt.toISOString(), j.job.type])).toEqual([
      ["2026-10-01T12:00:00.000Z", "nudge"],
      ["2026-10-01T15:00:00.000Z", "deadline"],
    ]);
  });

  it.each([
    [{ choices: [MARCH[0]] }, /2 to 6 choices/],
    [{ choices: [{ starts_on: "2026-09-01" }, MARCH[0]] }, /already passed/],
    [{ choices: [MARCH[0], MARCH[0]] }, /same dates/],
    [{ choices: [{ starts_on: "March 7" }, MARCH[0]] }, /like 2027-03-14/],
    [{ choices: [{ starts_on: "2027-03-10", ends_on: "2027-03-07" }, MARCH[0]] }, /end after it starts/],
    [{ hours: 24 * 20 }, /at most 14 days/],
  ])("refuses %j", async (extra, error) => {
    const ctx = await setup(call("run_date_poll", { choices: MARCH, ...extra }, "Can't."));
    await ctx.say("will", "@Nod date poll");
    expect(ctx.lastToolResult()).toMatch(error);
    expect(await ctx.store.listDecisions(ctx.group.id)).toEqual([]);
  });

  it("keeps a vote and a date poll from running at once, and numbers during a poll aren't votes", async () => {
    const ids: string[] = [];
    const ctx = await setup([...poll(), ...call("start_vote", () => ({ option_ids: ids }), "A poll is open.")]);
    for (const n of [1, 2]) {
      const { option } = await ctx.store.upsertOption({ groupId: ctx.group.id, kind: "rental", source: "link", url: `https://airbnb.com/rooms/${n}`, postedByUserId: null, providerMessageId: null });
      ids.push(option.id);
    }
    await ctx.say("will", "@Nod when can everyone do Tulum?");
    await ctx.say("jake", "@Nod start a vote on the two rentals");
    expect(ctx.lastToolResult()).toMatch(/A date poll is already open: “When works for Tulum\?”/);
    await ctx.say("mike", "2");
    expect(await ctx.answers()).toEqual({ mike: [2] });
  });
});

describe("answering", () => {
  it("reads a first \"can't do 1\" as the other dates working", async () => {
    const ctx = await setup(poll());
    await ctx.say("will", "@Nod when can everyone do Tulum?");
    await ctx.say("mike", "can't do 1");
    expect(await ctx.answers()).toEqual({ mike: [2, 3] });
  });

  it("counts replies silently: sets, all, additions and removals", async () => {
    const ctx = await setup(poll());
    await ctx.say("will", "@Nod when can everyone do Tulum?");
    await ctx.say("jake", "1 and 3");
    await ctx.say("sarah", "all work");
    await ctx.say("jake", "can't do 1");
    await ctx.say("sarah", "lol nice");
    expect(await ctx.answers()).toEqual({ jake: [3], sarah: [1, 2, 3] });
    expect(ctx.nodInGroup()).toHaveLength(1);
    expect(ctx.requests).toHaveLength(2);
  });

  it("closes as soon as everyone has answered", async () => {
    const ctx = await setup(poll());
    await ctx.say("will", "@Nod when can everyone do Tulum?");
    await ctx.say("will", "2 3");
    await ctx.say("jake", "2");
    await ctx.say("sarah", "1 2");
    await ctx.say("mike", "all");
    expect(ctx.nodInGroup().at(-1)).toBe("Everyone's answered. Dates: Mar 14–18 works for everyone.");
    expect((await ctx.decision()).status).toBe("decided");
    // Late replies change nothing.
    await ctx.say("jake", "3");
    expect(ctx.nodInGroup()).toHaveLength(2);
  });

  it("reminds people who haven't answered privately, and takes their private reply", async () => {
    const ctx = await setup([...poll(), reply([text("Hi.")]), ...call("answer_date_poll", (b) => ({ decision_id: /\[date poll ([^\]]+)\]/.exec(String(b.messages[0].content))![1], mode: "set", positions: [2] }), "Got it.")]);
    await ctx.say("will", "@Nod when can everyone do Tulum?");
    await ctx.say("will", "2");
    await ctx.say("jake", "1 2");
    await ctx.advanceTo("2026-10-01T12:00:00Z");
    expect(ctx.dms("mike").at(-1)).toBe(
      "Tulum 🌴 is picking dates: “When works for Tulum?” 1. Mar 7–11, 2. Mar 14–18, 3. Mar 21–25. Reply here with every number that works for you, or “none”. Closes Thu, Oct 1, 11:00 AM.",
    );
    expect(ctx.dms("jake").some((t) => /picking dates/.test(t))).toBe(false);
    ctx.world.dm(ctx.s.users.mike.id, "hey"); // first private message: personal setup
    await ctx.world.settled();
    ctx.world.dm(ctx.s.users.mike.id, "2 works");
    await ctx.world.settled();
    expect((await ctx.answers()).mike).toEqual([2]);
  });
});

describe("results", () => {
  it("posts the best dates at the deadline, naming who can't and who didn't answer", async () => {
    const ctx = await setup(poll());
    await ctx.say("will", "@Nod when can everyone do Tulum?");
    await ctx.say("will", "2 3");
    await ctx.say("sarah", "2");
    await ctx.say("mike", "1");
    await ctx.advanceTo("2026-10-01T15:00:00Z");
    expect(ctx.nodInGroup().at(-1)).toBe("Dates: Mar 14–18 works for 2 of 4. Mike can't make it. No answer from Jake.");
    const chosen = (await ctx.store.datePollChoices((await ctx.decision()).id)).find((c) => c.chosen);
    expect(chosen).toMatchObject({ position: 2, startsOn: "2027-03-14", endsOn: "2027-03-18" });
  });

  it("breaks ties with the earlier dates", async () => {
    const ctx = await setup([...poll(), ...call("close_date_poll", {})]);
    await ctx.say("will", "@Nod when can everyone do Tulum?");
    await ctx.say("will", "3");
    await ctx.say("jake", "1");
    await ctx.say("sarah", "@Nod close the poll");
    expect(ctx.nodInGroup().at(-1)).toMatch(/^Dates: Mar 7–11 works for 1 of 4\./);
  });

  it("says so when nothing works, or nobody answered", async () => {
    const ctx = await setup(poll());
    await ctx.say("will", "@Nod when can everyone do Tulum?");
    await ctx.say("jake", "none");
    await ctx.advanceTo("2026-10-01T15:00:00Z");
    expect(ctx.nodInGroup().at(-1)).toBe("None of those dates work for anyone who answered “When works for Tulum?”. Try another set any time.");
    expect((await ctx.decision()).status).toBe("cancelled");

    const quiet = await setup(poll());
    await quiet.say("will", "@Nod when can everyone do Tulum?");
    await quiet.advanceTo("2026-10-01T15:00:00Z");
    expect(quiet.nodInGroup().at(-1)).toBe("The date poll “When works for Tulum?” closed with no answers.");
  });

  it("gives Claude the chosen dates afterwards, for searches and bookings", async () => {
    const ctx = await setup([...poll(), reply([text("Looking.")])]);
    await ctx.say("will", "@Nod when can everyone do Tulum?");
    for (const who of ["will", "jake", "sarah", "mike"] as Who[]) await ctx.say(who, "2");
    await ctx.say("will", "@Nod find us a place to stay");
    expect(String(ctx.requests.at(-1).messages[0].content)).toMatch(
      /From the date poll “When works for Tulum\?”: Mar 14–18 \(starts_on 2027-03-14, ends_on 2027-03-18\)\. Use these dates/,
    );
  });

  it("can be cancelled", async () => {
    const ctx = await setup([...poll(), ...call("cancel_date_poll", {}, "Cancelled.")]);
    await ctx.say("will", "@Nod when can everyone do Tulum?");
    await ctx.say("will", "@Nod cancel the date poll");
    expect((await ctx.decision()).status).toBe("cancelled");
    await ctx.advanceTo("2026-10-01T15:00:00Z");
    expect(ctx.nodInGroup().at(-1)).toBe("Cancelled.");
  });
});
