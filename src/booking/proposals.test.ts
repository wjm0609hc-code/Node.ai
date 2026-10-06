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
import type { BookingPartner } from "./partners";
import { createSamplePartner, type SamplePartnerOptions } from "./sample-partner";

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });
type Scripted = ReturnType<typeof reply> | ((body: any) => ReturnType<typeof reply>);

const idOf = (label: string) => (body: any) => new RegExp(`\\[option ([^\\]]+)\\] ${label}`).exec(String(body.messages[0].content))?.[1];
/** Claude calls one tool, then says `after` ("" = stays silent). */
const call = (name: string, input: (body: any) => Record<string, unknown>, after = ""): Scripted[] => [
  (body) => reply([toolUse("t", name, input(body))], "tool_use"),
  reply(after ? [text(after)] : []),
];
const proposeHartwood = (party = 6, at = "2026-10-03T20:00") =>
  call("propose_booking", (b) => ({ option_id: idOf("Hartwood")(b), party_size: party, starts_at_local: at }));

async function setup(responses: Scripted[], partnerOpts: SamplePartnerOptions = {}, wrap?: (p: BookingPartner) => BookingPartner) {
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
  const sample = createSamplePartner({ taken: [], now, ...partnerOpts });
  const partner = wrap ? wrap(sample) : sample;
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    classifyAnswer: async ({ answer }) => /^(yes|yep)/i.test(answer),
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4", appUrl: "https://nod.test", timezone: "America/New_York" },
    scheduler,
    bookingPartners: [partner],
    now,
    makeResponder: (env) => createResponder({ ...env, client: { beta: { messages: { create } } } as unknown as AgentClient }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id); // Sarah added Nod, so she approves deposits (no organizer is set)
  await world.settled();
  const say = async (who: keyof typeof s.users, message: string, opts: { replyTo?: string } = {}) => {
    world.say(s.users[who].id, s.groupId, message, { mentionNod: message.includes("@Nod"), ...opts });
    await world.settled();
  };
  const react = async (who: keyof typeof s.users, messageId: string, tapback: Tapback, removed = false) => {
    world.react(s.users[who].id, messageId, tapback, { removed });
    await world.settled();
  };
  const group = (await store.groupByProviderId("simulator", s.groupId))!;

  const { option: hartwood } = await store.upsertOption({
    groupId: group.id, kind: "restaurant", source: "search", url: "https://hartwoodtulum.com/", postedByUserId: null, providerMessageId: null,
  });
  await store.updateOptionParsed(hartwood.id, {
    title: "Hartwood", bookingUrl: "https://resy.com/cities/tulum/venues/hartwood", address: "Carretera Tulum km 7.6",
  });
  const { option: arca } = await store.upsertOption({
    groupId: group.id, kind: "restaurant", source: "search", url: "https://arca.mx/", postedByUserId: null, providerMessageId: null,
  });
  await store.updateOptionParsed(arca.id, { title: "Arca" });
  const decision = await store.createDecision({
    groupId: group.id, kind: "vote", question: "Dinner Saturday?", createdByUserId: null, deadlineAt: null, round: 1, parentDecisionId: null,
    optionIds: [hartwood.id, arca.id],
  });
  await store.updateDecision(decision.id, { status: "decided", winningOptionId: hartwood.id });

  const nodLines = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1);
  const booking = async () => (await store.listBookings(group.id))[0]!;
  const proposalId = async () => (await booking()).proposalMessageId!;
  const lastResult = () => {
    const msgs = requests.at(-1).messages;
    return msgs[msgs.length - 1].content[0];
  };
  const advanceTo = async (iso: string) => {
    clock = new Date(iso);
    await scheduler.runDue(clock, nod.runJob);
    await world.settled();
  };
  return { world, store, scheduler, s, say, react, group, hartwood, decision, nodLines, booking, proposalId, requests, lastResult, advanceTo, create };
}

