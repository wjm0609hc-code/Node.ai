import { describe, expect, it, vi } from "vitest";
import { createResponder, type AgentClient } from "../agent/responder";
import { buildIcs } from "../booking/ics";
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
const call = (name: string, input: Record<string, unknown> | ((body: any) => Record<string, unknown>), after = "Done."): Scripted[] => [
  (body) => reply([toolUse("t", name, typeof input === "function" ? input(body) : input)], "tool_use"),
  reply(after ? [text(after)] : []),
];
const eventIdIn = (body: any) => /\[event ([^\]]+)\]/.exec(String(body.messages[0].content))![1]!;
const dinner = (extra: Record<string, unknown> = {}) =>
  call("create_calendar_event", { title: "Dinner at Hartwood", starts_at_local: "2026-10-03T20:00", location: "Carretera Tulum km 7.6", ...extra }, "Added to the calendar.");

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
    config: { howToVideoUrl: "https://nod.test/v.mp4", appUrl: "https://nod.test", timezone: "America/New_York" },
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
  const say = async (who: keyof typeof s.users, message: string) => {
    world.say(s.users[who].id, s.groupId, message, { mentionNod: message.includes("@Nod") });
    await world.settled();
  };
  const nodLines = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1);
  const events = () => store.listEvents(group.id);
  const lastToolResult = () => {
    const msgs = requests.at(-1).messages;
    return msgs[msgs.length - 1].content[0].content as string;
  };
  const advanceTo = async (iso: string) => {
    clock = new Date(iso);
    await scheduler.runDue(clock, nod.runJob);
    await world.settled();
  };
  return { world, store, scheduler, s, group, say, nodLines, events, lastToolResult, advanceTo, requests };
}

