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

const idOf = (label: string) => (body: any) => new RegExp(`\\[option ([^\\]]+)\\] ${label}`).exec(String(body.messages[0].content))?.[1];
const bookingIdIn = (body: any) => /\[booking ([^\]]+)\]/.exec(String(body.messages[0].content))?.[1];
/** Claude calls one tool, then says `after`. The tool input can read ids from the context. */
const call = (name: string, input: (body: any) => Record<string, unknown>, after = "Done."): Scripted[] => [
  (body) => reply([toolUse("t", name, input(body))], "tool_use"),
  reply([text(after)]),
];

async function setup(responses: Scripted[]) {
  const now = () => new Date("2026-09-29T15:00:00Z"); // Tue 11:00 AM in New York
  const world = new ChatWorld({ now });
  const store = new MemoryStore({ now });
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
    now,
    makeResponder: (env) => createResponder({ ...env, client: { beta: { messages: { create } } } as unknown as AgentClient }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id);
  await world.settled();
  const say = async (who: keyof typeof s.users, message: string) => {
    world.say(s.users[who].id, s.groupId, message, { mentionNod: message.includes("@Nod") });
    await world.settled();
  };
  const group = (await store.groupByProviderId("simulator", s.groupId))!;

  // A dinner pick from a search, on Resy, and a rental link Jake posted.
  const { option: hartwood } = await store.upsertOption({
    groupId: group.id, kind: "restaurant", source: "search", url: "https://hartwoodtulum.com/", postedByUserId: null, providerMessageId: null,
  });
  await store.updateOptionParsed(hartwood.id, {
    title: "Hartwood", summary: "Wood-fired Mexican", bookingUrl: "https://resy.com/cities/tulum/venues/hartwood", address: "Carretera Tulum km 7.6",
  });
  const { option: arca } = await store.upsertOption({
    groupId: group.id, kind: "restaurant", source: "search", url: "https://arca.mx/", postedByUserId: null, providerMessageId: null,
  });
  await store.updateOptionParsed(arca.id, { title: "Arca", summary: "Tasting menu", phone: "+52 984 123 4567" });
  await say("jake", "https://www.airbnb.com/rooms/111");
  const rental = (await store.listOptions(group.id, { kind: "rental" }))[0]!;
  await store.updateOptionParsed(rental.id, { title: "Casa Azul" });

  // The group already voted for Hartwood.
  const decision = await store.createDecision({
    groupId: group.id, kind: "vote", question: "Dinner Saturday?", createdByUserId: null, deadlineAt: null, round: 1, parentDecisionId: null,
    optionIds: [hartwood.id, arca.id],
  });
  await store.updateDecision(decision.id, { status: "decided", winningOptionId: hartwood.id });

  const nodLines = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1);
  const toolResult = (i: number) => requests[i].messages[2].content[0];
  return { world, store, s, say, group, hartwood, arca, rental, decision, nodLines, requests, toolResult };
}

async function lastCard(ctx: { nodLines: () => Array<{ text: string }>; store: { getCard(id: string): Promise<any> } }) {
  const line = ctx.nodLines().at(-1)!.text;
  expect(line).toMatch(/^https:\/\/nod\.test\/o\/[A-Za-z0-9]{12}$/);
  return (await ctx.store.getCard(line.split("/o/")[1]!))!;
}

