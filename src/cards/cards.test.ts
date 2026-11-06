import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../db/memory-store";
import type { Option } from "../db/store";
import { silentLogger } from "../lib/log";
import { cardContent, createCards, linkFor, newCardId, safeTarget, sheetContent } from "./cards";
import { cardImage } from "./image";
import { isPreviewFetcher, renderCardPage, cardDestination } from "./page";
import { renderCard, renderSheet } from "./render";
import { cardForOption, sourceName } from "./spec";

const option = (over: Partial<Option>): Option =>
  ({ id: "o1", groupId: "g1", kind: "rental", source: "link", url: "https://www.airbnb.com/rooms/111", parsed: {}, postedByUserId: null, providerMessageId: null, seq: 1, createdAt: new Date(), updatedAt: new Date(), ...over }) as Option;

describe("what goes on a card", () => {
  it("names the source from the link", () => {
    expect(sourceName("https://resy.com/cities/tulum/venues/hartwood")).toBe("Resy");
    expect(sourceName("https://www.ticketmaster.com/event/123")).toBe("Ticketmaster");
    expect(sourceName("https://www.hartwoodtulum.com/")).toBe("hartwoodtulum.com");
    expect(sourceName("not a link")).toBe("Link");
  });

  it("shows a rental's site, name, nightly price, size and rating, with its photo", () => {
    const spec = cardForOption(
      option({ parsed: { title: "Casa Azul", site: "Airbnb", photoUrl: "https://img.test/casa.jpg", price: { amountCents: 31000, currency: "USD", per: "night" }, sleeps: 8, bedrooms: 3, rating: 4.92, location: "Tulum" } }),
      { number: 1 },
    );
    expect(spec).toEqual({
      data: { number: 1, source: "Airbnb", title: "Casa Azul", price: "$310/night", details: "Sleeps 8 · 3 bedrooms · ★ 4.92", footer: "Tulum" },
      photoUrl: "https://img.test/casa.jpg",
      targetUrl: "https://www.airbnb.com/rooms/111",
    });
  });

  it("shows a search pick's when and what, and finds its photo on its page", () => {
    const spec = cardForOption(option({ kind: "restaurant", source: "search", url: "https://resy.com/hartwood", parsed: { title: "Hartwood", summary: "Wood-fired, open air", when: "Wed–Sun from 6 PM", priceHint: "$$$" } }));
    expect(spec.data).toEqual({ source: "Resy", title: "Hartwood", price: "$$$", details: "Wed–Sun from 6 PM · Wood-fired, open air" });
    expect(spec.pageUrl).toBe("https://resy.com/hartwood");
    expect(spec.photoUrl).toBeUndefined();
  });

  it("lets a booking override the details, footer and destination", () => {
    const spec = cardForOption(option({ parsed: { title: "Casa Azul" } }), { details: "Mar 14 to Mar 18 · 6 guests", footer: "Tap to book", targetUrl: "https://www.airbnb.com/rooms/111?adults=6" });
    expect(spec.data).toMatchObject({ details: "Mar 14 to Mar 18 · 6 guests", footer: "Tap to book" });
    expect(spec.targetUrl).toBe("https://www.airbnb.com/rooms/111?adults=6");
  });
});