describe("create_calendar_event", () => {
  it("makes a timed event (2 hours by default) and attaches its invite to Nod's one reply", async () => {
    const ctx = await setup(dinner());
    await ctx.say("will", "@Nod add Saturday's dinner at Hartwood at 8 to the calendar");
    const [e] = await ctx.events();
    expect(e).toMatchObject({ title: "Dinner at Hartwood", allDay: false, location: "Carretera Tulum km 7.6", sequence: 0, status: "confirmed", reminderAt: null });
    expect(e!.startsAt.toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(e!.endsAt.toISOString()).toBe("2026-10-04T02:00:00.000Z");
    expect(ctx.nodLines().map((l) => [l.text, l.mediaUrls])).toEqual([["Added to the calendar.", [`https://nod.test/e/${e!.id}.ics`]]]);
    expect(JSON.parse(ctx.lastToolResult())).toMatchObject({ when: "Sat, Oct 3, 8:00 PM" });
    expect(buildIcs(e!)).toContain("TRIGGER:-PT2H");
  });

  it("makes an all-day event covering every day through end_date", async () => {
    const ctx = await setup(call("create_calendar_event", { title: "Tulum trip", date: "2027-03-14", end_date: "2027-03-18" }));
    await ctx.say("will", "@Nod put the trip on everyone's calendar");
    const [e] = await ctx.events();
    expect(e).toMatchObject({ allDay: true });
    expect(e!.endsAt.toISOString()).toBe("2027-03-19T00:00:00.000Z"); // .ics all-day ends are exclusive
    expect(JSON.parse(ctx.lastToolResult()).when).toBe("Mar 14–18");
  });

  it.each([
    [{ title: "X", starts_at_local: "2026-09-01T20:00" }, /already passed/],
    [{ title: "X", date: "2026-09-01" }, /already passed/],
    [{ title: "X", date: "2027-03-14", starts_at_local: "2027-03-14T20:00" }, /not both/],
    [{ title: "X" }, /When is it/],
    [{ title: "X", starts_at_local: "2026-10-03T20:00", ends_at_local: "2026-10-03T19:00" }, /after the start/],
    [{ title: "X", date: "2027-03-14", end_date: "2027-03-10" }, /on or after date/],
  ])("refuses %j", async (input, error) => {
    const ctx = await setup(call("create_calendar_event", input, "Can't."));
    await ctx.say("will", "@Nod add it");
    expect(ctx.lastToolResult()).toMatch(error);
    expect(await ctx.events()).toEqual([]);
  });

  it("only works in the group chat", async () => {
    const ctx = await setup([reply([text("Hi.")]), ...call("create_calendar_event", { title: "X", starts_at_local: "2026-10-03T20:00" }, "Ask in the group.")]);
    ctx.world.dm(ctx.s.users.will.id, "hi");
    await ctx.world.settled();
    ctx.world.dm(ctx.s.users.will.id, "add dinner to my calendar");
    await ctx.world.settled();
    expect(ctx.lastToolResult()).toMatch(/for the group chat/);
  });
});

describe("group reminders", () => {
  it("posts a reminder 3 hours before, only when asked, and only once", async () => {
    const ctx = await setup(dinner({ remind_group: true }));
    await ctx.say("will", "@Nod add dinner Saturday at 8 and remind us");
    const [e] = await ctx.events();
    expect(e!.reminderAt!.toISOString()).toBe("2026-10-03T21:00:00.000Z");
    expect(JSON.parse(ctx.lastToolResult()).group_reminder).toBe("Sat, Oct 3, 5:00 PM");
    await ctx.advanceTo("2026-10-03T21:00:00Z");
    expect(ctx.nodLines().at(-1)!.text).toBe("Today: Dinner at Hartwood, 8:00 PM at Carretera Tulum km 7.6.");
    await ctx.scheduler.scheduleEventReminder({ eventId: e!.id, runAt: e!.reminderAt! });
    await ctx.advanceTo("2026-10-03T21:30:00Z");
    expect(ctx.nodLines().filter((l) => l.text.startsWith("Today:"))).toHaveLength(1);
  });

  it("reminds at 9 AM on the first day of an all-day event", async () => {
    const ctx = await setup(call("create_calendar_event", { title: "Tulum trip", date: "2026-10-10", end_date: "2026-10-12", remind_group: true }));
    await ctx.say("will", "@Nod add the trip and remind us");
    await ctx.advanceTo("2026-10-10T13:00:00Z");
    expect(ctx.nodLines().at(-1)!.text).toBe("Starting today: Tulum trip (Oct 10–12).");
  });

  it("never posts a reminder nobody asked for", async () => {
    const ctx = await setup(dinner());
    await ctx.say("will", "@Nod add dinner Saturday at 8");
    expect(ctx.scheduler.pending()).toEqual([]);
  });
});

describe("updating and cancelling", () => {
  it("sends an updated invite with the same event and a higher sequence, and moves the reminder", async () => {
    const ctx = await setup([...dinner({ remind_group: true }), ...call("update_calendar_event", (b) => ({ event_id: eventIdIn(b), starts_at_local: "2026-10-03T21:00" }), "Moved to 9.")]);
    await ctx.say("will", "@Nod add dinner Saturday at 8 and remind us");
    await ctx.say("sarah", "@Nod dinner moved to 9");
    const [e] = await ctx.events();
    expect(e).toMatchObject({ sequence: 1 });
    expect(e!.startsAt.toISOString()).toBe("2026-10-04T01:00:00.000Z");
    expect(ctx.nodLines().at(-1)!.mediaUrls).toEqual([`https://nod.test/e/${e!.id}.ics`]);
    expect(buildIcs(e!)).toContain("SEQUENCE:1");
    // The old reminder time does nothing; the new one posts.
    await ctx.advanceTo("2026-10-03T21:00:00Z");
    expect(ctx.nodLines().some((l) => l.text.startsWith("Today:"))).toBe(false);
    await ctx.advanceTo("2026-10-03T22:00:00Z");
    expect(ctx.nodLines().at(-1)!.text).toBe("Today: Dinner at Hartwood, 9:00 PM at Carretera Tulum km 7.6.");
  });

  it("cancels an event with a cancellation invite, and its reminder never posts", async () => {
    const ctx = await setup([...dinner({ remind_group: true }), ...call("cancel_calendar_event", (b) => ({ event_id: eventIdIn(b) }), "Cancelled.")]);
    await ctx.say("will", "@Nod add dinner Saturday at 8 and remind us");
    await ctx.say("will", "@Nod dinner's off");
    const [e] = await ctx.events();
    expect(e).toMatchObject({ status: "cancelled", sequence: 1 });
    expect(buildIcs(e!)).toContain("METHOD:CANCEL");
    expect(ctx.nodLines().at(-1)!.mediaUrls).toEqual([`https://nod.test/e/${e!.id}.ics`]);
    await ctx.advanceTo("2026-10-03T21:00:00Z");
    expect(ctx.nodLines().some((l) => l.text.startsWith("Today:"))).toBe(false);
  });

  it("lists upcoming events for Claude, leaving out cancelled ones", async () => {
    const ctx = await setup([
      ...dinner({ remind_group: true }),
      ...call("create_calendar_event", { title: "Boat day", date: "2026-10-05" }),
      ...call("cancel_calendar_event", (b) => ({ event_id: /\[event ([^\]]+)\] Boat day/.exec(String(b.messages[0].content))![1] }), "Cancelled."),
      reply([text("ok")]),
    ]);
    await ctx.say("will", "@Nod add dinner Saturday at 8 and remind us");
    await ctx.say("will", "@Nod add boat day Monday");
    await ctx.say("will", "@Nod cancel boat day");
    await ctx.say("will", "@Nod what's coming up?");
    const context = String(ctx.requests.at(-1).messages[0].content);
    expect(context).toMatch(/Dinner at Hartwood · Sat, Oct 3, 8:00 PM · Carretera Tulum km 7\.6 · group reminder on/);
    expect(context).not.toMatch(/Boat day/);
  });
});

