import { describe, expect, it, vi } from "vitest";
import { createResponder, type AgentClient } from "../agent/responder";
import { MemoryStore } from "../db/memory-store";
import { MemoryScheduler } from "../jobs/scheduler";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import { createNod } from "../nod";
import { FakeGateway } from "../payments/fake-gateway";
import { canSetOrganizer } from "./notes";

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });
type Scripted = ReturnType<typeof reply> | ((body: any) => ReturnType<typeof reply>);
const call = (name: string, input: Record<string, unknown> | ((body: any) => Record<string, unknown>), after = "Done."): Scripted[] => [
  (body) => reply([toolUse("t", name, typeof input === "function" ? input(body) : input)], "tool_use"),
  reply(after ? [text(after)] : []),
];
type Who = "will" | "jake" | "sarah" | "mike";

describe("canSetOrganizer", () => {
  const members = ["will", "sarah", "jake"];
  it("lets the current organizer hand it over, and nobody else", () => {
    expect(canSetOrganizer({ organizerUserId: "will", addedByUserId: "sarah" }, members, "will")).toBe(true);
    expect(canSetOrganizer({ organizerUserId: "will", addedByUserId: "sarah" }, members, "sarah")).toBe(false);
  });
  it("falls back to whoever added Nod when no organizer is set", () => {
    expect(canSetOrganizer({ organizerUserId: null, addedByUserId: "sarah" }, members, "sarah")).toBe(true);
    expect(canSetOrganizer({ organizerUserId: null, addedByUserId: "sarah" }, members, "jake")).toBe(false);
  });
  it("lets anyone set it when neither is still in the group", () => {
    expect(canSetOrganizer({ organizerUserId: "gone", addedByUserId: "also-gone" }, members, "jake")).toBe(true);
    expect(canSetOrganizer({ organizerUserId: null, addedByUserId: null }, members, "jake")).toBe(true);
  });
});

async function setup(responses: Scripted[], opts: { payments?: boolean } = {}) {
  const now = () => new Date("2026-09-29T15:00:00Z");
  const world = new ChatWorld({ now });
  const store = new MemoryStore({ now });
  const gateway = new FakeGateway();
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
    config: { howToVideoUrl: "https://nod.test/v.mp4", appUrl: "https://nod.test", timezone: "America/New_York" },
    scheduler: new MemoryScheduler(),
    ...(opts.payments ? { paymentGateway: gateway } : {}),
    now,
    makeResponder: (env) => createResponder({ ...env, client: { beta: { messages: { create } } } as unknown as AgentClient }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id); // Sarah added Nod
  await world.settled();
  const group = (await store.groupByProviderId("simulator", s.groupId))!;
  const idOf = async (who: Who) => (await store.upsertUser(world.user(s.users[who].id)!.phone)).id;
  const say = async (who: Who, message: string) => {
    world.say(s.users[who].id, s.groupId, message, { mentionNod: message.includes("@Nod") });
    await world.settled();
  };
  const lastToolResult = () => {
    const msgs = requests.at(-1).messages;
    return msgs[msgs.length - 1].content[0].content as string;
  };
  const nodLines = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1).map((l) => l.text);
  return { world, store, gateway, s, group, idOf, say, lastToolResult, nodLines, requests };
}

describe("set_organizer", () => {
  it("lets whoever added Nod name the organizer, then only the organizer can hand it on", async () => {
    const ctx = await setup([
      ...call("set_organizer", { member: "Will" }, "Will's the organizer."),
      ...call("set_organizer", { member: "Jake" }, "Can't."),
      ...call("set_organizer", { member: "Jake" }, "Jake's the organizer."),
    ]);
    await ctx.say("sarah", "@Nod make Will the organizer");
    expect((await ctx.store.getGroup(ctx.group.id))?.organizerUserId).toBe(await ctx.idOf("will"));
    await ctx.say("sarah", "@Nod actually make Jake the organizer");
    expect(ctx.lastToolResult()).toMatch(/Only Will can hand over the organizer role/);
    await ctx.say("will", "@Nod make Jake the organizer");
    expect((await ctx.store.getGroup(ctx.group.id))?.organizerUserId).toBe(await ctx.idOf("jake"));
  });

  it("makes the organizer the one who approves spending", async () => {
    const ctx = await setup(
      [...call("set_organizer", { member: "Will" }), ...call("request_payments", { description: "Boat", amount_per_person_cents: 5000, payers: ["Mike"] }, "")],
      { payments: true },
    );
    const jake = await ctx.idOf("jake");
    await ctx.store.setStripeAccount(jake, "acct_jake");
    ctx.gateway.completeOnboarding("acct_jake");
    await ctx.store.setStripeAccountReady("acct_jake", true);
    await ctx.say("sarah", "@Nod make Will the organizer");
    await ctx.say("jake", "@Nod collect $50 from Mike for the boat");
    expect(ctx.nodLines().at(-1)).toMatch(/Will, reply yes or tap 👍 to approve the charge\.$/);
  });

  it("shows Claude who the organizer is", async () => {
    const ctx = await setup([reply([text("ok")]), ...call("set_organizer", { member: "Will" }), reply([text("ok")])]);
    await ctx.say("jake", "@Nod who approves spending?");
    expect(String(ctx.requests.at(-1).messages[0].content)).toMatch(/No organizer set; Sarah approves spending by default/);
    await ctx.say("sarah", "@Nod make Will the organizer");
    await ctx.say("jake", "@Nod who approves spending?");
    expect(String(ctx.requests.at(-1).messages[0].content)).toMatch(/Organizer \(approves spending\): Will\./);
  });
});

