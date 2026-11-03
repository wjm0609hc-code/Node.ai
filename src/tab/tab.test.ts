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
import { balances } from "./math";
import { sampleReceiptReader } from "./receipts";

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
    receiptReader: sampleReceiptReader,
    ...(opts.payments ? { paymentGateway: gateway } : {}),
    now,
    makeResponder: (env) => createResponder({ ...env, client: { beta: { messages: { create } } } as unknown as AgentClient }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id);
  await world.settled();
  const group = (await store.groupByProviderId("simulator", s.groupId))!;
  const idOf = async (who: Who) => (await store.upsertUser(world.user(s.users[who].id)!.phone)).id;
  const say = async (who: Who, message: string, mediaUrls?: string[]) => {
    world.say(s.users[who].id, s.groupId, message, { mentionNod: message.includes("@Nod"), ...(mediaUrls ? { mediaUrls } : {}) });
    await world.settled();
  };
  const bal = async () => {
    const b = balances(await store.listLedger(group.id));
    const out: Record<string, number> = {};
    for (const who of ["will", "jake", "sarah", "mike"] as Who[]) out[who] = b.get(await idOf(who)) ?? 0;
    return out;
  };
  const toolResult = () => {
    const msgs = requests.at(-1).messages;
    return msgs[msgs.length - 1].content[0].content as string;
  };
  const nodInGroup = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1).map((l) => l.text);
  const dms = (who: Who) => world.dmTranscript(s.users[who].id).filter((l) => l.from === "nod").map((l) => l.text);
  return { world, store, gateway, nod, s, group, idOf, say, bal, toolResult, nodInGroup, dms, requests, create };
}

describe("record_expense", () => {
  it("splits evenly between everyone, and doesn't tell Claude who owes what", async () => {
    const ctx = await setup(call("record_expense", { description: "Groceries", amount_cents: 18000 }, "Added $180 groceries to the tab."));
    await ctx.say("will", "@Nod I paid $180 for groceries, split with everyone");
    expect(await ctx.bal()).toEqual({ will: 13500, jake: -4500, sarah: -4500, mike: -4500 });
    const result = JSON.parse(ctx.toolResult());
    expect(result).toMatchObject({ added: "Will paid $180 for Groceries", split: "split 4 ways" });
    expect(ctx.toolResult()).not.toMatch(/\$45/);
  });

  it("records 'Jake owes me $40' as Jake's share only", async () => {
    const ctx = await setup(call("record_expense", { description: "Cab", amount_cents: 4000, split_with: ["Jake"] }));
    await ctx.say("will", "@Nod Jake owes me $40 for the cab");
    expect(await ctx.bal()).toEqual({ will: 4000, jake: -4000, sarah: 0, mike: 0 });
  });

  it("takes exact shares, and someone else as the payer", async () => {
    const ctx = await setup(
      call("record_expense", { description: "Boat", paid_by: "Sarah", shares: [{ person: "Sarah", amount_cents: 5000 }, { person: "Mike", amount_cents: 7000 }] }),
    );
    await ctx.say("will", "@Nod Sarah paid $120 for the boat, $50 hers and $70 Mike's");
    expect(await ctx.bal()).toEqual({ will: 0, jake: 0, sarah: 7000, mike: -7000 });
  });

  it("refuses shares that don't add up", async () => {
    const ctx = await setup(call("record_expense", { description: "X", amount_cents: 5000, shares: [{ person: "Jake", amount_cents: 2000 }] }, "Those don't add up."));
    await ctx.say("will", "@Nod add it");
    expect(ctx.toolResult()).toMatch(/add up to \$20, not \$50/);
    expect(await ctx.store.listLedger(ctx.group.id)).toEqual([]);
  });

  it("adds a booking's deposit once, paid by whoever paid it", async () => {
    const ctx = await setup([]);
    const { option } = await ctx.store.upsertOption({ groupId: ctx.group.id, kind: "restaurant", source: "search", url: "https://hartwood.test/", postedByUserId: null, providerMessageId: null });
    const booking = await ctx.store.createBooking({
      groupId: ctx.group.id, optionId: option.id, decisionId: null, requestedByUserId: null, partySize: 4,
      startsAt: new Date("2026-10-04T00:00:00Z"), endsAt: new Date("2026-10-04T02:00:00Z"), allDay: false, link: null, method: "link",
    });
    await ctx.store.updateBooking(booking.id, { status: "booked", confirmation: { depositCents: 20000, depositCurrency: "USD", depositPaidByUserId: await ctx.idOf("jake") } });
    const results: string[] = [];
    for (let i = 0; i < 2; i++) {
      ctx.create.mockImplementationOnce(async () => reply([toolUse("t", "record_expense", { description: "Hartwood deposit", booking_id: booking.id })], "tool_use"));
      ctx.create.mockImplementationOnce(async (body: any) => (results.push(body.messages.at(-1).content[0].content), reply([text("ok")])));
      await ctx.say("will", "@Nod add the deposit to the tab");
    }
    expect(await ctx.bal()).toEqual({ will: -5000, jake: 15000, sarah: -5000, mike: -5000 });
    expect(results[1]).toMatch(/already on the tab/);
  });

  it("only works in the group", async () => {
    const ctx = await setup([]);
    ctx.create.mockImplementationOnce(async () => reply([toolUse("t", "record_expense", { description: "X", amount_cents: 1000 })], "tool_use"));
    let err = "";
    ctx.create.mockImplementationOnce(async (body: any) => ((err = body.messages.at(-1).content[0].content), reply([text("Ask in the group.")])));
    ctx.world.dm(ctx.s.users.will.id, "add $10 to the tab");
    await ctx.world.settled();
    expect(err).toMatch(/lives in the group chat/);
  });
});

