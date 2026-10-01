import { describe, expect, it, vi } from "vitest";
import { createResponder, type AgentClient } from "../agent/responder";
import { MemoryStore } from "../db/memory-store";
import { MemoryScheduler } from "../jobs/scheduler";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import type { Tapback } from "../messaging/types";
import { createNod } from "../nod";
import { FakeGateway } from "./fake-gateway";

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

async function setup(responses: Scripted[], opts: { payeeReady?: boolean } = {}) {
  let clock = new Date("2026-09-29T15:00:00Z"); // Tue 11:00 AM in New York
  const now = () => clock;
  const world = new ChatWorld({ now });
  const store = new MemoryStore({ now });
  const scheduler = new MemoryScheduler();
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
    scheduler,
    paymentGateway: gateway,
    now,
    makeResponder: (env) => createResponder({ ...env, client: { beta: { messages: { create } } } as unknown as AgentClient }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id); // Sarah added Nod, so she's the default approver
  await world.settled();
  const group = (await store.groupByProviderId("simulator", s.groupId))!;
  const userOf = async (who: Who) => await store.upsertUser(world.user(s.users[who].id)!.phone);
  if (opts.payeeReady !== false) {
    const will = await userOf("will");
    await store.setStripeAccount(will.id, "acct_will");
    gateway.completeOnboarding("acct_will");
    await store.setStripeAccountReady("acct_will", true);
  }
  const say = async (who: Who, message: string) => {
    world.say(s.users[who].id, s.groupId, message, { mentionNod: message.includes("@Nod") });
    await world.settled();
  };
  const react = async (who: Who, messageId: string, tapback: Tapback, removed = false) => {
    world.react(s.users[who].id, messageId, tapback, { removed });
    await world.settled();
  };
  const collection = async () => (await store.listCollections(group.id))[0]!;
  const requestOf = async (who: Who) => {
    const u = await userOf(who);
    return (await store.paymentRequests((await collection()).id)).find((r) => r.userId === u.id)!;
  };
  /** What the pay page does: create the hold, the payer confirms their card, Stripe tells us. */
  const pay = async (who: Who) => {
    const r = await requestOf(who);
    const started = await nod.payments!.startPayment(r.token);
    if (!("clientSecret" in started)) throw new Error(`can't pay: ${started.state}`);
    const intentId = (await store.getPaymentRequest(r.id))!.stripePaymentIntentId!;
    gateway.authorize(intentId);
    await nod.payments!.syncIntent(intentId);
    await world.settled();
    return intentId;
  };
  const nodInGroup = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1).map((l) => l.text);
  const dms = (who: Who) => world.dmTranscript(s.users[who].id).filter((l) => l.from === "nod").map((l) => l.text);
  /** The pay card Nod sent someone last: their last private message must be a card that opens their pay page. */
  const payCard = async (who: Who) => {
    const line = dms(who).at(-1)!;
    expect(line).toMatch(/^https:\/\/nod\.test\/o\/[A-Za-z0-9]{12}$/);
    return (await store.getCard(line.split("/o/")[1]!))!;
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
  return { payCard, world, store, scheduler, gateway, nod, s, group, say, react, collection, requestOf, pay, nodInGroup, dms, advanceTo, userOf, lastToolResult, create, requests };
}

const collect150 = () => call("request_payments", { description: "Casa Azul", amount_per_person_cents: 15000 });