describe("group notes", () => {
  it("keeps must-haves and preferences apart, and tells Claude never to filter on preferences", async () => {
    const ctx = await setup([
      ...call("remember_group_note", { note: "vegetarian", about: "Mike", kind: "must_have" }, "Got it."),
      ...call("remember_group_note", { note: "doesn't love steak", about: "Sarah", kind: "preference" }, "Got it."),
      ...call("remember_group_note", { note: "vegetarian", about: "Mike", kind: "must_have" }, "Already have it."),
      reply([text("ok")]),
    ]);
    await ctx.say("will", "@Nod remember Mike's vegetarian");
    await ctx.say("will", "@Nod Sarah doesn't love steak, keep that in mind");
    await ctx.say("jake", "@Nod remember Mike's vegetarian");
    expect(ctx.lastToolResult()).toBe("Already saved: Mike: vegetarian.");
    await ctx.say("will", "@Nod find dinner");
    const context = String(ctx.requests.at(-1).messages[0].content);
    expect(context).toMatch(/Must-haves \(make sure there's an option that works for them; never drop a place over these\):\n\[note [^\]]+\] Mike: vegetarian/);
    expect(context).toMatch(/Preferences \(context only; never exclude anything because of these, at most mention them when useful\):\n\[note [^\]]+\] Sarah: doesn't love steak/);
    expect(String(ctx.requests.at(-1).system?.[0]?.text ?? ctx.requests.at(-1).system)).toMatch(/never exclude a place or cuisine because of one/);
  });

  it("deletes a note when asked", async () => {
    const ctx = await setup([
      ...call("remember_group_note", { note: "on a budget", kind: "preference" }),
      ...call("forget_group_note", (b) => ({ note_id: /\[note ([^\]]+)\]/.exec(String(b.messages[0].content))![1] }), "Deleted."),
    ]);
    await ctx.say("will", "@Nod remember we're on a budget");
    await ctx.say("mike", "@Nod forget the budget note");
    expect(await ctx.store.listGroupNotes(ctx.group.id)).toEqual([]);
  });

  it("only saves notes in the group chat", async () => {
    const ctx = await setup([reply([text("Hi.")]), ...call("remember_group_note", { note: "vegetarian", kind: "must_have" }, "Ask in the group.")]);
    ctx.world.dm(ctx.s.users.mike.id, "hi");
    await ctx.world.settled();
    ctx.world.dm(ctx.s.users.mike.id, "remember I'm vegetarian");
    await ctx.world.settled();
    expect(ctx.lastToolResult()).toMatch(/for the group chat/);
  });
});

describe("forget this chat", () => {
  it("deletes stored messages and notes, keeps the tab, and Claude no longer sees the old conversation", async () => {
    const ctx = await setup([
      ...call("remember_group_note", { note: "vegetarian", about: "Mike", kind: "must_have" }),
      ...call("record_expense", { description: "Gas", amount_cents: 6000 }),
      ...call("forget_chat", {}, "Done: I deleted what I'd saved from this chat. The tab is kept."),
      reply([text("ok")]),
    ]);
    await ctx.say("will", "@Nod remember Mike's vegetarian");
    await ctx.say("jake", "the secret beach is past the second gate");
    await ctx.say("will", "@Nod I paid $60 for gas");
    await ctx.say("mike", "@Nod forget this chat");
    expect(ctx.lastToolResult()).toMatch(/^Deleted \d+ stored messages and 1 note\. The tab, bookings and payments are kept\.$/);
    expect(await ctx.store.listGroupNotes(ctx.group.id)).toEqual([]);
    expect((await ctx.store.listLedger(ctx.group.id))).toHaveLength(1);

    await ctx.say("sarah", "@Nod what did Jake say about the beach?");
    const context = String(ctx.requests.at(-1).messages[0].content);
    expect(context).not.toMatch(/secret beach/);
    expect(context).not.toMatch(/vegetarian/);
  });
});