describe("bookings", () => {
  it("cancelling a booking cancels its invite, and the invite can't be cancelled on its own while the booking stands", async () => {
    const responses: Scripted[] = [];
    const ctx = await setup(responses);
    const { option } = await ctx.store.upsertOption({ groupId: ctx.group.id, kind: "restaurant", source: "search", url: "https://hartwood.test/", postedByUserId: null, providerMessageId: null });
    await ctx.store.updateOptionParsed(option.id, { title: "Hartwood" });
    const booking = await ctx.store.createBooking({
      groupId: ctx.group.id, optionId: option.id, decisionId: null, requestedByUserId: null, partySize: 6,
      startsAt: new Date("2026-10-04T00:00:00Z"), endsAt: new Date("2026-10-04T02:00:00Z"), allDay: false, link: "https://hartwood.test/", method: "link",
    });
    await ctx.store.updateBooking(booking.id, { status: "booked" });
    const event = await ctx.store.createEvent({
      groupId: ctx.group.id, bookingId: booking.id, title: "Hartwood, 6 people", startsAt: booking.startsAt!, endsAt: booking.endsAt!, allDay: false, location: null, description: null,
    });

    responses.push(...call("cancel_calendar_event", { event_id: event.id }, "Use the booking."));
    await ctx.say("will", "@Nod take dinner off the calendar");
    expect(ctx.lastToolResult()).toMatch(/cancel the booking with cancel_booking/);
    expect((await ctx.store.getEvent(event.id))?.status).toBe("confirmed");

    responses.push(...call("cancel_booking", { booking_id: booking.id }, "Cancelled."));
    await ctx.say("will", "@Nod we cancelled Hartwood");
    expect(ctx.lastToolResult()).toBe("Marked the Hartwood booking cancelled. The calendar cancellation is attached; tapping it removes the event.");
    expect(await ctx.store.getEvent(event.id)).toMatchObject({ status: "cancelled", sequence: 1 });
    expect(ctx.nodLines().at(-1)!.mediaUrls).toEqual([`https://nod.test/e/${event.id}.ics`]);
  });
});