describe("booking_link", () => {
  it("sends a filled-in reservation link for the vote's winner and records it", async () => {
    const ctx = await setup(
      call("booking_link", (b) => ({ option_id: idOf("Hartwood")(b), party_size: 6, starts_at_local: "2026-10-03T20:00" }), "Here's Hartwood for 6 at 8pm Saturday: https://resy.com/..."),
    );
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");

    const result = JSON.parse(ctx.toolResult(1).content);
    expect(result).toMatchObject({ shown_as_card: true, prefilled: true, when: "Sat, Oct 3, 8:00 PM", party_size: 6 });
    expect(result.link).toBeUndefined(); // the card carries it
    const booking = (await ctx.store.getBooking(result.booking_id))!;
    expect(booking).toMatchObject({ status: "link_sent", optionId: ctx.hartwood.id, decisionId: ctx.decision.id, partySize: 6, link: "https://resy.com/cities/tulum/venues/hartwood?date=2026-10-03&seats=6" });
    expect(booking.startsAt!.toISOString()).toBe("2026-10-04T00:00:00.000Z");
    // The reply, then the card: tapping it opens Resy with the date and party size filled in.
    expect(ctx.nodLines()).toHaveLength(2);
    const card = await lastCard(ctx);
    expect(card.targetUrl).toBe("https://resy.com/cities/tulum/venues/hartwood?date=2026-10-03&seats=6");
    expect(card.data).toMatchObject({ title: "Hartwood", details: "Sat, Oct 3, 8:00 PM · 6 people", footer: "Tap to book" });
  });

  it("fills in dates and guests for a rental", async () => {
    const ctx = await setup(
      call("booking_link", (b) => ({ option_id: idOf("Casa Azul")(b), party_size: 6, check_in: "2027-03-14", check_out: "2027-03-18" })),
    );
    await ctx.say("will", "@Nod book Casa Azul for March 14-18");
    expect(JSON.parse(ctx.toolResult(1).content)).toMatchObject({ shown_as_card: true, prefilled: true, when: "Mar 14 to Mar 18" });
    const card = await lastCard(ctx);
    expect(card.targetUrl).toBe("https://www.airbnb.com/rooms/111?adults=6&check_in=2027-03-14&check_out=2027-03-18");
    expect(card.data.details).toBe("Mar 14 to Mar 18 · 6 guests");
  });

  it("gives the phone number when the link can't be filled in", async () => {
    const ctx = await setup(call("booking_link", (b) => ({ option_id: idOf("Arca")(b), party_size: 4, starts_at_local: "2026-10-03T19:00" })));
    await ctx.say("will", "@Nod book Arca");
    expect((await lastCard(ctx)).data.footer).toBe("Tap to open and pick the time");
    expect(JSON.parse(ctx.toolResult(1).content)).toMatchObject({
      shown_as_card: true,
      prefilled: false,
      phone: "+52 984 123 4567",
      note: "The link couldn't be filled in. Tell them to pick 7:00 PM for 4 on the page, or call.",
    });
  });

  it.each([
    [{ option_id: "nope", party_size: 6, starts_at_local: "2026-10-03T20:00" }, "That option isn't in this group."],
    [{ party_size: 6, starts_at_local: "2026-09-01T20:00" }, "That time has already passed."],
    [{ party_size: 6 }, "Give the date and time as starts_at_local, like 2026-10-03T20:00."],
  ])("refuses %j", async (input, message) => {
    const ctx = await setup(call("booking_link", (b) => ({ option_id: idOf("Hartwood")(b), ...input })));
    await ctx.say("will", "@Nod book it");
    expect(ctx.toolResult(1)).toMatchObject({ is_error: true, content: message });
  });

  it("asks for stay dates for a rental", async () => {
    const ctx = await setup(call("booking_link", (b) => ({ option_id: idOf("Casa Azul")(b), party_size: 6 })));
    await ctx.say("will", "@Nod book Casa Azul");
    expect(ctx.toolResult(1)).toMatchObject({ is_error: true, content: "Rentals need check_in and check_out dates, like 2027-03-14." });
  });

  it("works only in a group chat", async () => {
    const ctx = await setup([reply([text("hi")]), ...call("booking_link", () => ({ option_id: "x", party_size: 2, starts_at_local: "2026-10-03T20:00" }))]);
    ctx.world.dm(ctx.s.users.will.id, "hey");
    await ctx.world.settled();
    ctx.world.dm(ctx.s.users.will.id, "book it");
    await ctx.world.settled();
    expect(ctx.requests[2].messages[2].content[0]).toMatchObject({ is_error: true, content: "Bookings are made from the group chat." });
  });
});