describe("request_payments", () => {
  it("posts the amount to the group and sends each payer a private link", async () => {
    const ctx = await setup(collect150());
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");

    expect(ctx.nodInGroup()).toEqual([
      "Collecting $150 each from Jake, Sarah and Mike for Casa Azul, paid to Will. Cards are only held for now and charged once everyone has paid, by Thu, Oct 1, 11:00 AM. I've sent each of you a private link.",
    ]);
    const jake = await ctx.requestOf("jake");
    expect(ctx.dms("jake").at(-2)).toBe(
      "Will is collecting $150 from you for Casa Azul (Tulum 🌴). Your card is only held until everyone has paid, then charged. Pay by Thu, Oct 1, 11:00 AM.",
    );
    // Then the "Pay Will" card, which opens Jake's private pay page.
    const card = await ctx.payCard("jake");
    expect(card.targetUrl).toBe(`https://nod.test/pay/${jake.token}`);
    expect(card.data).toMatchObject({ source: "Pay Will", title: "Casa Azul", price: "$150", footer: "Due Thu, Oct 1, 11:00 AM" });
    expect(jake.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(ctx.dms("will").some((t) => /collecting/.test(t))).toBe(false);
    const c = await ctx.collection();
    expect(c).toMatchObject({ status: "collecting", approval: { kind: "one_of" }, messageId: expect.any(String) });
    expect(ctx.scheduler.pending().map((j) => [j.runAt.toISOString(), j.job.type])).toEqual([
      ["2026-09-30T15:00:00.000Z", "collection_reminder"],
      ["2026-10-01T15:00:00.000Z", "collection_deadline"],
    ]);
  });

  it("splits a total evenly, counting the requester's own share", async () => {
    const ctx = await setup(call("request_payments", { description: "Dinner", total_cents: 40_000 }));
    await ctx.say("will", "@Nod split $400 for dinner four ways");
    expect((await ctx.store.paymentRequests((await ctx.collection()).id)).map((r) => r.amountCents)).toEqual([10_000, 10_000, 10_000]);
  });

  it("collects only from the people named", async () => {
    const ctx = await setup(call("request_payments", { description: "Tickets", amount_per_person_cents: 4000, payers: ["Jake", "Mike", "Will"] }));
    await ctx.say("will", "@Nod collect $40 from Jake and Mike for tickets");
    const payers = (await ctx.store.paymentRequests((await ctx.collection()).id)).map((r) => r.userId);
    expect(payers.sort()).toEqual([(await ctx.userOf("jake")).id, (await ctx.userOf("mike")).id].sort());
  });

  it.each([
    [{ description: "X", amount_per_person_cents: 1000, total_cents: 3000 }, /either amount_per_person_cents or total_cents/],
    [{ description: "X", amount_per_person_cents: 50 }, /at least \$1/],
    [{ description: "X", amount_per_person_cents: 1000, hours: 24 * 7 }, /at most 6 days/],
    [{ description: "X", amount_per_person_cents: 1000, hours: 0.5 }, /at least an hour/],
  ])("refuses %j", async (input, error) => {
    const ctx = await setup(call("request_payments", input, "Can't."));
    await ctx.say("will", "@Nod collect");
    expect(ctx.lastToolResult()).toMatch(error);
    expect(await ctx.store.listCollections(ctx.group.id)).toEqual([]);
  });
});

describe("holding and charging cards", () => {
  it("holds each card as people pay and charges nobody until everyone has", async () => {
    const ctx = await setup(collect150());
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    await ctx.pay("jake");
    await ctx.pay("sarah");
    expect(ctx.gateway.captured).toEqual([]);
    expect((await ctx.requestOf("jake")).status).toBe("authorized");

    await ctx.pay("mike");
    expect(ctx.gateway.captured).toHaveLength(3);
    expect((await ctx.store.paymentRequests((await ctx.collection()).id)).map((r) => r.status)).toEqual(["captured", "captured", "captured"]);
    expect((await ctx.collection()).status).toBe("captured");
    expect(ctx.nodInGroup().at(-1)).toBe("Everyone's paid for Casa Azul: $450 charged and paid to Will.");
  });

  it("reuses the same hold when someone opens their link twice", async () => {
    const ctx = await setup(collect150());
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    const r = await ctx.requestOf("jake");
    const a = await ctx.nod.payments!.startPayment(r.token);
    const b = await ctx.nod.payments!.startPayment(r.token);
    expect(a).toEqual(b);
    expect(ctx.gateway.intents.size).toBe(1);
    expect(a).toMatchObject({ publishableKey: "pk_test_sample", accountId: "acct_will" });
  });

  it("charges once even when Stripe reports the same hold twice at once", async () => {
    const ctx = await setup(collect150());
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    await ctx.pay("jake");
    await ctx.pay("sarah");
    const r = await ctx.requestOf("mike");
    await ctx.nod.payments!.startPayment(r.token);
    const intentId = (await ctx.store.getPaymentRequest(r.id))!.stripePaymentIntentId!;
    ctx.gateway.authorize(intentId);
    await Promise.all([ctx.nod.payments!.syncIntent(intentId), ctx.nod.payments!.syncIntent(intentId)]);
    await ctx.world.settled();
    expect(ctx.gateway.captured).toHaveLength(3);
    expect(ctx.nodInGroup().filter((t) => t.startsWith("Everyone's paid"))).toHaveLength(1);
  });

  it("waits for the organizer's approval when they aren't paying", async () => {
    const ctx = await setup(call("request_payments", { description: "Boat", amount_per_person_cents: 5000, payers: ["Jake", "Mike"] }));
    await ctx.say("will", "@Nod collect $50 from Jake and Mike for the boat");
    expect(ctx.nodInGroup()[0]).toMatch(/Sarah, reply yes or tap 👍 to approve the charge\.$/);
    await ctx.pay("jake");
    await ctx.pay("mike");
    expect(ctx.gateway.captured).toEqual([]);

    await ctx.react("sarah", (await ctx.collection()).messageId!, "like");
    expect(ctx.gateway.captured).toHaveLength(2);
    expect((await ctx.collection()).status).toBe("captured");
  });

  it("needs three approvals over $200 a person, and paying counts as one", async () => {
    const ctx = await setup(call("request_payments", { description: "Villa", amount_per_person_cents: 30_000, payers: ["Jake"] }));
    await ctx.say("will", "@Nod collect $300 from Jake for the villa");
    expect(ctx.nodInGroup()[0]).toMatch(/3 people need to approve: paying counts, or tap 👍 or reply “@Nod yes”\.$/);
    await ctx.pay("jake"); // Will (asking) + Jake (paying) = 2 of 3
    expect(ctx.gateway.captured).toEqual([]);
    await ctx.react("mike", (await ctx.collection()).messageId!, "love");
    expect(ctx.gateway.captured).toHaveLength(1);
  });

  it("asks a declined payer privately to pay again, and charges them once they do", async () => {
    const ctx = await setup(collect150());
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    await ctx.pay("jake");
    await ctx.pay("sarah");
    // Mike pays, but his card is declined at capture.
    const r = await ctx.requestOf("mike");
    await ctx.nod.payments!.startPayment(r.token);
    const intentId = (await ctx.store.getPaymentRequest(r.id))!.stripePaymentIntentId!;
    ctx.gateway.declineCapture.add(intentId);
    ctx.gateway.authorize(intentId);
    await ctx.nod.payments!.syncIntent(intentId);
    await ctx.world.settled();

    expect((await ctx.requestOf("mike")).status).toBe("failed");
    expect(ctx.dms("mike").at(-2)).toBe("Your card was declined for the $150 to Will for Casa Azul. Please pay again.");
    expect((await ctx.payCard("mike")).targetUrl).toMatch(/^https:\/\/nod\.test\/pay\//);
    expect(ctx.dms("will").at(-1)).toBe("Mike's card was declined for Casa Azul. I've asked them privately to pay again.");
    expect(ctx.nodInGroup().some((t) => /declined|Mike/.test(t) && !t.startsWith("Collecting"))).toBe(false);
    expect((await ctx.collection()).status).toBe("collecting");

    await ctx.pay("mike");
    expect((await ctx.collection()).status).toBe("captured");
    expect(ctx.nodInGroup().at(-1)).toBe("Everyone's paid for Casa Azul: $450 charged and paid to Will.");
  });

  it("asks someone to pay again when their hold lapses", async () => {
    const ctx = await setup(collect150());
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    const first = await ctx.pay("jake");
    ctx.gateway.expire(first);
    await ctx.nod.payments!.syncIntent(first);
    await ctx.world.settled();
    const r = await ctx.requestOf("jake");
    expect(r).toMatchObject({ status: "pending", stripePaymentIntentId: null, attempt: 1 });
    expect(ctx.dms("jake").at(-2)).toBe("The hold on your card for Casa Azul lapsed, so nothing was charged. Please pay again.");
    expect((await ctx.payCard("jake")).targetUrl).toMatch(/\/pay\//);
    const second = await ctx.pay("jake");
    expect(second).not.toBe(first);
  });
});

describe("deadlines and reminders", () => {
  it("privately reminds only the people who haven't paid, once", async () => {
    const ctx = await setup(collect150());
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    await ctx.pay("jake");
    await ctx.advanceTo("2026-09-30T15:00:00Z");
    expect(ctx.dms("sarah").at(-2)).toBe("Reminder: $150 to Will for Casa Azul, due Thu, Oct 1, 11:00 AM. Your card is only held until everyone has paid.");
    expect((await ctx.payCard("sarah")).targetUrl).toMatch(/^https:\/\/nod\.test\/pay\//);
    expect(ctx.dms("jake").some((t) => t.startsWith("Reminder"))).toBe(false);
    await ctx.nod.runJob({ type: "collection_reminder", collectionId: (await ctx.collection()).id });
    expect(ctx.dms("sarah").filter((t) => t.startsWith("Reminder"))).toHaveLength(1);
  });

  it("releases every hold at the deadline if not everyone paid, without naming anyone in the group", async () => {
    const ctx = await setup(collect150());
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    const jake = await ctx.pay("jake");
    const sarah = await ctx.pay("sarah");
    await ctx.advanceTo("2026-10-01T15:00:00Z");

    expect(ctx.gateway.captured).toEqual([]);
    expect(ctx.gateway.cancelled.sort()).toEqual([jake, sarah].sort());
    expect((await ctx.collection()).status).toBe("expired");
    expect(ctx.nodInGroup().at(-1)).toBe("Time's up for Casa Azul: 2 of 3 paid, so nobody was charged and the holds are released.");
    expect(ctx.dms("will").at(-1)).toBe("Not paid for Casa Azul: Mike.");
  });

  it("releases a hold made after the collection closed", async () => {
    const ctx = await setup(collect150());
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    const r = await ctx.requestOf("mike");
    await ctx.nod.payments!.startPayment(r.token);
    const intentId = (await ctx.store.getPaymentRequest(r.id))!.stripePaymentIntentId!;
    await ctx.advanceTo("2026-10-01T15:00:00Z");
    ctx.gateway.authorize(intentId);
    await ctx.nod.payments!.syncIntent(intentId);
    expect(ctx.gateway.intents.get(intentId)!.status).toBe("canceled");
    expect(ctx.gateway.captured).toEqual([]);
  });
});

describe("payout setup", () => {
  it("waits for the payee to set up payouts, then sends everyone their link", async () => {
    const ctx = await setup(collect150(), { payeeReady: false });
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    expect(ctx.nodInGroup()[0]).toBe(
      "Collecting $150 each from Jake, Sarah and Mike for Casa Azul, paid to Will. Will needs to set up payouts first (I sent a private link), then pay links go out. Cards are charged only once everyone has paid.",
    );
    expect((await ctx.collection()).status).toBe("setup");
    const setupDm = ctx.dms("will").at(-1)!;
    expect(setupDm).toMatch(/^To collect \$450 for Casa Azul, set up payouts with Stripe .*: https:\/\/nod\.test\/connect\/[A-Za-z0-9_-]+$/);
    expect(ctx.dms("jake").some((t) => /collecting/.test(t))).toBe(false);
    const token = setupDm.split("/connect/")[1]!;

    const first = await ctx.nod.payments!.payoutSetup(token);
    expect(first).toEqual({ redirect: expect.stringMatching(/^https:\/\/connect\.sample\/onboard\/acct_sample_/) });
    const accountId = (await ctx.userOf("will")).stripeAccountId!;
    ctx.gateway.completeOnboarding(accountId);
    expect(await ctx.nod.payments!.payoutSetup(token, { returning: true })).toEqual({ ready: true });
    await ctx.world.settled();

    expect((await ctx.collection()).status).toBe("collecting");
    expect(ctx.dms("jake").at(-2)).toMatch(/^Will is collecting \$150 from you for Casa Azul/);
    expect(ctx.nodInGroup().at(-1)).toBe("Will is set up for payouts, so I've sent everyone their pay link for Casa Azul.");
    expect(await ctx.nod.payments!.payoutSetup("wrong")).toBeNull();
  });

  it("expires at the deadline if payouts never get set up", async () => {
    const ctx = await setup(collect150(), { payeeReady: false });
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    await ctx.advanceTo("2026-10-01T15:00:00Z");
    expect((await ctx.collection()).status).toBe("expired");
    expect(ctx.nodInGroup().at(-1)).toBe("Time's up for Casa Azul: payouts weren't set up in time, so nobody was charged.");
  });
});

describe("cancelling, pay pages and context", () => {
  it("lets only the payee cancel, and releases the holds", async () => {
    const ctx = await setup([...collect150(), ...call("cancel_payments", {}, "No."), ...call("cancel_payments", {}, "Cancelled.")]);
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    const held = await ctx.pay("jake");
    await ctx.say("mike", "@Nod cancel the Casa Azul collection");
    expect(ctx.lastToolResult()).toMatch(/Only the person collecting the money can cancel it/);
    await ctx.say("will", "@Nod cancel it");
    expect(ctx.lastToolResult()).toBe("Cancelled the Casa Azul collection. Nobody was charged and every hold is released.");
    expect(ctx.gateway.cancelled).toEqual([held]);
    expect((await ctx.collection()).status).toBe("cancelled");
  });

  it("shows the pay page's state as it changes", async () => {
    const ctx = await setup(collect150());
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    const token = (await ctx.requestOf("jake")).token;
    expect(await ctx.nod.payments!.payPage(token)).toEqual({
      description: "Casa Azul", amountCents: 15000, currency: "USD", payeeName: "Will", groupName: "Tulum 🌴", deadline: "Thu, Oct 1, 11:00 AM", state: "pay",
    });
    // Back from Stripe before the webhook: the page checks the hold itself.
    await ctx.nod.payments!.startPayment(token);
    ctx.gateway.authorize((await ctx.requestOf("jake")).stripePaymentIntentId!);
    expect((await ctx.nod.payments!.payPage(token))?.state).toBe("held");
    await ctx.pay("sarah");
    await ctx.pay("mike");
    expect((await ctx.nod.payments!.payPage(token))?.state).toBe("paid");
    expect(await ctx.nod.payments!.payPage("not-a-token")).toBeNull();
  });

  it("keeps who hasn't paid out of the group's context, but tells the payee privately", async () => {
    const ctx = await setup([...collect150(), reply([text("2 of 3 so far.")])]);
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    await ctx.pay("jake");
    await ctx.pay("sarah");
    await ctx.say("jake", "@Nod has everyone paid?");
    const groupContext = String(ctx.requests.at(-1).messages[0].content);
    expect(groupContext).toMatch(/Casa Azul · \$150 each from 3 · paid to Will · 2 of 3 paid/);
    expect(groupContext).toMatch(/Never say in the group who hasn't paid/);
    expect(groupContext).not.toMatch(/Not paid yet/);

    ctx.create.mockImplementationOnce(async (body: any) => {
      ctx.requests.push(structuredClone(body));
      return reply([text("Mike hasn't paid yet.")]);
    });
    ctx.world.dm(ctx.s.users.will.id, "who hasn't paid?");
    await ctx.world.settled();
    expect(String(ctx.requests.at(-1).messages[0].content)).toMatch(/Not paid yet: Mike\./);
  });

  it("re-sends someone's pay link privately when they ask in the group", async () => {
    const ctx = await setup([...collect150(), ...call("resend_pay_link", {}, "Sent it to you privately.")]);
    await ctx.say("will", "@Nod collect $150 each for Casa Azul");
    const before = ctx.dms("mike").length;
    await ctx.say("mike", "@Nod send me my pay link");
    expect(ctx.dms("mike")).toHaveLength(before + 2); // the note, then the pay card
    expect(ctx.nodInGroup().at(-1)).toBe("Sent it to you privately.");
  });
});

describe("without a payment gateway", () => {
  it("doesn't offer the payment tools", async () => {
    const world = new ChatWorld();
    const store = new MemoryStore();
    const create = vi.fn(async () => reply([text("ok")]));
    const nod = createNod({
      store,
      provider: world.provider(),
      classify: async () => true,
      logger: silentLogger,
      config: { howToVideoUrl: "https://nod.test/v.mp4" },
      makeResponder: (env) => createResponder({ ...env, client: { beta: { messages: { create } } } as unknown as AgentClient }),
    });
    world.provider().onInbound((e) => nod.handle(e).then(() => {}));
    const s = seedTulumGroup(world);
    await registerWorldPeople(world, store, { access: "active" });
    world.addNod(s.groupId, s.users.sarah.id);
    await world.settled();
    world.say(s.users.will.id, s.groupId, "@Nod hi", { mentionNod: true });
    await world.settled();
    expect((create.mock.calls[0] as any[])[0].tools.map((t: { name: string }) => t.name)).not.toContain("request_payments");
    expect(nod.payments).toBeNull();
  });
});