describe("propose_booking", () => {
  it("posts the exact terms and books nothing yet", async () => {
    const ctx = await setup(proposeHartwood());
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");

    expect(ctx.nodLines().map((l) => l.text)).toEqual([
      "Book Hartwood for 6, Sat, Oct 3, 8:00 PM? $150 deposit ($25 each), paid to Sample Reservations directly. " +
        "Free cancellation until Fri, Oct 2, 8:00 PM, then $150. Under Will's name. Sarah, reply yes or tap 👍 to book it.",
    ]);
    const b = await ctx.booking();
    expect(b).toMatchObject({
      status: "proposed",
      method: "partner",
      partner: "sample",
      partySize: 6,
      holderUserId: expect.any(String),
      decisionId: ctx.decision.id,
      proposal: { depositCents: 15000, cancelFeeCents: 15000, approval: { kind: "one_of" } },
    });
    expect(b.startsAt!.toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(b.proposalMessageId).toBe(ctx.nodLines()[0]!.messageId);
  });

  it("offers nearby times when the one asked for is taken, and posts nothing itself", async () => {
    const ctx = await setup(
      call("propose_booking", (b) => ({ option_id: idOf("Hartwood")(b), party_size: 6, starts_at_local: "2026-10-03T20:00" }), "8:00 is taken. 7:45 or 8:15?"),
      { taken: ["20:00"] },
    );
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    expect(JSON.parse(ctx.requests[1].messages[2].content[0].content)).toMatchObject({
      posted: false,
      requested_time_open: false,
      open_times: [
        { starts_at_local: "2026-10-03T19:45", time: "7:45 PM" },
        { starts_at_local: "2026-10-03T20:15", time: "8:15 PM" },
        {},
        {},
      ],
    });
    expect(ctx.nodLines().map((l) => l.text)).toEqual(["8:00 is taken. 7:45 or 8:15?"]);
    expect(await ctx.store.listBookings(ctx.group.id)).toEqual([]);
  });

  it("says Nod can't book a venue no partner covers, so Claude falls back to a link", async () => {
    const ctx = await setup(call("propose_booking", (b) => ({ option_id: idOf("Arca")(b), party_size: 4, starts_at_local: "2026-10-03T19:00" }), "Here's the link."));
    await ctx.say("will", "@Nod book Arca");
    expect(JSON.parse(ctx.requests[1].messages[2].content[0].content)).toMatchObject({ nod_can_book: false });
  });

  it("only works in the group chat", async () => {
    const ctx = await setup([]);
    const errors: string[] = [];
    ctx.create.mockImplementationOnce(async () => reply([toolUse("t", "propose_booking", { option_id: ctx.hartwood.id, party_size: 2, starts_at_local: "2026-10-03T20:00" })], "tool_use"));
    ctx.create.mockImplementationOnce(async (body: any) => {
      errors.push(body.messages.at(-1).content[0].content);
      return reply([text("Ask me in the group.")]);
    });
    ctx.world.dm(ctx.s.users.will.id, "@Nod book Hartwood");
    await ctx.world.settled();
    expect(errors[0]).toMatch(/group chat/);
    expect(await ctx.store.listBookings(ctx.group.id)).toEqual([]);
  });
});

describe("approving a proposal", () => {
  it("books when the approver taps 👍, and the requester's own tapback isn't enough for a deposit", async () => {
    const ctx = await setup(proposeHartwood());
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    const proposal = await ctx.proposalId();

    await ctx.react("will", proposal, "like");
    expect((await ctx.booking()).status).toBe("proposed");
    await ctx.react("sarah", proposal, "like");

    const b = await ctx.booking();
    expect(b).toMatchObject({ status: "booked", bookedByUserId: expect.any(String) });
    expect(b.confirmation).toMatchObject({ code: expect.stringMatching(/^SAMPLE-/), depositCents: 15000, depositCurrency: "USD" });
    expect(b.confirmation.depositPaidByUserId).toBe(b.holderUserId);
    expect((await ctx.store.getDecision(ctx.decision.id))?.status).toBe("booked");

    expect(ctx.nodLines().at(-2)!.text).toBe(
      `Booked: Hartwood for 6, Sat, Oct 3, 8:00 PM, under Will's name. Confirmation ${b.confirmation.code}. ` +
        "$150 deposit paid to Sample Reservations. Free cancellation until Fri, Oct 2, 8:00 PM.",
    );
    // Then the calendar invite, as a card.
    expect((await lastCardIn(ctx.nodLines(), ctx.store)).targetUrl).toMatch(/^https:\/\/nod\.test\/e\/.+\.ics$/);
    // The free-cancellation reminder is scheduled 3 hours before the window closes.
    expect(ctx.scheduler.pending()).toEqual([{ runAt: new Date("2026-10-02T21:00:00Z"), job: { type: "cancel_reminder", bookingId: b.id } }]);
  });

  it("takes a plain “yes” from the approver Nod asked, without @Nod", async () => {
    const ctx = await setup([...proposeHartwood(), ...call("approve_booking", () => ({}))]);
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.say("sarah", "yes");
    expect((await ctx.booking()).status).toBe("booked");
    expect(ctx.nodLines()).toHaveLength(3); // the proposal, "Booked: …", the invite card
  });

  it("never takes a plain “yes” from someone Nod didn't ask", async () => {
    const ctx = await setup(proposeHartwood());
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.say("mike", "yes");
    expect((await ctx.booking()).status).toBe("proposed");
    expect(ctx.requests).toHaveLength(2);
  });

  it("records an approval that isn't enough yet and says who it's waiting on", async () => {
    const ctx = await setup([...proposeHartwood(), ...call("approve_booking", () => ({}), "Noted. Waiting on Sarah.")]);
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.say("mike", "@Nod yes book it");
    expect(ctx.lastResult().content).toMatch(/Not booked yet: still waiting on Sarah's approval/);
    expect(await ctx.store.bookingApprovals((await ctx.booking()).id)).toHaveLength(1);
    expect((await ctx.booking()).status).toBe("proposed");
  });

  it("lets anyone confirm when nothing is charged, but not with a laugh", async () => {
    const ctx = await setup(proposeHartwood(4));
    await ctx.say("will", "@Nod book Hartwood for 4 at 8pm Saturday");
    expect(ctx.nodLines()[0]!.text).toMatch(/No deposit\. Free cancellation until Fri, Oct 2, 8:00 PM\. Under Will's name\. Will, reply yes \(or anyone tap 👍\) to book it\.$/);
    const proposal = await ctx.proposalId();
    await ctx.react("mike", proposal, "laugh");
    expect((await ctx.booking()).status).toBe("proposed");
    await ctx.react("mike", proposal, "love");
    expect((await ctx.booking()).status).toBe("booked");
    // No fee after the window, so no reminder.
    expect(ctx.scheduler.pending()).toEqual([]);
  });

  it("needs three people over $200 a person", async () => {
    const ctx = await setup(proposeHartwood(4), { deposit: (n) => 25_000 * n });
    await ctx.say("will", "@Nod book Hartwood for 4 at 8pm Saturday");
    expect(ctx.nodLines()[0]!.text).toMatch(/\$1,000 deposit \(\$250 each\).*3 people need to approve: tap 👍 or reply “@Nod yes”\.$/);
    const proposal = await ctx.proposalId();
    await ctx.react("will", proposal, "like");
    await ctx.react("sarah", proposal, "like");
    expect((await ctx.booking()).status).toBe("proposed");
    await ctx.react("jake", proposal, "love");
    expect((await ctx.booking()).status).toBe("booked");
  });

  it("drops an approval when the tapback is removed", async () => {
    const ctx = await setup(proposeHartwood(4), { deposit: (n) => 25_000 * n });
    await ctx.say("will", "@Nod book Hartwood for 4 at 8pm Saturday");
    const proposal = await ctx.proposalId();
    await ctx.react("will", proposal, "like");
    await ctx.react("sarah", proposal, "like");
    await ctx.react("sarah", proposal, "like", true);
    await ctx.react("jake", proposal, "like");
    expect((await ctx.booking()).status).toBe("proposed");
  });

  it("counts SMS tapback text on the proposal", async () => {
    const ctx = await setup(proposeHartwood());
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.say("sarah", `Liked “${ctx.nodLines()[0]!.text}”`);
    expect((await ctx.booking()).status).toBe("booked");
  });

  it("books once, however many approvals arrive", async () => {
    const book = vi.fn();
    const ctx = await setup(proposeHartwood(4), {}, (p) => ({ ...p, book: (r) => (book(r), p.book(r)) }));
    await ctx.say("will", "@Nod book Hartwood for 4 at 8pm Saturday");
    const proposal = await ctx.proposalId();
    await Promise.all([ctx.react("mike", proposal, "like"), ctx.react("jake", proposal, "like"), ctx.react("sarah", proposal, "love")]);
    expect(book).toHaveBeenCalledTimes(1);
    expect(ctx.nodLines().filter((l) => l.text.startsWith("Booked:"))).toHaveLength(1);
  });

  it("asks again instead of booking when the terms changed", async () => {
    let perPerson = 2500;
    const ctx = await setup(proposeHartwood(), { deposit: (n) => perPerson * n });
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    const first = await ctx.proposalId();
    perPerson = 5000;
    await ctx.react("sarah", first, "like");

    const b = await ctx.booking();
    expect(b.status).toBe("proposed");
    expect(b.proposal?.depositCents).toBe(30000);
    expect(await ctx.store.bookingApprovals(b.id)).toEqual([]);
    expect(ctx.nodLines().at(-1)!.text).toMatch(/^The terms changed since I asked\. Book Hartwood for 6.*\$300 deposit \(\$50 each\)/);
    // The old message no longer approves anything; the new one does.
    await ctx.react("sarah", first, "love");
    expect((await ctx.booking()).status).toBe("proposed");
    await ctx.react("sarah", b.proposalMessageId!, "like");
    expect((await ctx.booking()).status).toBe("booked");
  });

  it("tells the group when the time was taken in the meantime", async () => {
    const taken: string[] = [];
    const ctx = await setup(proposeHartwood(), { taken });
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    taken.push("20:00");
    await ctx.react("sarah", await ctx.proposalId(), "like");
    expect((await ctx.booking()).status).toBe("expired");
    expect(ctx.nodLines().at(-1)!.text).toBe("Hartwood no longer has 8:00 PM for 6. Open nearby: 7:45 PM, 8:15 PM, 7:30 PM. Ask me to book one of those.");
  });

  it("says so when the partner fails, and retries on the same booking without double-booking", async () => {
    let fail = true;
    const book = vi.fn();
    const ctx = await setup(proposeHartwood(), {}, (p) => ({
      ...p,
      book: async (r) => {
        book(r.idempotencyKey);
        if (fail) throw new Error("timeout");
        return p.book(r);
      },
    }));
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.react("sarah", await ctx.proposalId(), "like");
    const b = await ctx.booking();
    expect(b.status).toBe("failed");
    expect(ctx.nodLines().at(-1)!.text).toBe("I couldn't confirm Hartwood with Sample Reservations. Say “@Nod try again” and I'll retry without double-booking.");

    fail = false;
    ctx.create.mockImplementationOnce(async () => reply([toolUse("t", "approve_booking", { booking_id: b.id })], "tool_use"));
    ctx.create.mockImplementationOnce(async () => reply([]));
    await ctx.say("sarah", "@Nod try again");
    expect((await ctx.booking()).status).toBe("booked");
    expect(book.mock.calls.map((c) => c[0])).toEqual([b.id, b.id]);
  });

  it("stops counting a proposal after a day", async () => {
    const ctx = await setup(proposeHartwood());
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.advanceTo("2026-09-30T16:00:00Z");
    await ctx.react("sarah", await ctx.proposalId(), "like");
    expect((await ctx.booking()).status).toBe("proposed");
  });

  it("can be called off", async () => {
    const ctx = await setup([...proposeHartwood(), ...call("decline_booking", () => ({}), "Called off.")]);
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    const proposal = await ctx.proposalId();
    await ctx.say("jake", "@Nod actually don't book it");
    expect((await ctx.booking()).status).toBe("declined");
    await ctx.react("sarah", proposal, "like");
    expect((await ctx.booking()).status).toBe("declined");
  });

  it("replaces an earlier open proposal", async () => {
    const ctx = await setup([...proposeHartwood(6, "2026-10-03T20:00"), ...proposeHartwood(6, "2026-10-03T21:00")]);
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.say("will", "@Nod make it 9pm");
    const all = await ctx.store.listBookings(ctx.group.id);
    expect(all.map((b) => `${b.status} ${b.startsAt!.toISOString()}`).sort()).toEqual([
      "expired 2026-10-04T00:00:00.000Z",
      "proposed 2026-10-04T01:00:00.000Z",
    ]);
  });

  it("shows the proposal and who approved in Claude's context", async () => {
    const ctx = await setup([...proposeHartwood(), reply([text("Waiting on Sarah.")])]);
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.react("mike", await ctx.proposalId(), "like");
    await ctx.say("will", "@Nod is it booked?");
    expect(String(ctx.requests.at(-1).messages[0].content)).toMatch(
      /Hartwood · Sat, Oct 3, 8:00 PM · 6 people · proposed by Nod, not booked \(\$150 deposit.*Waiting on Sarah's approval\. Approved so far: Mike\./,
    );
  });
});

describe("after booking", () => {
  async function booked(extra: Scripted[] = []) {
    const ctx = await setup([...proposeHartwood(), ...extra]);
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.react("sarah", await ctx.proposalId(), "like");
    return ctx;
  }

  it("privately reminds the person it's under before free cancellation ends, once", async () => {
    const ctx = await booked();
    await ctx.advanceTo("2026-10-02T21:00:00Z");
    const dms = ctx.world.dmTranscript(ctx.s.users.will.id).filter((l) => l.from === "nod" && /Free cancellation/.test(l.text));
    expect(dms.map((l) => l.text)).toEqual([
      "Free cancellation for Hartwood (Sat, Oct 3, 8:00 PM, 6 people) ends Fri, Oct 2, 8:00 PM. After that, cancelling costs $150. " +
        "If plans change, say “@Nod cancel Hartwood” in Tulum 🌴.",
    ]);
    await ctx.scheduler.scheduleBookingReminder({ bookingId: (await ctx.booking()).id, runAt: new Date("2026-10-02T21:30:00Z") });
    await ctx.advanceTo("2026-10-02T21:30:00Z");
    expect(ctx.world.dmTranscript(ctx.s.users.will.id).filter((l) => /Free cancellation/.test(l.text))).toHaveLength(1);
    // Nothing about Will's money went to the group.
    expect(ctx.nodLines().some((l) => /Free cancellation for/.test(l.text))).toBe(false);
  });

  it("cancels with the venue for free inside the window", async () => {
    const ctx = await booked(call("cancel_booking", (body) => ({ booking_id: /\[booking ([^\]]+)\]/.exec(String(body.messages[0].content))![1] }), "Cancelled."));
    await ctx.say("will", "@Nod cancel Hartwood");
    expect(ctx.lastResult().content).toBe("Cancelled Hartwood with Sample Reservations. No fee. The calendar cancellation goes with your reply; tapping it removes the event.");
    expect((await ctx.booking()).status).toBe("cancelled");
    expect((await ctx.store.getDecision(ctx.decision.id))?.status).toBe("decided");
  });

  it("asks before a cancellation fee, and only the person it's under or the approver can accept it", async () => {
    const ctx = await booked();
    const b = await ctx.booking();
    await ctx.advanceTo("2026-10-03T12:00:00Z"); // after free cancellation ended
    const results: string[] = [];
    const cancelAs = async (who: "will" | "mike", input: Record<string, unknown>) => {
      ctx.create.mockImplementationOnce(async () => reply([toolUse("t", "cancel_booking", { booking_id: b.id, ...input })], "tool_use"));
      ctx.create.mockImplementationOnce(async (body: any) => {
        results.push(body.messages.at(-1).content[0].content);
        return reply([text("ok")]);
      });
      await ctx.say(who, "@Nod cancel Hartwood");
    };
    await cancelAs("will", {});
    expect(JSON.parse(results[0]!)).toMatchObject({ cancelled: false, fee: "$150" });
    expect((await ctx.booking()).status).toBe("booked");

    await cancelAs("mike", { confirm_fee: true });
    expect(results[1]).toMatch(/Only Will or Sarah can approve the \$150 cancellation fee/);
    expect((await ctx.booking()).status).toBe("booked");

    await cancelAs("will", { confirm_fee: true });
    expect(results[2]).toBe("Cancelled Hartwood with Sample Reservations. Sample Reservations charged a $150 cancellation fee. The calendar cancellation goes with your reply; tapping it removes the event.");
    expect(await ctx.booking()).toMatchObject({ status: "cancelled", confirmation: { cancelFeeCents: 15000 } });
  });
});

describe("without booking partners", () => {
  it("doesn't offer Claude the booking tools, so every booking is a link hand-off", async () => {
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
    const names = (create.mock.calls[0] as any[])[0].tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["booking_link", "mark_booked", "cancel_booking"]));
    expect(names).not.toContain("propose_booking");
    expect(names).not.toContain("approve_booking");
  });
});

/** The card in Nod's last message (it must be one): a link that previews as the card. */
async function lastCardIn(lines: Array<{ text: string }>, store: { getCard(id: string): Promise<any> }) {
  const text = lines.at(-1)!.text;
  expect(text).toMatch(/^.+: https:\/\/nod\.test\/o\/[A-Za-z0-9]{12} \(tap to open\)$/);
  return (await store.getCard(text.split("/o/")[1]!.split(" ")[0]!))!;
}