describe("receipts", () => {
  it("puts a posted receipt straight on the tab: paid by whoever posted it, split evenly", async () => {
    const ctx = await setup(call("split_receipt", {}, ""));
    await ctx.say("will", "@Nod split this", ["https://img.test/receipt.jpg"]);
    const read = JSON.parse(ctx.toolResult());
    expect(read.receipts[0]).toMatchObject({ added: "Taquería Late (sample receipt) $98.60, paid by Will, split 4 ways" });
    expect(read.receipts[0].items[0]).toBe("1. Tacos al pastor x4 $24");
    expect(await ctx.bal()).toEqual({ will: 9860 - 2465, jake: -2465, sarah: -2465, mike: -2465 });
    expect((await ctx.store.listLedger(ctx.group.id))[0]).toMatchObject({ amountCents: 9860, source: "receipt" });
  });

  it("credits whoever posted the photo, picks up every unread photo, and never adds one twice", async () => {
    const ctx = await setup([...call("split_receipt", {}, ""), ...call("split_receipt", {}, "")]);
    await ctx.say("sarah", "", ["https://img.test/r2.jpg"]);
    await ctx.say("jake", "", ["https://img.test/r3.jpg"]);
    await ctx.say("will", "@Nod split these");
    const read = JSON.parse(ctx.toolResult());
    expect(read.receipts.map((r: any) => r.added)).toEqual([
      "Taquería Late (sample receipt) $98.60, paid by Sarah, split 4 ways",
      "Taquería Late (sample receipt) $98.60, paid by Jake, split 4 ways",
    ]);
    await ctx.say("will", "@Nod split them again");
    expect(ctx.toolResult()).toMatch(/already on the tab/);
    expect(await ctx.store.listLedger(ctx.group.id)).toHaveLength(2);
  });

  it("can still split by who had what, after taking the even split off", async () => {
    const ctx = await setup(call("split_receipt", {}, ""));
    await ctx.say("will", "@Nod split this", ["https://img.test/receipt.jpg"]);
    const { receipt_id: receiptId, entry_id: entryId } = JSON.parse(ctx.toolResult()).receipts[0];
    const script = [
      reply([toolUse("u", "undo_expense", { entry_id: entryId })], "tool_use"),
      reply([toolUse("r", "record_expense", { description: "Taquería", receipt_id: receiptId, items: [{ item: 4, people: ["Will", "Sarah", "Mike"] }, { item: 2, people: ["Jake"] }] })], "tool_use"),
      reply([text("Done.")]),
    ];
    ctx.create.mockImplementation(async () => script.shift() ?? reply([text("ok")]));
    await ctx.say("will", "@Nod margaritas were me, Sarah and Mike, the burrito was Jake's, rest shared");
    expect(await ctx.bal()).toEqual({ will: 9860 - 2375, jake: -2735, sarah: -2375, mike: -2375 });
  });

  it("says so when there's no photo, and marks photos in what Claude sees", async () => {
    const other = await setup(call("split_receipt", {}, "No photo."));
    await other.say("will", "@Nod split the receipt");
    expect(other.toolResult()).toMatch(/No receipt photo here/);

    const ctx = await setup([reply([text("ok")])]);
    await ctx.say("sarah", "dinner", ["https://img.test/r2.jpg"]);
    await ctx.say("will", "@Nod hi");
    expect(String(ctx.requests.at(-1).messages[0].content)).toMatch(/Sarah: dinner \[photo\]/);
  });
});

