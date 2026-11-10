import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../agent/tools";
import { MemoryStore } from "../db/memory-store";
import { silentLogger } from "../lib/log";
import { createHistory, groupHistory, matches, queryWords } from "./history";

const TZ = "America/New_York";
let clock: Date;
let store: MemoryStore;
let groupId: string;
let will: string;
let sarah: string;

const at = (iso: string) => {
  clock = new Date(iso);
};

async function option(title: string, over: { kind?: "restaurant" | "rental" | "activity"; source?: "search" | "link"; area?: string; by?: string } = {}) {
  const { option } = await store.upsertOption({ groupId, kind: over.kind ?? "restaurant", source: over.source ?? "search", url: `https://${title.toLowerCase().replace(/\W+/g, "")}.test/`, postedByUserId: over.by ?? null, providerMessageId: null });
  await store.updateOptionParsed(option.id, { title, ...(over.area ? { area: over.area } : {}) });
  return option.id;
}

beforeEach(async () => {
  clock = new Date("2026-03-01T15:00:00Z");
  store = new MemoryStore({ now: () => clock });
  const { group } = await store.upsertGroup({ provider: "test", providerGroupId: "g", name: "Friends" });
  groupId = group.id;
  will = (await store.upsertUser("+15550100001")).id;
  sarah = (await store.upsertUser("+15550100002")).id;
  await store.setUserName(will, "Will");
  await store.setUserName(sarah, "Sarah");
  await store.addMembers(groupId, [will, sarah]);
});

async function seed() {
  // March: a taco search, a vote, a booking, an expense.
  at("2026-03-05T22:00:00Z");
  const tacos = await option("Los Tacos No. 1", { area: "Chelsea" });
  await option("Taqueria Diana", { area: "East Village" });
  const lupa = await option("Lupa", { area: "West Village" });
  const vote = await store.createDecision({ groupId, kind: "vote", question: "Dinner Saturday?", createdByUserId: will, deadlineAt: null, round: 1, parentDecisionId: null, optionIds: [tacos, lupa] });
  at("2026-03-06T14:00:00Z");
  await store.updateDecision(vote.id, { status: "decided", winningOptionId: lupa });
  const b = await store.createBooking({ groupId, optionId: lupa, decisionId: vote.id, requestedByUserId: will, partySize: 5, startsAt: new Date("2026-03-08T00:00:00Z"), endsAt: null, allDay: false, link: null, method: "link" });
  await store.updateBooking(b.id, { status: "booked" });
  at("2026-03-08T03:00:00Z");
  await store.createLedgerEntry({ groupId, payerUserId: sarah, amountCents: 31250, currency: "USD", description: "Lupa dinner", kind: "expense", source: "receipt", sourceId: null, receiptId: null, createdByUserId: sarah, shares: [{ userId: will, amountCents: 15625 }, { userId: sarah, amountCents: 15625 }] });
  // May: a rental someone shared and a standalone event; a cancelled booking that shouldn't show.
  at("2026-05-02T16:00:00Z");
  const casa = await option("Casa Azul", { kind: "rental", source: "link", by: will });
  const c = await store.createBooking({ groupId, optionId: casa, decisionId: null, requestedByUserId: will, partySize: 6, startsAt: null, endsAt: null, allDay: true, link: null, method: "link" });
  await store.updateBooking(c.id, { status: "cancelled" });
  await store.createEvent({ groupId, bookingId: null, title: "Knicks game", startsAt: new Date("2026-05-10T23:30:00Z"), endsAt: new Date("2026-05-11T02:00:00Z"), allDay: false, location: "MSG", description: null });
  return { tacos, lupa, casa };
}

const ctx = (): ToolContext => ({ store, provider: {} as never, logger: silentLogger, chat: { kind: "group", groupId, providerGroupId: "g", name: "Friends" }, caller: { userId: will, name: "Will", phone: "+15550100001" }, members: [] });

