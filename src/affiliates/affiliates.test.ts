import { describe, expect, it } from "vitest";
import { activePrograms, affiliateLink } from "./affiliates";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("affiliateLink", () => {
  it("leaves links alone when no program is set up", () => {
    expect(affiliateLink("https://www.booking.com/hotel/us/x.html?checkin=2026-10-09", env({}))).toBe("https://www.booking.com/hotel/us/x.html?checkin=2026-10-09");
  });

  it("adds the program's tag to its own links, keeping what's already there", () => {
    const e = env({ NOD_AFFILIATE_BOOKING: "123456" });
    expect(affiliateLink("https://www.booking.com/hotel/us/x.html?checkin=2026-10-09", e)).toBe("https://www.booking.com/hotel/us/x.html?checkin=2026-10-09&aid=123456");
    expect(affiliateLink("https://www.booking.com/hotel/us/x.html?aid=999", e)).toBe("https://www.booking.com/hotel/us/x.html?aid=999"); // someone else's tag stays
    expect(affiliateLink("https://www.viator.com/tours/x", env({ NOD_AFFILIATE_VIATOR: "P0001" }))).toBe("https://www.viator.com/tours/x?pid=P0001");
  });

  it("wraps links for programs that track through a network link ({url} in the setting)", () => {
    const e = env({ NOD_AFFILIATE_EXPEDIA: "https://example.pxf.io/c/1/2/3?u={url}" });
    expect(affiliateLink("https://www.vrbo.com/12345?startDate=2026-10-09", e)).toBe(
      `https://example.pxf.io/c/1/2/3?u=${encodeURIComponent("https://www.vrbo.com/12345?startDate=2026-10-09")}`,
    );
  });

  it("never changes links for other sites, or produces anything but a web link", () => {
    const e = env({ NOD_AFFILIATE_BOOKING: "123456", NOD_AFFILIATE_STUBHUB: "javascript:alert(1)//{url}" });
    expect(affiliateLink("https://www.airbnb.com/rooms/1", e)).toBe("https://www.airbnb.com/rooms/1");
    expect(affiliateLink("https://notbooking.com/x", e)).toBe("https://notbooking.com/x");
    expect(affiliateLink("https://www.stubhub.com/event/1", e)).toBe("https://www.stubhub.com/event/1");
    expect(affiliateLink("not a url", e)).toBe("not a url");
  });

  it("lists the programs that are switched on", () => {
    expect(activePrograms(env({ NOD_AFFILIATE_BOOKING: "1", NOD_AFFILIATE_VIATOR: " " }))).toEqual(["Booking.com"]);
  });
});

describe("broader affiliate links", () => {
  const skim = "https://go.skimresources.com/?id=123X456&xs=1&url={url}&xcust={sub}";

  it("sends every other shop or travel site through the catch-all network, with the anonymous label", () => {
    const e = env({ NOD_AFFILIATE_FALLBACK: skim });
    expect(affiliateLink("https://www.agoda.com/hotel/1", e, { sub: "card-abc123" })).toBe(
      `https://go.skimresources.com/?id=123X456&xs=1&url=${encodeURIComponent("https://www.agoda.com/hotel/1")}&xcust=card-abc123`,
    );
  });

  it("uses a direct program first, and the network for a known program that isn't set up yet", () => {
    const e = env({ NOD_AFFILIATE_FALLBACK: skim, NOD_AFFILIATE_BOOKING: "123456" });
    expect(affiliateLink("https://www.booking.com/hotel/x.html", e, { sub: "card-1" })).toBe("https://www.booking.com/hotel/x.html?aid=123456&label=card-1");
    expect(affiliateLink("https://www.viator.com/tours/x", e)).toMatch(/^https:\/\/go\.skimresources\.com\/\?id=123X456&xs=1&url=https%3A%2F%2Fwww\.viator\.com/);
  });

  it("never wraps Nod's own links, maps, search or money apps", () => {
    const e = env({ NOD_AFFILIATE_FALLBACK: skim, NOD_APP_URL: "https://app.nod.test" });
    for (const u of ["https://app.nod.test/o/abc", "https://www.google.com/search?q=x", "https://maps.apple.com/?q=x", "https://venmo.com/?txn=pay"]) {
      expect(affiliateLink(u, e)).toBe(u);
    }
  });

  it("takes extra programs as a setting, ahead of the built-in list, and skips bad entries", () => {
    const e = env({
      NOD_AFFILIATE_EXTRA: JSON.stringify([
        { name: "Agoda", domains: ["agoda.com"], tag: "1234", param: "cid" },
        { name: "Klook", domains: ["klook.com"], link: "https://track.example/k?u={url}&s={sub}" },
        { name: "Broken", domains: ["not a domain"], tag: "x", param: "y" },
        { name: "Booking override", domains: ["booking.com"], tag: "999", param: "aid", subParam: "label" },
      ]),
    });
    expect(affiliateLink("https://www.agoda.com/h/1", e)).toBe("https://www.agoda.com/h/1?cid=1234");
    expect(affiliateLink("https://www.klook.com/a/1", e, { sub: "search" })).toBe(`https://track.example/k?u=${encodeURIComponent("https://www.klook.com/a/1")}&s=search`);
    expect(affiliateLink("https://www.booking.com/h.html", e, { sub: "card-2" })).toBe("https://www.booking.com/h.html?aid=999&label=card-2");
    expect(activePrograms(e)).toEqual(["Agoda", "Klook", "Booking override"]);
  });

  it("drops a label that isn't a plain id, and survives a broken setting", () => {
    expect(affiliateLink("https://www.booking.com/h.html", env({ NOD_AFFILIATE_BOOKING: "1" }), { sub: "will@example.com" })).toBe("https://www.booking.com/h.html?aid=1");
    expect(affiliateLink("https://www.agoda.com/h", env({ NOD_AFFILIATE_EXTRA: "{not json" }))).toBe("https://www.agoda.com/h");
    expect(activePrograms(env({ NOD_AFFILIATE_FALLBACK: skim }))).toEqual(["catch-all network"]);
  });
});