describe("undo and paying back", () => {
  it("lets only whoever added or paid an entry take it off", async () => {
    let entryId = "";
    const ctx = await setup([
      ...call("record_expense", { description: "Gas", amount_cents: 6000 }),
      ...call("undo_expense", () => ({ entry_id: entryId }), "Can't."),
      ...call("undo_expense", () => ({ entry_id: entryId }), "Removed."),
    ]);
    await ctx.say("will", "@Nod I paid $60 for gas");
    entryId = JSON.parse(ctx.toolResult()).entry_id;
    await ctx.say("mike", "@Nod remove the gas");
    expect(ctx.toolResult()).toMatch(/Only whoever added it or paid it/);
    await ctx.say("will", "@Nod remove the gas, it was wrong");
    expect(await ctx.store.listLedger(ctx.group.id)).toEqual([]);
  });

  it("records a payback made outside Nod, by the person who got the money", async () => {
    const ctx = await setup([
      ...call("record_expense", { description: "Cab", amount_cents: 4000, split_with: ["Jake"] }),
      ...call("record_payment", { from: "Jake", amount_cents: 4000 }, "Got it."),
    ]);
    await ctx.say("will", "@Nod Jake owes me $40 for the cab");
    await ctx.say("will", "@Nod Jake paid me back $40");
    expect(await ctx.bal()).toEqual({ will: 0, jake: 0, sarah: 0, mike: 0 });
  });
});

