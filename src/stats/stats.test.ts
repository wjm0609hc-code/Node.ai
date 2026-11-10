import { describe, expect, it } from "vitest";
import { recordTap } from "../cards/page";
import { MemoryStore } from "../db/memory-store";
import type { CardWithTaps, UsageStats } from "../db/store";
import { renderStatsPage } from "./page";
import { createStatsRoute } from "./route";
import { category, linkType, site, summarize } from "./stats";

const APP = "https://get-nod.app";
let seq = 0;
function card(over: Partial<CardWithTaps> & { data?: Record<string, unknown> }): CardWithTaps {
  seq++;
  return { id: `c${seq}`, groupId: "g1", data: { title: `Place ${seq}` }, photoUrl: null, pageUrl: null, targetUrl: "https://bar.test/", createdAt: new Date("2026-11-01T12:00:00Z"), taps: 0, earlyTaps: 0, ...over };
}
const usage = (cards: CardWithTaps[], over: Partial<UsageStats> = {}): UsageStats => ({ cards, searches: 0, searchGroupIds: [], votesDecided: 0, bookingsConfirmed: 0, ...over });
const since = new Date("2026-10-30T00:00:00Z");

describe("what kind of link a card is", () => {
  it("reads the booking label, votes, pay links, invites, rentals and plain venue pages", () => {
    expect(linkType(card({ data: { linkLabel: "Book on Resy", via: "pick" } }), APP)).toBe("Book on Resy");
    expect(linkType(card({ data: { linkLabel: "Directions" } }), APP)).toBe("Directions");
    expect(linkType(card({ data: { via: "vote", linkLabel: "Website" } }), APP)).toBe("Vote option");
    expect(linkType(card({ data: { footer: "Tap 👍 to vote" } }), APP)).toBe("Vote option"); // older cards
    expect(linkType(card({ data: { kind: "pay" }, targetUrl: `${APP}/pay/x` }), APP)).toBe("Pay link");
    expect(linkType(card({ data: {}, targetUrl: `${APP}/e/abc.ics` }), APP)).toBe("Calendar invite");
    expect(linkType(card({ data: { kind: "rental" }, targetUrl: "https://airbnb.com/rooms/1" }), APP)).toBe("Rental listing");
    expect(linkType(card({ data: { via: "booking" } }), APP)).toBe("Booking link");
    expect(linkType(card({ data: { kind: "activity" } }), APP)).toBe("Venue page");
  });

  it("names categories and sites, with Nod's own pages as Nod", () => {
    expect(category(card({ data: { kind: "restaurant" } }))).toBe("Restaurants and bars");
    expect(category(card({ data: {} }))).toBe("Not recorded (older cards)");
    expect(site(card({ targetUrl: "https://resy.com/x" }), APP)).toBe("Resy");
    expect(site(card({ targetUrl: `${APP}/pay/t` }), APP)).toBe("Nod");
    expect(site(card({ targetUrl: "https://maps.apple.com/?q=Bemelmans" }), APP)).toBe("Apple Maps");
  });
});