describe("card links", () => {
  it("makes short unguessable ids", () => {
    const ids = new Set(Array.from({ length: 200 }, newCardId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{12}$/);
  });

  it("saves the card and returns its link and picture", async () => {
    const store = new MemoryStore();
    const cards = createCards({ store, appUrl: "https://nod.test/", newId: () => "abcdefghijkm" });
    const link = await cards.make(null, { data: { source: "Resy", title: "Hartwood" }, pageUrl: "https://resy.com/h", targetUrl: "https://resy.com/h?seats=6" });
    expect(link).toEqual({ id: "abcdefghijkm", url: "https://nod.test/o/abcdefghijkm", imageUrl: "https://nod.test/o/abcdefghijkm/card.png", title: "Hartwood" });
    expect(await store.getCard("abcdefghijkm")).toMatchObject({ targetUrl: "https://resy.com/h?seats=6", pageUrl: "https://resy.com/h" });
  });

  it("only ever points at web pages", async () => {
    expect(safeTarget("javascript:alert(1)")).toBeUndefined();
    expect(safeTarget("https://resy.com/x")).toBe("https://resy.com/x");
    const cards = createCards({ store: new MemoryStore() });
    await expect(cards.make(null, { data: { source: "x", title: "x" }, targetUrl: "data:text/html,hi" })).rejects.toThrow(/http/);
  });

  it("goes out as its picture with the name and link as text (words around the link keep it from previewing twice)", () => {
    const link = linkFor("https://nod.test", "abcdefghijkm", "Hartwood");
    const msg = { text: "Hartwood: https://nod.test/o/abcdefghijkm", mediaUrls: ["https://nod.test/o/abcdefghijkm/card.png"] };
    expect(cardContent(link, "imessage")).toEqual(msg);
    expect(cardContent(link, "sms")).toEqual(msg);
    expect(cardContent(linkFor("https://nod.test", "abcdefghijkm", ""), null).text).toBe("Tap to open: https://nod.test/o/abcdefghijkm");
  });

  it("puts several cards in one picture and one text with a numbered link per pick", () => {
    const links = [
      linkFor("https://nod.test", "aaaaaaaaaaaa", "The Campbell"),
      linkFor("https://nod.test", "bbbbbbbbbbbb", "Ophelia", "Book on Resy"),
      linkFor("https://nod.test", "cccccccccccc", "Brandy Library", undefined, "Code NOD10: 10% off."),
    ];
    expect(sheetContent("https://nod.test/", "Drinks now, Midtown & Tribeca:", links)).toEqual({
      text: [
        "Drinks now, Midtown & Tribeca:",
        "1 The Campbell · https://nod.test/o/aaaaaaaaaaaa",
        "2 Ophelia · Book on Resy · https://nod.test/o/bbbbbbbbbbbb",
        "3 Brandy Library · https://nod.test/o/cccccccccccc (Code NOD10: 10% off)",
      ].join("\n"),
      mediaUrls: ["https://nod.test/o/s/aaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccc/sheet.png"],
    });
    expect(sheetContent("https://nod.test", "  ", links.slice(0, 2)).text).toBe("1 The Campbell · https://nod.test/o/aaaaaaaaaaaa\n2 Ophelia · Book on Resy · https://nod.test/o/bbbbbbbbbbbb");
  });

  it("puts at most 6 picks in the picture and up to 10 numbered links in the text", () => {
    const links = Array.from({ length: 8 }, (_, i) => linkFor("https://nod.test", String.fromCharCode(97 + i).repeat(12), `Place ${i + 1}`));
    const content = sheetContent("https://nod.test", "Bars:", links);
    expect(content.text!.split("\n")).toHaveLength(9);
    expect(content.mediaUrls![0]).toBe(`https://nod.test/o/s/${links.slice(0, 6).map((l) => l.id).join("-")}/sheet.png`);
  });

  it("draws several cards in one picture", async () => {
    const png = await renderSheet([
      { source: "Grand Central", title: "The Campbell", details: "Open till 2am" },
      { source: "Midtown East", title: "Ophelia", price: "Cocktails ~$23", details: "Rooftop · opens 5pm", linkLabel: "Book on Resy" },
    ]);
    expect([...png.slice(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
  });

});

describe("the page behind a card link", () => {
  const row = { id: "abcdefghijkm", groupId: null, data: { source: "Airbnb", title: `Casa "Azul" <villa>`, price: "$310/night", details: "Sleeps 8" }, photoUrl: null, pageUrl: null, targetUrl: "https://www.airbnb.com/rooms/111", createdAt: new Date() };

  it("gives link-preview fetchers the card as the preview picture", () => {
    const html = renderCardPage(row, "https://nod.test");
    expect(html).toContain('<meta property="og:image" content="https://nod.test/o/abcdefghijkm/card.png">');
    expect(html).toContain('<meta property="og:title" content="Casa &quot;Azul&quot; &lt;villa&gt;">');
    expect(html).toContain('<meta property="og:description" content="Airbnb · $310/night · Sleeps 8">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('href="https://www.airbnb.com/rooms/111"');
    expect(html).not.toContain("<villa>");
  });

  it("sends people to the destination with Nod's affiliate tag when its program is set up", () => {
    vi.stubEnv("NOD_AFFILIATE_BOOKING", "123456");
    try {
      const booking = { ...row, targetUrl: "https://www.booking.com/hotel/us/x.html" };
      expect(cardDestination(booking)).toBe("https://www.booking.com/hotel/us/x.html?aid=123456&label=card-abcdefghijkm");
      expect(renderCardPage(booking, "https://nod.test")).toContain('href="https://www.booking.com/hotel/us/x.html?aid=123456&amp;label=card-abcdefghijkm"');
      expect(cardDestination(row)).toBe("https://www.airbnb.com/rooms/111"); // no program for Airbnb
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("tells fetchers from people", () => {
    expect(isPreviewFetcher("facebookexternalhit/1.1 Facebot Twitterbot/1.0")).toBe(true);
    expect(isPreviewFetcher("Slackbot-LinkExpanding 1.0")).toBe(true);
    expect(isPreviewFetcher("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(isPreviewFetcher(null)).toBe(false);
  });
});

describe("drawing the card", () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47];
  const row = (over: object = {}) => ({ id: "c1", groupId: null, data: { source: "Resy", title: "Hartwood", price: "$$$" }, photoUrl: null, pageUrl: null, targetUrl: "https://resy.com/h", createdAt: new Date(), ...over });
  // A 1×1 PNG, standing in for a product photo.
  const tinyPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

  it("renders a PNG", async () => {
    const png = await renderCard({ number: 2, source: "Airbnb", title: "Casa Azul", price: "$310/night", details: "Sleeps 8 · ★ 4.9", footer: "Oct 9–12" });
    expect([...png.slice(0, 4)]).toEqual(PNG);
  }, 30_000);

  it("finds the photo on the card's page, remembers it, and draws it", async () => {
    const store = { setCardPhoto: vi.fn(async () => {}) };
    const fetchPage = vi.fn(async (url: string) => ({ url, text: `<html><head><meta property="og:image" content="https://img.test/h.png"></head></html>` }));
    const fetchImage = vi.fn(async (url: string) => ({ url, bytes: tinyPng, type: "image/png" }));
    const out = await cardImage(row({ pageUrl: "https://resy.com/h" }), { store, logger: silentLogger, fetchPage, fetchImage });
    expect(out.hasPhoto).toBe(true);
    expect(store.setCardPhoto).toHaveBeenCalledWith("c1", "https://img.test/h.png");
    expect(fetchImage).toHaveBeenCalledWith("https://img.test/h.png");
    expect([...out.png.slice(0, 4)]).toEqual(PNG);
  }, 30_000);

  it("converts a WebP photo (common on restaurant and review sites) so it can be drawn", async () => {
    const sharp = (await import("sharp")).default;
    const webp = new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 3, background: "#a33" } }).webp().toBuffer());
    const fetchImage = vi.fn(async (url: string) => ({ url, bytes: webp, type: "image/webp" }));
    const out = await cardImage(row({ photoUrl: "https://img.test/x.webp" }), { store: { setCardPhoto: vi.fn() }, logger: silentLogger, fetchImage });
    expect(out.hasPhoto).toBe(true);
    expect([...out.png.slice(0, 4)]).toEqual(PNG);
  }, 30_000);

  it("still draws the card (with its tile) when the photo can't be fetched", async () => {
    const fetchImage = vi.fn(async () => {
      throw new Error("blocked");
    });
    const out = await cardImage(row({ photoUrl: "https://img.test/x.jpg" }), { store: { setCardPhoto: vi.fn() }, logger: silentLogger, fetchImage });
    expect(out.hasPhoto).toBe(false);
    expect([...out.png.slice(0, 4)]).toEqual(PNG);
  }, 30_000);
});

describe("promo codes on cards", () => {
  it("adds the program's code to the card's text and its page, and keeps it when the card is sent later", async () => {
    vi.stubEnv("NOD_AFFILIATE_PROMOS", JSON.stringify([{ domains: ["seatgeek.com"], code: "NOD10", offer: "$10 off your first order" }]));
    try {
      const store = new MemoryStore();
      const cards = createCards({ store, appUrl: "https://nod.test", newId: () => "promoCardId12" });
      const link = await cards.make("g1", { targetUrl: "https://seatgeek.com/bruins", data: { title: "Bruins vs Rangers", source: "SeatGeek" } } as any);
      expect(cardContent(link).text).toBe("Bruins vs Rangers: https://nod.test/o/promoCardId12 · Code NOD10: $10 off your first order.");
      const row = (await store.getCard("promoCardId12"))!;
      expect(renderCardPage(row, "https://nod.test")).toContain("Code NOD10: $10 off your first order.");

      const plain = await createCards({ store, appUrl: "https://nod.test", newId: () => "plainCardId12" }).make("g1", { targetUrl: "https://stubhub.com/x", data: { title: "Other" } } as any);
      expect(cardContent(plain).text).toBe("Other: https://nod.test/o/plainCardId12");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("search picks on cards", () => {
  it("show the neighborhood instead of the site, and take the photo from the place's own page", () => {
    const spec = cardForOption({
      kind: "restaurant",
      url: "https://www.insidehook.com/x",
      parsed: { title: "Grand Central Oyster Bar", area: "Midtown East", photoPage: "https://www.oysterbarny.com/", bookingLink: "https://www.oysterbarny.com/", bookingLabel: "Website" },
    });
    expect(spec.data).toMatchObject({ source: "Midtown East", title: "Grand Central Oyster Bar", linkLabel: "Website" });
    expect(spec.pageUrl).toBe("https://www.oysterbarny.com/");
    expect(spec.targetUrl).toBe("https://www.oysterbarny.com/");
  });
});