describe("balances and settling up", () => {
  const spend = () => [
    ...call("record_expense", { description: "Groceries", amount_cents: 12000 }),
    ...call("record_expense", { description: "Drinks", amount_cents: 4000, paid_by: "Sarah", split_with: ["Jake", "Mike"] }),
  ];

  it("texts each person their own balance and keeps it out of the group", async () => {
    const ctx = await setup([...spend(), ...call("send_balances", {}, "Sent everyone their balance privately.")]);
    await ctx.say("will", "@Nod I paid $120 for groceries, split with everyone");
    await ctx.say("sarah", "@Nod I paid $40 for drinks for Jake and Mike");
    await ctx.say("jake", "@Nod what's the tab?");
    expect(ctx.dms("jake").at(-1)).toBe("Your balance on the Tulum 🌴 tab: you owe $50. To settle: pay Will $50.");
    expect(ctx.dms("will").at(-1)).toBe("Your balance on the Tulum 🌴 tab: you're owed $90. To settle: Jake pays you $50; Mike pays you $40.");
    expect(ctx.nodInGroup().at(-1)).toBe("Sent everyone their balance privately.");
    expect(ctx.nodInGroup().some((t) => /\$50|\$90/.test(t))).toBe(false);
  });

  it("tells Claude to summarize in the group, and shows a person their own balance in private", async () => {
    const ctx = await setup([...spend(), reply([text("ok")])]);
    await ctx.say("will", "@Nod I paid $120 for groceries, split with everyone");
    await ctx.say("sarah", "@Nod I paid $40 for drinks for Jake and Mike");
    await ctx.say("mike", "@Nod how are we doing?");
    const groupCtx = String(ctx.requests.at(-1).messages[0].content);
    expect(groupCtx).toMatch(/\$160 in expenses so far/);
    expect(groupCtx).toMatch(/then tab_summary/);
    ctx.world.dm(ctx.s.users.mike.id, "what do I owe?");
    await ctx.world.settled();
    expect(String(ctx.requests.at(-1).messages[0].content)).toMatch(/Tulum 🌴: you owe \$50\. To settle: pay Will \$40; pay Sarah \$10\./);
  });

  it("tab_summary posts the whole breakdown in the group as one message, and texts nobody", async () => {
    const ctx = await setup([...spend(), ...call("tab_summary", {}, "")]);
    await ctx.say("will", "@Nod I paid $120 for groceries, split with everyone");
    await ctx.say("sarah", "@Nod I paid $40 for drinks for Jake and Mike");
    const before = (["will", "jake", "sarah", "mike"] as Who[]).map((w) => ctx.dms(w).length);
    await ctx.say("will", "@Nod who owes who?");
    expect(ctx.nodInGroup().at(-1)).toBe(
      ["Tulum 🌴 tab: $160", "Groceries $120 (Will) · Drinks $40 (Sarah)", "Shares: Will $30, Jake $50, Sarah $30, Mike $50", "Jake → Will $50", "Mike → Will $40", "Mike → Sarah $10"].join("\n"),
    );
    expect((["will", "jake", "sarah", "mike"] as Who[]).map((w) => ctx.dms(w).length)).toEqual(before);
  });

  it("an even split says each person's share, and links to Venmo when the person being paid saved theirs", async () => {
    const ctx = await setup([
      ...call("save_venmo", { handle: "https://venmo.com/u/will-m-test" }, "Saved."),
      ...call("record_expense", { description: "The Astor", amount_cents: 10000 }),
      ...call("record_expense", { description: "Drinks", amount_cents: 2000, paid_by: "Sarah" }),
      ...call("tab_summary", {}, ""),
    ]);
    await ctx.say("will", "@Nod my venmo is venmo.com/u/will-m-test");
    await ctx.say("will", "@Nod I paid $100 at The Astor");
    await ctx.say("sarah", "@Nod $20 drinks were mine");
    await ctx.say("will", "@Nod summary?");
    const lines = ctx.nodInGroup().at(-1)!.split("\n");
    expect(lines.slice(0, 3)).toEqual(["Tulum 🌴 tab: $120", "The Astor $100 (Will) · Drinks $20 (Sarah)", "Split 4 ways: $30 each"]);
    expect(lines).toContain("Jake → Will $30 https://venmo.com/?txn=pay&recipients=will-m-test&amount=30.00&note=Tulum+%F0%9F%8C%B4+tab");
    expect(lines).toContain("Sarah → Will $10 https://venmo.com/?txn=pay&recipients=will-m-test&amount=10.00&note=Tulum+%F0%9F%8C%B4+tab");
  });

  it("only saves a real Venmo username", async () => {
    const ctx = await setup(call("save_venmo", { handle: "not a handle!" }, "Hmm."));
    await ctx.say("will", "@Nod my venmo is not a handle!");
    expect(ctx.toolResult()).toMatch(/doesn't look like a Venmo username/);
  });

  it("without card payments, settle up posts who pays whom in the group", async () => {
    const ctx = await setup([...spend(), ...call("settle_up", {}, "")]);
    await ctx.say("will", "@Nod I paid $120 for groceries, split with everyone");
    await ctx.say("sarah", "@Nod I paid $40 for drinks for Jake and Mike");
    await ctx.say("will", "@Nod settle up");
    expect(ctx.nodInGroup().at(-1)).toMatch(/^Tulum 🌴 tab: \$160\n[\s\S]*\nMike → Sarah \$10$/);
    expect(ctx.dms("mike").some((t) => /balance/.test(t))).toBe(false);
  });

  it("with card payments, sends pay links and puts each payment on the tab once charged", async () => {
    const ctx = await setup([...spend(), ...call("settle_up", {}, ""), ...call("settle_up", {}, "Already going.")], { payments: true });
    for (const who of ["will", "sarah"] as Who[]) {
      const id = await ctx.idOf(who);
      await ctx.store.setStripeAccount(id, `acct_${who}`);
      ctx.gateway.completeOnboarding(`acct_${who}`);
      await ctx.store.setStripeAccountReady(`acct_${who}`, true);
    }
    await ctx.say("will", "@Nod I paid $120 for groceries, split with everyone");
    await ctx.say("sarah", "@Nod I paid $40 for drinks for Jake and Mike");
    await ctx.say("will", "@Nod settle up");
    expect(ctx.nodInGroup().at(-1)).toBe(
      "Settling the tab: 3 payments. I've sent each person who owes money a private link; cards are only charged once each person's payments are in.",
    );
    const collections = await ctx.store.listCollections(ctx.group.id);
    expect(collections.map((c) => c.purpose)).toEqual(["settle_up", "settle_up"]);
    expect(ctx.dms("mike").filter((t) => /'s collecting/.test(t))).toHaveLength(2);

    await ctx.say("will", "@Nod settle up again");
    expect(ctx.toolResult()).toMatch(/already under way/);

    // Everyone pays their links.
    for (const c of collections) {
      for (const r of await ctx.store.paymentRequests(c.id)) {
        const started = await ctx.nod.payments!.startPayment(r.token);
        if (!("clientSecret" in started)) throw new Error("can't pay");
        const intentId = (await ctx.store.getPaymentRequest(r.id))!.stripePaymentIntentId!;
        ctx.gateway.authorize(intentId);
        await ctx.nod.payments!.syncIntent(intentId);
      }
    }
    await ctx.world.settled();
    expect(await ctx.bal()).toEqual({ will: 0, jake: 0, sarah: 0, mike: 0 });
    expect((await ctx.store.listLedger(ctx.group.id)).filter((e) => e.source === "settle_up")).toHaveLength(3);
  });

  it("says everyone's even when there's nothing to settle", async () => {
    const ctx = await setup(call("settle_up", {}, "Everyone's even."));
    await ctx.say("will", "@Nod settle up");
    expect(ctx.toolResult()).toMatch(/Everyone's even/);
  });
});

describe("names", () => {
  it("saves names for members Nod only knows by number, matched by the last four digits", async () => {
    const ctx = await setup([]);
    const pete = ctx.world.addUser({ name: "Pete", platform: "iphone", phone: "+16175552014" });
    const brian = ctx.world.addUser({ name: "Brian", platform: "iphone", phone: "+16175556249" });
    const groupId = ctx.world.createGroup({ name: "Friday", createdBy: ctx.s.users.will.id, members: [ctx.s.users.will.id, pete.id, brian.id] });
    ctx.world.addNod(groupId, ctx.s.users.will.id);
    await ctx.world.settled();
    const script = [
      reply([toolUse("n", "set_member_name", { people: [{ person: "6249", name: "Brian" }, { person: "Member ending 2014", name: "Peter" }] })], "tool_use"),
      reply([toolUse("e", "record_expense", { description: "Drinks", amount_cents: 32400, paid_by: "Brian" })], "tool_use"),
      reply([toolUse("s", "tab_summary", {})], "tool_use"),
      reply([]),
    ];
    ctx.create.mockImplementation(async () => script.shift() ?? reply([text("ok")]));
    ctx.world.say(ctx.s.users.will.id, groupId, "Nod, Brian is 6249 and 2014 is Peter. Brian paid $324 for drinks, split it");
    await ctx.world.settled();
    expect((await ctx.store.upsertUser(brian.phone)).name).toBe("Brian");
    expect((await ctx.store.upsertUser(pete.phone)).name).toBe("Peter");
    const summary = ctx.world.transcript(groupId, ctx.s.users.will.id).filter((l) => l.from === "nod").at(-1)!.text;
    expect(summary).toMatch(/Drinks \$324 \(Brian\)\nSplit 3 ways: \$108 each\n/);
    expect(summary).toMatch(/Will → Brian \$108/);
    expect(summary).toMatch(/Peter → Brian \$108/);
  });

  it("won't rename someone who already has a name, unless it's them", async () => {
    const ctx = await setup(call("set_member_name", { people: [{ person: "Jake", name: "Jacob" }] }, "Can't."));
    await ctx.say("will", "@Nod Jake is Jacob");
    expect(ctx.toolResult()).toMatch(/only they can change it/);
  });
});