describe("the stats figures", () => {
  it("counts cards sent, opened and tapped, and leaves preview hits out", () => {
    const s = summarize(
      usage(
        [
          card({ taps: 3, earlyTaps: 1, data: { kind: "restaurant", via: "pick", number: 1, linkLabel: "Book on Resy", title: "Lupa" }, targetUrl: "https://resy.com/lupa" }),
          card({ taps: 0, earlyTaps: 1, data: { kind: "restaurant", via: "pick", number: 2, linkLabel: "Website", title: "Via Carota" } }),
          card({ taps: 1, groupId: "g2", data: { kind: "restaurant", via: "pick", number: 7, linkLabel: "Directions", title: "Bemelmans" } }),
          card({ taps: 0, groupId: null, data: { kind: "pay" }, targetUrl: `${APP}/pay/t` }),
        ],
        { searches: 2, searchGroupIds: ["g1", "g3"], votesDecided: 1, bookingsConfirmed: 1 },
      ),
      { days: 7, since, appUrl: APP, env: {} },
    );
    expect(s).toMatchObject({ cardsSent: 4, cardsTapped: 2, taps: 4, tapRate: 0.5, earlyTaps: 2, groups: 3 });
    expect(s.funnel).toEqual([
      { label: "Searches", value: 2 },
      { label: "Picks sent", value: 3 },
      { label: "Picks tapped", value: 2 },
      { label: "Votes decided", value: 1 },
      { label: "Bookings confirmed", value: 1 },
    ]);
    expect(s.byLinkType[0]).toEqual({ label: "Book on Resy", sent: 1, tapped: 1, taps: 3, rate: 1 });
    expect(s.byPosition.map((r) => r.label)).toEqual(["#1", "#2", "#7"]);
    expect(s.topPlaces.map((r) => r.label)).toEqual(["Lupa", "Bemelmans"]);
    expect(s.byCategory.find((r) => r.label === "Payments")).toMatchObject({ sent: 1, tapped: 0 });
  });

  it("says whether an affiliate program covers each site and is set up", () => {
    const cards = [card({ taps: 2, targetUrl: "https://www.opentable.com/r/x" }), card({ taps: 1, targetUrl: "https://booking.com/hotel/y" }), card({ taps: 1, targetUrl: "https://bar.test/" })];
    const s = summarize(usage(cards), { days: 7, since, env: { NOD_AFFILIATE_BOOKING: "123456" } });
    expect(s.bySite.find((r) => r.label === "OpenTable")?.program).toEqual({ name: "OpenTable", on: false });
    expect(s.bySite.find((r) => r.label === "Booking.com")?.program).toEqual({ name: "Booking.com", on: true });
    expect(s.bySite.find((r) => r.label === "bar.test")?.program).toBeUndefined();
  });

  it("is empty but valid with nothing sent", () => {
    const s = summarize(usage([]), { days: 30, since, env: {} });
    expect(s).toMatchObject({ cardsSent: 0, tapRate: 0, groups: 0, truncated: false });
    expect(renderStatsPage(s, { token: "t" })).toContain("Nothing yet.");
  });
});

describe("the stats page", () => {
  const TOKEN = "s3cret-token-0123456789";
  const route = (env: NodeJS.ProcessEnv, store = new MemoryStore()) => createStatsRoute({ store: async () => store, env, appUrl: APP, now: () => new Date("2026-11-06T12:00:00Z") });

  it("is a plain 404 without the right token", async () => {
    expect((await route({ HEALTH_TOKEN: TOKEN })(new Request(`${APP}/admin/stats`))).status).toBe(404);
    expect((await route({ HEALTH_TOKEN: TOKEN })(new Request(`${APP}/admin/stats?token=wrong-token-0123456789`))).status).toBe(404);
    expect((await route({ HEALTH_TOKEN: "short" })(new Request(`${APP}/admin/stats?token=short`))).status).toBe(404); // too short to trust
  });

  it("opens with the stats token, or the health token when there's none, and escapes what it shows", async () => {
    const store = new MemoryStore({ now: () => new Date("2026-11-05T12:00:00Z") });
    await store.createCard({ id: "abc123", groupId: null, data: { title: "<b>Bar</b>", kind: "restaurant" }, targetUrl: "https://bar.test/" });
    await store.recordCardTap({ cardId: "abc123", groupId: null, early: false });
    const res = await route({ NOD_STATS_TOKEN: TOKEN, HEALTH_TOKEN: "other-token-0123456789" }, store)(new Request(`${APP}/admin/stats?token=${TOKEN}&days=30`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Last 30 days");
    expect(html).toContain("&lt;b&gt;Bar&lt;/b&gt;");
    expect(html).not.toContain("<b>Bar</b>");
    expect((await route({ HEALTH_TOKEN: TOKEN })(new Request(`${APP}/admin/stats`, { headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(200);
  });
});

describe("counting a tap", () => {
  it("marks hits right after the card is made as early, and never throws", async () => {
    const store = new MemoryStore({ now: () => new Date("2026-11-05T12:00:00Z") });
    const row = await store.createCard({ id: "xyz789", groupId: null, data: { title: "Bar" }, targetUrl: "https://bar.test/" });
    await recordTap(store, row, new Date(row.createdAt.getTime() + 5_000));
    await recordTap(store, row, new Date(row.createdAt.getTime() + 60_000));
    const u = await store.usageSince(new Date("2026-11-01T00:00:00Z"));
    expect(u.cards[0]).toMatchObject({ taps: 1, earlyTaps: 1 });
    await expect(recordTap({ recordCardTap: async () => Promise.reject(new Error("db down")) }, row)).resolves.toBeUndefined();
  });
});