describe("mark_booked", () => {
  const linkThenBooked = (extra: Record<string, unknown> = {}): Scripted[] => [
    ...call("booking_link", (b) => ({ option_id: idOf("Hartwood")(b), party_size: 6, starts_at_local: "2026-10-03T20:00" })),
    ...call("mark_booked", (b) => ({ booking_id: bookingIdIn(b), confirmation_code: "ABC123", ...extra }), "Booked: Hartwood, Sat 8pm for 6. Invite attached."),
  ];

  it("records the booking, marks the decision booked, and attaches a calendar invite to Nod's reply", async () => {
    const ctx = await setup(linkThenBooked());
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.say("jake", "@Nod we booked it, confirmation ABC123");

    const result = JSON.parse(ctx.toolResult(3).content);
    const booking = (await ctx.store.getBooking(result.booking_id))!;
    const jake = await ctx.store.upsertUser(ctx.s.users.jake.phone);
    expect(booking).toMatchObject({ status: "booked", bookedByUserId: jake.id, confirmation: { code: "ABC123" } });
    expect(await ctx.store.getDecision(ctx.decision.id)).toMatchObject({ status: "booked" });

    const event = (await ctx.store.getEvent(result.event_id))!;
    expect(event).toMatchObject({ title: "Hartwood, 6 people", allDay: false, location: "Carretera Tulum km 7.6", bookingId: booking.id });
    expect(event.startsAt.toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(event.endsAt.toISOString()).toBe("2026-10-04T02:00:00.000Z");

    // The reply, then the invite as a card: tapping it opens the .ics, which adds the booking to the calendar.
    expect(ctx.nodLines().at(-2)!.text).toBe("Booked: Hartwood, Sat 8pm for 6. Invite attached.");
    const invite = await lastCard(ctx);
    expect(invite.targetUrl).toBe(`https://nod.test/e/${event.id}.ics`);
    expect(invite.data).toMatchObject({ source: "Calendar", title: "Hartwood, 6 people", details: "Sat, Oct 3, 8:00 PM · Carretera Tulum km 7.6", footer: "Tap to add to your calendar" });
  });

  it("saves a deposit and who paid it, for the tab later", async () => {
    const ctx = await setup(linkThenBooked({ deposit_cents: 10000, deposit_currency: "USD", paid_by: "Jake" }));
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.say("jake", "@Nod booked, I put down a $100 deposit");
    const result = JSON.parse(ctx.toolResult(3).content);
    const jake = await ctx.store.upsertUser(ctx.s.users.jake.phone);
    expect((await ctx.store.getBooking(result.booking_id))!.confirmation).toMatchObject({
      code: "ABC123",
      depositCents: 10000,
      depositCurrency: "USD",
      depositPaidByUserId: jake.id,
    });
    expect(result.note).toBe("Jake's $100 deposit is saved on the booking. Offer to add it to the tab (record_expense with this booking_id).");
  });

  it("records a booking someone made without a link from Nod", async () => {
    const ctx = await setup(
      call("mark_booked", (b) => ({ option_id: idOf("Casa Azul")(b), party_size: 6, check_in: "2027-03-14", check_out: "2027-03-18" })),
    );
    await ctx.say("jake", "@Nod I booked Casa Azul for the 14th to the 18th");
    const result = JSON.parse(ctx.toolResult(1).content);
    const event = (await ctx.store.getEvent(result.event_id))!;
    expect(event).toMatchObject({ title: "Casa Azul", allDay: true });
    expect([event.startsAt.toISOString(), event.endsAt.toISOString()]).toEqual(["2027-03-14T00:00:00.000Z", "2027-03-18T00:00:00.000Z"]);
  });

  it("needs to know when it is", async () => {
    const ctx = await setup(call("mark_booked", (b) => ({ option_id: idOf("Arca")(b) })));
    await ctx.say("jake", "@Nod I booked Arca");
    expect(ctx.toolResult(1)).toMatchObject({
      is_error: true,
      content: "When is it? Pass starts_at_local (or check_in and check_out for a stay), and party_size.",
    });
  });

  it("can be cancelled, which reopens the decision for booking", async () => {
    const ctx = await setup([
      ...linkThenBooked(),
      ...call("cancel_booking", (b) => ({ booking_id: bookingIdIn(b) }), "Cancelled."),
    ]);
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.say("jake", "@Nod we booked it");
    await ctx.say("jake", "@Nod we had to cancel Hartwood");
    const [booking] = await ctx.store.listBookings(ctx.group.id);
    expect(booking!.status).toBe("cancelled");
    expect(await ctx.store.getDecision(ctx.decision.id)).toMatchObject({ status: "decided" });
  });

  it("shows Claude the bookings so far", async () => {
    const ctx = await setup([
      ...call("booking_link", (b) => ({ option_id: idOf("Hartwood")(b), party_size: 6, starts_at_local: "2026-10-03T20:00" })),
      reply([text("Not booked yet.")]),
    ]);
    await ctx.say("will", "@Nod book Hartwood for 6 at 8pm Saturday");
    await ctx.say("mike", "@Nod is dinner booked?");
    const [booking] = await ctx.store.listBookings(ctx.group.id);
    expect(ctx.requests[2].messages[0].content).toContain(
      `<bookings>\n[booking ${booking!.id}] Hartwood · Sat, Oct 3, 8:00 PM · 6 people · link sent, not booked yet\n</bookings>`,
    );
  });
});