describe("group history", () => {
  it("lists bookings, events, votes, expenses and places, newest first, in local time", async () => {
    const { lupa } = await seed();
    at("2026-06-01T12:00:00Z");
    const items = await groupHistory(store, groupId, TZ, clock);
    expect(items.map((i) => i.kind)).toEqual(["event", "place", "expense", "booking", "vote", "place", "place"]);
    expect(items.find((i) => i.kind === "booking")).toMatchObject({ text: "Booked Lupa (West Village) for 5, Mar 7, 7:00 PM", optionId: lupa });
    expect(items.find((i) => i.kind === "vote")?.text).toBe("Voted on “Dinner Saturday?”: Lupa won");
    expect(items.find((i) => i.kind === "expense")?.text).toBe("Lupa dinner: $312.50, paid by Sarah");
    expect(items[0]!.text).toBe("Knicks game, May 10, 7:30 PM, MSG");
    expect(items.map((i) => i.text)).toContain("Will shared Casa Azul, a rental");
    // Lupa appears as the vote and the booking, not again as a found place; the cancelled booking isn't a plan.
    expect(items.filter((i) => i.text.includes("Nod found Lupa"))).toEqual([]);
    expect(items.filter((i) => i.kind === "booking")).toHaveLength(1);
  });

  it("matches question words, ignoring filler and plurals", () => {
    expect(queryWords("where was that taco place from last time?")).toEqual(["taco"]);
    expect(matches({ at: clock, kind: "place", text: "Nod found Los Tacos No. 1 (Chelsea), restaurant" }, ["tacos"])).toBe(true);
    expect(matches({ at: clock, kind: "place", text: "Nod found Lupa" }, ["tacos"])).toBe(false);
    expect(matches({ at: clock, kind: "place", text: "Nod found Café Lalo" }, queryWords("cafe"))).toBe(true);
  });
});

describe("recall_group_history", () => {
  const recall = () => createHistory({ store, defaultTimezone: TZ, now: () => clock }).tools[0]!;

  it("finds the taco place from March, with its option id to show it again", async () => {
    const { tacos } = await seed();
    at("2026-06-01T12:00:00Z");
    const res = (await recall().run({ query: "the taco place", after: "2026-03-01", before: "2026-03-31" }, ctx())) as { found: number; items: string[] };
    expect(res.found).toBe(1); // "Taqueria Diana" has no "taco" in it: words match, meanings don't (Claude can try "taqueria" too).
    expect(res.items).toContain(`[Mar 5] Nod found Los Tacos No. 1 (Chelsea), restaurant (option ${tacos})`);
  });

  it("narrows by kind and says when nothing matches", async () => {
    await seed();
    at("2026-06-01T12:00:00Z");
    const bookings = (await recall().run({ kinds: ["booking"] }, ctx())) as { items: string[] };
    expect(bookings.items).toHaveLength(1);
    expect(await recall().run({ query: "sushi" }, ctx())).toMatchObject({ found: 0 });
    await expect(recall().run({ after: "March" }, ctx())).rejects.toThrow(/YYYY-MM-DD/);
    await expect(recall().run({}, { ...ctx(), chat: { kind: "private" } })).rejects.toThrow(/group chat/);
  });

  it("adds the latest plans to Claude's context, and nothing for a new group", async () => {
    const h = createHistory({ store, defaultTimezone: TZ, now: () => clock });
    const call = { groupId, senderUserId: will } as never;
    expect(await h.section(call)).toBeNull();
    await seed();
    at("2026-06-01T12:00:00Z");
    const s = await h.section(call);
    expect(s?.title).toBe("past_plans");
    expect(s?.body.split("\n")).toEqual([
      "[May 10] Knicks game, May 10, 7:30 PM, MSG",
      expect.stringMatching(/^\[Mar 7\] Booked Lupa \(West Village\) for 5, Mar 7, 7:00 PM \(option .+\)$/),
      expect.stringMatching(/^\[Mar 6\] Voted on “Dinner Saturday\?”: Lupa won \(option .+\)$/),
      "For anything older, other places or the tab's history, use recall_group_history.",
    ]);
  });

  it("survives forgetting the chat (it's built from plans and the tab, not messages)", async () => {
    await seed();
    at("2026-06-01T12:00:00Z");
    await store.forgetGroup(groupId);
    expect((await groupHistory(store, groupId, TZ, clock)).length).toBeGreaterThan(0);
  });
});
